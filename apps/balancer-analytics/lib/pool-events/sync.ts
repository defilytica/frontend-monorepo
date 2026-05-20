/**
 * Tail-sync orchestrator for pool param events.
 *
 * On call (pool-page visit):
 *   1. TTL check — if synced within `SYNC_TTL_SECONDS`, return DB rows.
 *   2. Fetch pool metadata (type + protocolVersion + createTime) from api-v3
 *      with a small in-process cache (pool metadata is effectively static).
 *   3. Compute the scan range: warm → (watermark + 1) → (head - 12);
 *      cold → max(createBlock, head - 90d) → (head - 12).
 *   4. Two `eth_getLogs` calls:
 *      - Filter A (V3 only): Vault + FeeController + SurgeHook addresses,
 *        events with indexed `pool`, filtered via `args.pool = poolAddress`.
 *      - Filter B: pool's own contract, type-specific events (no indexed
 *        pool).
 *   5. Resolve unique block timestamps via `eth_getBlockByNumber`.
 *   6. Decode → `insertPoolParamEvents` (idempotent on UNIQUE).
 *   7. Upsert watermark.
 *   8. Return the full event timeline for the pool.
 *
 * In-flight dedupe per `(chain, pool)` so N concurrent requests collapse to
 * one RPC fan-out.
 */

import 'server-only'
import type { Address } from 'viem'
import { GqlChain } from '@repo/lib/shared/services/api/generated/graphql'
import {
  ensureSchema,
  countPoolParamEvents,
  getPoolParamEvents,
  getPoolSyncState,
  insertPoolParamEvents,
  upsertPoolSyncState,
  type PoolParamEventRow,
} from '@analytics/lib/db'
import { getPublicClient } from '@analytics/lib/drpc/client'
import { chunkedGetLogs } from '@analytics/lib/drpc/get-logs'
import { resolveBlockTimestamps } from '@analytics/lib/drpc/block-timestamps'
import { scrubError } from '@analytics/lib/drpc/scrub'
import { getV3HelperAddresses } from '@analytics/lib/contracts/v3-addresses'
import { V3_VAULT_ADDRESS } from '@analytics/lib/abis/v3-vault'
import {
  V3_FILTER_A_EVENTS,
  V3_STABLE_FILTER_B_EVENTS,
  V2_STABLE_FILTER_B_EVENTS,
  V2_NON_STABLE_FILTER_B_EVENTS,
} from './event-signatures'
import { decodeLogsToRows } from './decode'
import { ninetyDayFromBlock } from './initial-cap'
import type { PoolParamEvent } from './types'

const SYNC_TTL_SECONDS = 30
const REORG_CONFIRMATIONS = 12n
const POOL_METADATA_TTL_MS = 5 * 60 * 1000

const API_URL =
  process.env.NEXT_PUBLIC_BALANCER_API_URL ?? 'https://api-v3.balancer.fi/graphql'

/** In-flight dedupe so N concurrent requests for the same pool collapse to
 *  one RPC fan-out. */
const inflight = new Map<string, Promise<SyncResult>>()

/** Lazy + memoized schema bootstrap. The route handler also calls
 *  `ensureSchema` but the server-page entry path doesn't, so we need it
 *  here too. Shared promise so concurrent first-callers don't double-run
 *  the migration. */
let schemaPromise: Promise<void> | null = null
function ensureSchemaOnce(): Promise<void> {
  if (!schemaPromise) {
    schemaPromise = ensureSchema().catch(err => {
      // Reset on failure so the next call retries — better than wedging the
      // route in a permanently-broken state on a transient DB hiccup.
      schemaPromise = null
      throw err
    })
  }
  return schemaPromise
}

type PoolMetadata = {
  type: string
  protocolVersion: 1 | 2 | 3
  createTime: number | null
}

const metadataCache = new Map<string, { value: PoolMetadata; expiresAt: number }>()

