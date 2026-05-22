/**
 * Pool detail page — parameter timeline + impact visualization.
 *
 * This is the analytics surface; it does NOT replace frontend-v3's pool
 * page (no swap / add-liquidity actions, no positions). The goal is to
 * align parameter-change events with metric series so a viewer can see
 * how a swap-fee or amp-factor change correlates with TVL / volume / fees
 * over the following days.
 *
 * Data flow:
 *   - api-v3 `poolGetPool`           — pool metadata for the header
 *   - api-v3 `poolGetSnapshots(90d)` — continuous metric series
 *   - `syncPoolEvents`                — drpc-derived event timeline
 *   - `readUniversalV3State` + `readStableTypeState` — current params via
 *     VaultExplorer + pool getters multicall
 *
 * Functions are called server-side directly (no HTTP roundtrip through
 * the /api routes) — the routes exist as a public surface for external
 * consumers / debugging, not as a coupling for the page.
 */

import { notFound } from 'next/navigation'
import type { Address } from 'viem'
import { GqlChain } from '@repo/lib/shared/services/api/generated/graphql'
import { PROJECT_CONFIG } from '@repo/lib/config/getProjectConfig'
import { ChainSlug, getChainSlug } from '@repo/lib/modules/pool/pool.utils'
import { isDrpcSupportedChain } from '@analytics/lib/contracts/drpc-endpoints'
import { syncPoolEvents } from '@analytics/lib/pool-events/sync'
import {
  readGyroEclpTypeState,
  readLbpTypeState,
  readQuantAmmTypeState,
  readReclammTypeState,
  readStableSurgeState,
  readStableTypeState,
  readUniversalV3State,
  readV2BasePoolState,
  readV2StableTypeState,
  readWeightedTypeState,
  type GyroEclpTypeState,
  type LbpTypeState,
  type QuantAmmTypeState,
  type ReclammTypeState,
  type StableSurgeState,
  type StableTypeState,
  type UniversalV3State,
  type V2BasePoolState,
  type WeightedTypeState,
} from '@analytics/lib/pool-state/read'
import type { PoolParamEvent } from '@analytics/lib/pool-events/types'
import { scrubError } from '@analytics/lib/drpc/scrub'
import { PoolPageView } from './_components/PoolPageView'

export const dynamic = 'force-dynamic'

const API_URL =
  process.env.NEXT_PUBLIC_BALANCER_API_URL ?? 'https://api-v3.balancer.fi/graphql'

type RouteParams = { chain: string; id: string }

export type PoolDetail = {
  id: string
  address: string
  name: string
  symbol: string
  type: string
  protocolVersion: 1 | 2 | 3
  /** Sub-version within the protocol (e.g. 1 = StablePool v1, 2 = v2). */
  version: number | null
  chain: GqlChain
  createTime: number
  factory: string | null
  swapFeeManager: string | null
  pauseManager: string | null
  poolCreator: string | null
  tokens: {
    address: string
    symbol: string
    weight: string | null
    logoURI: string | null
  }[]
}

export type PoolSnapshot = {
  timestamp: number
  totalLiquidity: number
  volume24h: number
  fees24h: number
  surplus24h: number
  sharePrice: number
}

export type PoolHistoryRange = '30d' | '90d' | '180d' | '1y' | 'all'

export type PoolPageData = {
  poolDetail: PoolDetail
  snapshots: PoolSnapshot[]
  events: PoolParamEvent[]
  lastBlock: number
  /** Active range selector value — drives the chart header label, the
   *  range toggle, and whether the event scan ran in full-history mode. */
  range: PoolHistoryRange
  /** Derived: any range > 90d ran the full-history event scan. Kept on the
   *  payload for components that just want a binary "did we deep-scan?". */
  fullHistory: boolean
  state: {
    universal: UniversalV3State | null
    stable: StableTypeState | null
    v2Base: V2BasePoolState | null
    /** V3 type-specific params for the panel's lower section. At most one
     *  of these is non-null per pool (dispatched on `poolDetail.type`);
     *  `stableSurge` is additive on STABLE pools that have the hook. */
    weighted: WeightedTypeState | null
    gyroEclp: GyroEclpTypeState | null
    reclamm: ReclammTypeState | null
    lbp: LbpTypeState | null
    quantAmm: QuantAmmTypeState | null
    stableSurge: StableSurgeState | null
  }
}

const POOL_DETAIL_QUERY = /* GraphQL */ `
  query AnalyticsPoolDetail($id: String!, $chain: GqlChain!) {
    poolGetPool(id: $id, chain: $chain) {
      id
      address
      name
      symbol
      type
      protocolVersion
      version
      chain
      createTime
      factory
      swapFeeManager
      pauseManager
      poolCreator
      poolTokens {
        address
        symbol
        weight
        logoURI
      }
    }
  }
`