export type SyncOptions = {
  ttlSeconds?: number
  force?: boolean
  /** Scan from the pool's (approx) deployment block instead of the 90-day
   *  cap. Implies a cold rescan (the warm watermark sits past the 90-day
   *  floor, so a tail-sync can never reach older history). ~150 RPC
   *  requests for a multi-year mainnet pool — negligible per §7. */
  fullHistory?: boolean
}

export type SyncResult = {
  events: PoolParamEvent[]
  lastBlock: number
  cached: boolean
  /** Surfaced for the page header so it can render "Stable", "Weighted", etc.
   *  Returned even when no events were found, to keep the response self-
   *  describing. */
  poolType: string | null
  protocolVersion: 1 | 2 | 3 | null
}

export async function syncPoolEvents(
  chain: GqlChain,
  poolAddress: string,
  options: SyncOptions = {}
): Promise<SyncResult> {
  const key = `${chain}:${poolAddress.toLowerCase()}`
  const existing = inflight.get(key)
  if (existing) return existing

  const promise = (async (): Promise<SyncResult> => {
    try {
      return await runSync(chain, poolAddress, options)
    } finally {
      inflight.delete(key)
    }
  })()
  inflight.set(key, promise)
  return promise
}

async function runSync(
  chain: GqlChain,
  poolAddress: string,
  options: SyncOptions
): Promise<SyncResult> {
  await ensureSchemaOnce()
  const ttl = options.ttlSeconds ?? SYNC_TTL_SECONDS
  const pool = poolAddress.toLowerCase()
  const state = await getPoolSyncState(chain, pool)

  // A `?fullHistory` request only needs the expensive deployment-block scan
  // the *first* time. Once `deep_synced` is latched, the DB already holds
  // the full timeline and every later full-history visit is served on the
  // normal warm path (fast). `force` still re-deep-scans on demand.
  const needDeepScan = options.fullHistory === true && state?.deepSynced !== true

  // ── TTL fast path ──
  // `force` and a *first* full-history request bypass the TTL. A
  // full-history request on an already-deep-synced pool does NOT — it falls
  // through to the cached/warm path so we don't re-walk the chain every
  // time someone opens a `?fullHistory` URL.
  if (!options.force && !needDeepScan && state) {
    const ageSeconds = (Date.now() - state.lastSyncedAt.getTime()) / 1000
    if (ageSeconds < ttl) {
      const rows = await getPoolParamEvents(chain, pool)
      const metadata = await fetchPoolMetadata(chain, pool).catch(() => null)
      return {
        events: rows.map(toWireEvent),
        lastBlock: state.lastBlock,
        cached: true,
        poolType: metadata?.type ?? null,
        protocolVersion: metadata?.protocolVersion ?? null,
      }
    }
  }

  // ── Resolve pool metadata (cheap api-v3 hit, cached) ──
  const metadata = await fetchPoolMetadata(chain, pool)
  if (!metadata) {
    // Pool not found on api-v3. Still upsert the sync state so we don't
    // hammer the API on repeated 404 visits; return an empty result.
    const client = getPublicClient(chain)
    const head = await client.getBlockNumber()
    await upsertPoolSyncState(chain, pool, Number(head))
    return { events: [], lastBlock: Number(head), cached: false, poolType: null, protocolVersion: null }
  }

  const client = getPublicClient(chain)
  const head = await client.getBlockNumber()
  const safeHead = head > REORG_CONFIRMATIONS ? head - REORG_CONFIRMATIONS : 0n

  // ── Decide whether to honor the watermark or rescan from the cold floor ──
  // The warm path (`fromBlock = watermark + 1`) is correct only if the
  // watermark is trustworthy. Two cases where it isn't:
  //
  //   1. `force` — POST /events or `?refresh`. The documented recovery path
  //      (handoff §8 triage) assumed this re-scans; it must, otherwise
  //      `?refresh` only bypasses the 30s TTL and re-serves the same stale
  //      rows. Force now means "full re-scan", not "skip the cache".
  //
  //   2. Poisoned watermark — a `pool_sync_state` row exists and has
  //      advanced, but zero events were ever persisted for the pool. This
  //      is the exact signature of a sync that ran before this pool type's
  //      Filter B was wired (or a filter that succeeded-but-empty): the
  //      watermark skipped real events and the warm path can never look
  //      back. Treat it as cold so the next post-TTL visit self-heals. The
  //      30s TTL fast-path above still throttles a legitimately-empty pool
  //      to at most one cold scan per TTL window (~$0.0004/scan on mainnet
  //      — negligible per the §7 cost model).
  //
  // Cold re-scans are safe and cheap: `insertPoolParamEvents` is idempotent
  // on the UNIQUE constraint, so re-scanning a range we already have just
  // costs RPC budget, never duplicate rows.
  const persistedCount = state ? await countPoolParamEvents(chain, pool) : 0
  const poisonedWatermark = state !== null && persistedCount === 0
  const rescanFromCold = options.force || poisonedWatermark || needDeepScan

  // ── Scan range ──
  let fromBlock: bigint
  // True only when this run actually walked from the deployment block — the
  // signal that latches `deep_synced`. A full-history request that fell back
  // to the 90-day cap (unknown createTime) must NOT latch it.
  let scannedFullHistory = false
  if (state && !rescanFromCold) {
    // Warm — pick up where we left off.
    fromBlock = BigInt(state.lastBlock) + 1n
  } else {
    // Approximate the pool's deployment block from api-v3 `createTime`:
    // head − ((now − createTime) / blockTime). We don't have an exact
    // creation block from api-v3, but the approximation is sufficient —
    // the chunked log walker tolerates empty ranges cheaply.
    let createBlock: bigint | null = null
    if (metadata.createTime) {
      const now = Math.floor(Date.now() / 1000)
      const ageSec = Math.max(0, now - metadata.createTime)
      const ageBlocks = BigInt(Math.ceil(ageSec * estimateBlocksPerSecond(chain)))
      createBlock = safeHead > ageBlocks ? safeHead - ageBlocks : 0n
    }
    const cap = ninetyDayFromBlock(chain, safeHead)
    if (options.fullHistory && createBlock !== null) {
      // Full history — scan from the (approx) deployment block, no 90-day
      // floor. Requires a known `createTime`; without it we'd be scanning
      // from genesis (500+ chunks on a mature mainnet), so we fall back to
      // the 90-day cap below rather than burn that range blind.
      fromBlock = createBlock
      scannedFullHistory = true
    } else {
      // Cold (or full-history with unknown createTime) — 90-day cap, raised
      // to the deployment block when the pool is younger than the cap (no
      // point scanning before it existed).
      fromBlock = createBlock !== null && createBlock > cap ? createBlock : cap
    }
  }

  if (fromBlock > safeHead) {
    // Nothing new — happens when last_block already advanced past head - 12.
    await upsertPoolSyncState(chain, pool, Number(state?.lastBlock ?? safeHead))
    const rows = await getPoolParamEvents(chain, pool)
    return {
      events: rows.map(toWireEvent),
      lastBlock: Number(state?.lastBlock ?? safeHead),
      cached: false,
      poolType: metadata.type,
      protocolVersion: metadata.protocolVersion,
    }
  }

  // ── Filter A + Filter B run independently ──
  // Originally these were sequential and one throwing aborted the other.
  // We now run them concurrently with per-filter catch, so a transient
  // drpc 5xx on one filter still lets the other land its events. The
  // watermark only advances when BOTH succeed — partial failures get a
  // retry on the next visit (and ON CONFLICT keeps re-inserts idempotent).
  const filterBEvents = pickFilterBEvents(metadata)
  const filterAPromise: Promise<{ logs: Awaited<ReturnType<typeof chunkedGetLogs>>; err: unknown }> =
    metadata.protocolVersion === 3
      ? (() => {
          const helpers = getV3HelperAddresses(chain)
          const filterAAddresses: Address[] = [V3_VAULT_ADDRESS]
          if (helpers?.protocolFeeController) {
            filterAAddresses.push(helpers.protocolFeeController)
          }
          if (helpers?.stableSurgeHooks) {
            filterAAddresses.push(...helpers.stableSurgeHooks)
          }
          return chunkedGetLogs(client, {
            address: filterAAddresses,
            events: V3_FILTER_A_EVENTS,
            args: { pool: pool as Address },
            fromBlock,
            toBlock: safeHead,
          })
            .then(logs => ({ logs, err: null }))
            .catch(err => ({ logs: [], err }))
        })()
      : Promise.resolve({ logs: [], err: null })

  const filterBPromise: Promise<{ logs: Awaited<ReturnType<typeof chunkedGetLogs>>; err: unknown }> =
    filterBEvents.length > 0
      ? chunkedGetLogs(client, {
          address: pool as Address,
          events: filterBEvents,
          fromBlock,
          toBlock: safeHead,
        })
          .then(logs => ({ logs, err: null }))
          .catch(err => ({ logs: [], err }))
      : Promise.resolve({ logs: [], err: null })

  const [filterAResult, filterBResult] = await Promise.all([filterAPromise, filterBPromise])

  if (filterAResult.err) {
    console.warn('[sync] Filter A (Vault) failed; Filter B events will still be persisted', {
      chain,
      pool,
      err: scrubError(filterAResult.err),
    })
  }
  if (filterBResult.err) {
    console.warn('[sync] Filter B (pool-emitted) failed; Filter A events will still be persisted', {
      chain,
      pool,
      err: scrubError(filterBResult.err),
    })
  }

  // Diagnostic — surfaces how many raw logs each filter returned so a
  // "nothing in the table" report can be triaged from the terminal
  // without instrumenting further. Cheap, runs once per sync.
  console.info('[sync] log scan complete', {
    chain,
    pool,
    poolType: metadata.type,
    fromBlock: Number(fromBlock),
    toBlock: Number(safeHead),
    rescanFromCold,
    poisonedWatermark,
    persistedCount,
    forced: options.force === true,
    fullHistory: options.fullHistory === true,
    needDeepScan,
    scannedFullHistory,
    filterALogs: filterAResult.logs.length,
    filterBLogs: filterBResult.logs.length,
    filterBEventCount: filterBEvents.length,
  })

  const allLogs = [...filterAResult.logs, ...filterBResult.logs]

  // ── Resolve block timestamps for unique blocks only ──
  const uniqueBlocks = new Set<bigint>()
  for (const log of allLogs) {
    if (log.blockNumber !== null) uniqueBlocks.add(log.blockNumber)
  }
  const timestamps = await resolveBlockTimestamps(client, chain, uniqueBlocks)

  // ── Decode + persist ──
  const newRows = decodeLogsToRows(allLogs, {
    chain,
    poolAddress: pool,
    protocolVersion: metadata.protocolVersion,
    blockTimestamps: timestamps,
  })
  if (newRows.length > 0) {
    await insertPoolParamEvents(newRows)
    console.info('[sync] decoded + persisted events', {
      chain,
      pool,
      rowsInserted: newRows.length,
      eventNames: Array.from(new Set(newRows.map(r => r.eventName))),
    })
  }

  // Only advance the watermark when both filters succeeded — otherwise
  // the next visit will retry the failed filter from the same fromBlock.
  // (Re-inserts are idempotent via the UNIQUE constraint, so the cost of
  // a successful filter being re-scanned is just RPC budget.)
  //
  // Latch `deep_synced` when this run was a full-history scan that
  // succeeded on both filters: `fromBlock` reached the deployment block, so
  // the DB now holds the complete timeline and future `?fullHistory` visits
  // can serve from it without re-walking the chain. `force` alone does not
  // latch it (a forced 90-day rescan hasn't covered the deep range).
  if (!filterAResult.err && !filterBResult.err) {
    await upsertPoolSyncState(chain, pool, Number(safeHead), scannedFullHistory)
  }

  const allRows = await getPoolParamEvents(chain, pool)
  return {
    events: allRows.map(toWireEvent),
    lastBlock: Number(safeHead),
    cached: false,
    poolType: metadata.type,
    protocolVersion: metadata.protocolVersion,
  }
}