const SNAPSHOTS_QUERY = /* GraphQL */ `
  query AnalyticsPoolSnapshots(
    $id: String!
    $chain: GqlChain!
    $range: GqlPoolSnapshotDataRange!
  ) {
    snapshots: poolGetSnapshots(id: $id, chain: $chain, range: $range) {
      timestamp
      totalLiquidity
      volume24h
      fees24h
      surplus24h
      sharePrice
    }
  }
`

/**
 * Surface viem `HttpRequestError` fields that JSON stringification drops,
 * with the drpc API key scrubbed from URLs and messages before logging.
 */
function logRpcError(label: string, chain: GqlChain, pool: string, err: unknown): void {
  console.error(label, { chain, pool, ...scrubError(err) })
}

/** Default Next Data Cache TTL for api-v3 GraphQL fetches on this page.
 *  Pool metadata and daily snapshots both update on the order of hours at
 *  most; a 60s window lets click-arounds dedupe (key = request body) without
 *  letting newly-changed pools sit stale long. `?refresh` overrides this to
 *  `cache: 'no-store'`, preserving the documented bypass path. */
const POOL_FETCH_REVALIDATE_SECONDS = 60

async function gqlFetch<T>(
  query: string,
  variables: Record<string, unknown>,
  label: string,
  options: { forceFresh?: boolean } = {}
): Promise<T | null> {
  const cacheOptions: RequestInit = options.forceFresh
    ? { cache: 'no-store' }
    : { next: { revalidate: POOL_FETCH_REVALIDATE_SECONDS } }
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
    ...cacheOptions,
  })
  // Loud about failure modes so a "404: api-v3 has no pool" doesn't hide
  // (a) Cloudflare rate-limits (429) under heavy dev traffic, or
  // (b) GraphQL schema drift (e.g. api-v3 removing `addressIn`).
  // Silent `null` here used to look identical to a legitimate "not found"
  // in the dev log; that ambiguity bit us on a re-tested pool today.
  if (!res.ok) {
    console.warn(`[pool/page] api-v3 ${label} HTTP ${res.status}`, {
      variables,
      retryAfter: res.headers.get('retry-after'),
    })
    return null
  }
  const json = (await res.json()) as { data?: T; errors?: unknown }
  if (json.errors) {
    console.warn(`[pool/page] api-v3 ${label} GraphQL errors`, {
      variables,
      errors: json.errors,
    })
    return null
  }
  return json.data ?? null
}