function pickFilterBEvents(metadata: PoolMetadata): readonly unknown[] {
  const t = metadata.type.toUpperCase()
  if (metadata.protocolVersion === 3) {
    if (t === 'STABLE') return V3_STABLE_FILTER_B_EVENTS
    // Other V3 types currently have no Filter B events (Weighted is
    // immutable; ECLP / reCLAMM / LBP will be added in later phases).
    return []
  }
  if (metadata.protocolVersion === 2) {
    if (t === 'STABLE' || t === 'COMPOSABLE_STABLE') return V2_STABLE_FILTER_B_EVENTS
    return V2_NON_STABLE_FILTER_B_EVENTS
  }
  return []
}

function estimateBlocksPerSecond(chain: GqlChain): number {
  // Inverse of `SECONDS_PER_BLOCK` in initial-cap.ts. Inlined here to keep
  // the cap module side-effect-free and the inverse cheap.
  const spb: Partial<Record<GqlChain, number>> = {
    [GqlChain.Mainnet]: 12,
    [GqlChain.Arbitrum]: 0.25,
    [GqlChain.Avalanche]: 2,
    [GqlChain.Base]: 2,
    [GqlChain.Fantom]: 1,
    [GqlChain.Fraxtal]: 2,
    [GqlChain.Gnosis]: 5,
    [GqlChain.Hyperevm]: 1,
    [GqlChain.Mode]: 2,
    [GqlChain.Monad]: 1,
    [GqlChain.Optimism]: 2,
    [GqlChain.Plasma]: 1,
    [GqlChain.Polygon]: 2,
    [GqlChain.Sepolia]: 12,
    [GqlChain.Sonic]: 1,
    [GqlChain.Xlayer]: 3,
    [GqlChain.Zkevm]: 5,
  }
  return 1 / (spb[chain] ?? 12)
}