export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<RouteParams>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}): Promise<React.JSX.Element> {
  const { chain: chainSlug, id } = await params
  const search = await searchParams
  // `?refresh` (or `?refresh=1`) on the URL forces the sync to ignore the
  // 30s TTL and re-scan from the cold floor. Useful for inspecting a pool
  // whose first sync hit a transient drpc error and left the table empty.
  const forceRefresh = search.refresh !== undefined

  // `?range=30d|90d|180d|1y|all` (default 90d). Drives both the api-v3
  // snapshot enum AND the event-scan window — see `RANGE_*` constants
  // below. `?fullHistory` (legacy URL form) maps to `?range=all` for
  // backwards compat so old links keep working.
  type HistoryRange = '30d' | '90d' | '180d' | '1y' | 'all'
  const VALID_RANGES: ReadonlySet<HistoryRange> = new Set(['30d', '90d', '180d', '1y', 'all'])
  function parseRange(raw: unknown): HistoryRange {
    if (typeof raw === 'string' && VALID_RANGES.has(raw as HistoryRange)) {
      return raw as HistoryRange
    }
    return '90d'
  }
  const rawRange = Array.isArray(search.range) ? search.range[0] : search.range
  const range: HistoryRange =
    search.fullHistory !== undefined && search.range === undefined
      ? 'all'
      : parseRange(rawRange)

  // Snapshot enum per range. 30d uses the 90-day fetch and trims client-side
  // (api-v3 has no 30-day enum). The longer ranges round-trip directly.
  const SNAPSHOT_RANGE: Record<HistoryRange, string> = {
    '30d': 'NINETY_DAYS',
    '90d': 'NINETY_DAYS',
    '180d': 'ONE_HUNDRED_EIGHTY_DAYS',
    '1y': 'ONE_YEAR',
    all: 'ALL_TIME',
  }
  // Any range > 90d triggers the one-time full-history event scan so the
  // chart's event markers can land anywhere on the visible x-axis. After
  // the first deep scan, `pool_sync_state.deep_synced` latches and all
  // future visits (any range) serve fast from the DB. Backwards-compat:
  // legacy `fullHistory` was treated as `all` above.
  const fullHistory = range !== '30d' && range !== '90d'

  let chain: GqlChain
  try {
    chain = getChainSlug(chainSlug.toLowerCase() as ChainSlug)
  } catch {
    console.warn('[pool/page] 404: invalid chain slug', { chainSlug, id })
    notFound()
  }
  if (!(PROJECT_CONFIG.supportedNetworks as readonly GqlChain[]).includes(chain)) {
    console.warn('[pool/page] 404: chain not in PROJECT_CONFIG.supportedNetworks', {
      chain,
      supported: PROJECT_CONFIG.supportedNetworks,
    })
    notFound()
  }
  if (!isDrpcSupportedChain(chain)) {
    console.warn('[pool/page] 404: chain not drpc-supported', { chain })
    notFound()
  }
  // Accept either form:
  //  - 42-char address (0x + 40 hex) — canonical for V3 pools (where
  //    `pool.id === pool.address`) and also a usable shorthand for V2.
  //  - 66-char poolId (0x + 64 hex) — required for V2 / CowAmm pools, whose
  //    `id` is `address` + 2-byte type + 2-byte nonce.
  if (!/^0x[a-fA-F0-9]{40}([a-fA-F0-9]{24})?$/.test(id)) {
    console.warn('[pool/page] 404: invalid pool address or poolId', { id })
    notFound()
  }

  const rawId = id.toLowerCase()
  // Contract address used for on-chain calls (drpc) is always the first 20
  // bytes. For 42-char input that's the whole string; for 66-char input we
  // slice off the trailing type+nonce bytes.
  const contractAddress = rawId.length === 66 ? rawId.slice(0, 42) : rawId
  // api-v3 expects the canonical pool id. V3 pools use the 42-char address
  // as their id (`pool.id === pool.address`); V2/CowAmm pools use the
  // 66-char form (`address + 2-byte type + 2-byte nonce`). The URL itself
  // is the canonical id — `poolGetPool(id, chain)` returns the pool for
  // either shape directly. There used to be a `poolGetPools(where: {
  // addressIn: [...] })` fallback for users who typed a V2 pool's 42-char
  // address, but api-v3 removed `addressIn` from `GqlPoolFilter` (verified
  // via introspection 2026-05-20). With no address-keyed lookup left, V2
  // pools must be reached via their 66-char poolId; the gqlFetch logging
  // above surfaces the api-v3 "Pool with id does not exist" error so a
  // user typing the wrong form sees it in the dev log.
  const apiV3Id = rawId

  const detailRes = await gqlFetch<{
    poolGetPool: {
      id: string
      address: string
      name: string
      symbol: string
      type: string
      protocolVersion: number
      version: number | null
      chain: GqlChain
      createTime: number
      factory: string | null
      swapFeeManager: string | null
      pauseManager: string | null
      poolCreator: string | null
      poolTokens: {
        address: string
        symbol: string
        weight: string | null
        logoURI: string | null
      }[]
    }
  }>(POOL_DETAIL_QUERY, { id: apiV3Id, chain }, 'poolGetPool', { forceFresh: forceRefresh })

  // Snapshots and sync can run concurrently now that we know the canonical
  // identifiers — separate Promise.all once `apiV3Id` is resolved.
  const [snapshotsRes, syncRes] = await Promise.all([
    gqlFetch<{ snapshots: PoolSnapshot[] }>(
      SNAPSHOTS_QUERY,
      { id: apiV3Id, chain, range: SNAPSHOT_RANGE[range] },
      'poolGetSnapshots',
      { forceFresh: forceRefresh }
    ),
    syncPoolEvents(chain, contractAddress, {
      force: forceRefresh,
      fullHistory,
      // V2 pools need the 66-char poolId for `poolGetPool` to resolve;
      // the contract address would 404 and poison the watermark.
      apiV3Id: apiV3Id,
    }).catch(
      (err: unknown) => {
        logRpcError('[pool/page] syncPoolEvents failed', chain, contractAddress, err)
        return { events: [], lastBlock: 0, cached: false, poolType: null, protocolVersion: null }
      }
    ),
  ])

  if (!detailRes?.poolGetPool) {
    console.warn('[pool/page] 404: api-v3 has no pool for input id', {
      chain,
      rawId,
      contractAddress,
      hint:
        rawId.length === 42
          ? 'V3 pools use the 42-char address as id; V2/CowAmm pools require the 66-char poolId. If this is a V2 pool, retry with the full poolId.'
          : 'check api-v3 logs above (the gqlFetch wrapper logs HTTP errors and GraphQL errors).',
    })
    notFound()
  }

  const poolDetail: PoolDetail = {
    ...detailRes.poolGetPool,
    protocolVersion: detailRes.poolGetPool.protocolVersion as 1 | 2 | 3,
    tokens: detailRes.poolGetPool.poolTokens.map(t => ({
      address: t.address,
      symbol: t.symbol,
      weight: t.weight,
      logoURI: t.logoURI,
    })),
  }

  // State reads dispatch on the resolved pool protocol version. V3 uses
  // VaultExplorer + FeeController for universal state, V2 reads directly
  // off the pool contract.
  let universal: UniversalV3State | null = null
  let stable: StableTypeState | null = null
  let v2Base: V2BasePoolState | null = null
  let weighted: WeightedTypeState | null = null
  let gyroEclp: GyroEclpTypeState | null = null
  let reclamm: ReclammTypeState | null = null
  let lbp: LbpTypeState | null = null
  let quantAmm: QuantAmmTypeState | null = null
  let stableSurge: StableSurgeState | null = null
  const isStable = poolDetail.type === 'STABLE' || poolDetail.type === 'COMPOSABLE_STABLE'

  // Wrap a state read so a single reverting helper-contract call degrades to
  // `null` (panel falls back to universal state) instead of failing render.
  const rescue = <T,>(label: string, p: Promise<T | null>): Promise<T | null> =>
    p.catch((err: unknown) => {
      logRpcError(`[pool/page] ${label} failed`, chain, contractAddress, err)
      return null
    })

  if (poolDetail.protocolVersion === 3) {
    const addr = contractAddress as Address
    const t = poolDetail.type
    // One read per lane, dispatched on pool type. At most one type-specific
    // read fires (others resolve to `null` synchronously); `stableSurge` is
    // additive on STABLE pools and self-nulls when the hook isn't attached.
    const [u, s, w, ge, rc, l, qa, ss] = await Promise.all([
      rescue('readUniversalV3State', readUniversalV3State(chain, addr)),
      isStable ? rescue('readStableTypeState', readStableTypeState(chain, addr)) : null,
      t === 'WEIGHTED' ? rescue('readWeightedTypeState', readWeightedTypeState(chain, addr)) : null,
      t === 'GYROE' ? rescue('readGyroEclpTypeState', readGyroEclpTypeState(chain, addr)) : null,
      t === 'RECLAMM' ? rescue('readReclammTypeState', readReclammTypeState(chain, addr)) : null,
      t === 'LIQUIDITY_BOOTSTRAPPING'
        ? rescue('readLbpTypeState', readLbpTypeState(chain, addr))
        : null,
      t === 'QUANT_AMM_WEIGHTED'
        ? rescue('readQuantAmmTypeState', readQuantAmmTypeState(chain, addr))
        : null,
      isStable ? rescue('readStableSurgeState', readStableSurgeState(chain, addr)) : null,
    ])
    universal = u
    stable = s
    weighted = w
    gyroEclp = ge
    reclamm = rc
    lbp = l
    quantAmm = qa
    stableSurge = ss
  } else if (poolDetail.protocolVersion === 2) {
    const [b, s] = await Promise.all([
      readV2BasePoolState(chain, contractAddress as Address).catch((err: unknown) => {
        logRpcError('[pool/page] readV2BasePoolState failed', chain, contractAddress, err)
        return null
      }),
      isStable
        ? readV2StableTypeState(chain, contractAddress as Address).catch((err: unknown) => {
            logRpcError(
              '[pool/page] readV2StableTypeState failed',
              chain,
              contractAddress,
              err
            )
            return null
          })
        : Promise.resolve(null),
    ])
    v2Base = b
    stable = s
  }

  // For the 30d range we fetched the 90-day snapshot enum (api-v3 has no
  // 30d enum) and trim to the latest-30-days window. We anchor the cutoff
  // on the *latest snapshot timestamp* rather than `Date.now()` — pure
  // function of the input, no clock dependency in the render path, and
  // naturally robust to stale series where "now" is past the last point.
  const rawSnapshots = snapshotsRes?.snapshots ?? []
  let trimmedSnapshots = rawSnapshots
  if (range === '30d' && rawSnapshots.length > 0) {
    let latest = 0
    for (const s of rawSnapshots) if (s.timestamp > latest) latest = s.timestamp
    const cutoff = latest - 30 * 86400
    trimmedSnapshots = rawSnapshots.filter(s => s.timestamp >= cutoff)
  }

  const data: PoolPageData = {
    poolDetail,
    snapshots: trimmedSnapshots,
    events: syncRes.events,
    lastBlock: syncRes.lastBlock,
    range,
    fullHistory,
    state: {
      universal,
      stable,
      v2Base,
      weighted,
      gyroEclp,
      reclamm,
      lbp,
      quantAmm,
      stableSurge,
    },
  }

  return <PoolPageView data={data} />
}