async function fetchPoolMetadata(
  chain: GqlChain,
  poolAddress: string
): Promise<PoolMetadata | null> {
  const key = `${chain}:${poolAddress.toLowerCase()}`
  const cached = metadataCache.get(key)
  if (cached && cached.expiresAt > Date.now()) return cached.value

  const query = /* GraphQL */ `
    query PoolMetadata($id: String!, $chain: GqlChain!) {
      poolGetPool(id: $id, chain: $chain) {
        type
        protocolVersion
        createTime
      }
    }
  `
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables: { id: poolAddress.toLowerCase(), chain } }),
    cache: 'no-store',
  })
  // Mirror the page-side `gqlFetch` logging — silent `null` here would
  // hide a Cloudflare rate-limit (429) or a future api-v3 schema break
  // behind a generic "pool not found" path, which is what bit us earlier.
  if (!res.ok) {
    console.warn('[sync] api-v3 fetchPoolMetadata HTTP failure', {
      chain,
      pool: poolAddress,
      status: res.status,
      retryAfter: res.headers.get('retry-after'),
    })
    return null
  }
  const json = (await res.json()) as {
    data?: { poolGetPool?: { type: string; protocolVersion: number; createTime: number } }
    errors?: unknown
  }
  if (json.errors) {
    console.warn('[sync] api-v3 fetchPoolMetadata GraphQL errors', {
      chain,
      pool: poolAddress,
      errors: json.errors,
    })
    return null
  }
  const pool = json.data?.poolGetPool
  if (!pool) return null
  const value: PoolMetadata = {
    type: pool.type,
    protocolVersion: pool.protocolVersion as 1 | 2 | 3,
    createTime: pool.createTime ?? null,
  }
  metadataCache.set(key, { value, expiresAt: Date.now() + POOL_METADATA_TTL_MS })
  return value
}

function toWireEvent(row: PoolParamEventRow): PoolParamEvent {
  return {
    chain: row.chain as GqlChain,
    poolAddress: row.poolAddress,
    protocolVersion: row.protocolVersion as 1 | 2 | 3,
    blockNumber: row.blockNumber,
    blockTimestamp: row.blockTimestamp,
    logIndex: row.logIndex,
    txHash: row.txHash,
    eventName: row.eventName,
    args: row.args as Record<string, string | number | boolean>,
  }
}
