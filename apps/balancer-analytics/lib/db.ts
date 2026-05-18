/**
 * Postgres client + schema bootstrap for the protocol snapshotter.
 *
 * Backed by Vercel's Neon Postgres integration — the marketplace add-on
 * injects `DATABASE_URL` (and `POSTGRES_URL` as an alias) at runtime. The
 * `@neondatabase/serverless` driver gives us a tagged-template `sql` helper
 * for typed queries plus `sql.transaction([...])` for batched writes.
 *
 * Rows are keyed by `(ts, chain, protocol)`:
 *   - `chain = 'ALL'` for the cross-chain aggregate, otherwise a `GqlChain`.
 *   - `protocol = 'CORE'` mirrors api-v3's `protocolMetricsAggregated`
 *     (which already includes CoW AMM in its numbers). `protocol = 'COW_AMM'`
 *     is a *breakdown of* CORE, tracked separately so charts can split it
 *     out — never sum CORE + COW_AMM, that double-counts.
 *
 * `ensureSchema()` is self-healing: idempotent CREATE for fresh deploys,
 * idempotent ALTERs to migrate an earlier 2-column-PK table.
 */

import 'server-only'
import { neon } from '@neondatabase/serverless'

const dbUrl = process.env.DATABASE_URL || process.env.POSTGRES_URL
if (!dbUrl) {
  throw new Error(
    'DATABASE_URL (or POSTGRES_URL) is missing. Provision Neon via the Vercel Marketplace and the env var is injected automatically.'
  )
}

export const sql = neon(dbUrl)

export const AGGREGATE_KEY = 'ALL' as const

export const PROTOCOL_CORE = 'CORE' as const
export const PROTOCOL_V2 = 'V2' as const
export const PROTOCOL_V3 = 'V3' as const
export const PROTOCOL_COW_AMM = 'COW_AMM' as const
export type Protocol =
  | typeof PROTOCOL_CORE
  | typeof PROTOCOL_V2
  | typeof PROTOCOL_V3
  | typeof PROTOCOL_COW_AMM

export const SOURCE_API = 'api-v3' as const
export const SOURCE_DEFILLAMA = 'defillama' as const
export const SOURCE_MANUAL = 'manual' as const
export type SnapshotSource =
  | typeof SOURCE_API
  | typeof SOURCE_DEFILLAMA
  | typeof SOURCE_MANUAL

/**
 * One DB row. Aggregate-across-all-chains rows use `chain = 'ALL'`; per-chain
 * rows use the `GqlChain` enum name (`'MAINNET'`, `'ARBITRUM'`, ...).
 */
export type SnapshotRow = {
  ts: number
  chain: string
  protocol: Protocol
  totalLiquidity: number
  swapVolume24h: number
  swapFee24h: number
  yieldCapture24h: number
  surplus24h: number
  poolCount: number
  numLps: number
  source: SnapshotSource
}

export async function ensureSchema(): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS protocol_snapshots (
      ts                BIGINT           NOT NULL,
      chain             TEXT             NOT NULL,
      protocol          TEXT             NOT NULL DEFAULT 'CORE',
      total_liquidity   DOUBLE PRECISION NOT NULL,
      swap_volume_24h   DOUBLE PRECISION NOT NULL,
      swap_fee_24h      DOUBLE PRECISION NOT NULL,
      yield_capture_24h DOUBLE PRECISION NOT NULL,
      surplus_24h       DOUBLE PRECISION NOT NULL,
      pool_count        INTEGER          NOT NULL,
      num_lps           INTEGER          NOT NULL,
      source            TEXT             NOT NULL DEFAULT 'api-v3',
      captured_at       TIMESTAMPTZ      NOT NULL DEFAULT now(),
      PRIMARY KEY (ts, chain, protocol)
    )
  `
  // Migration path: a table created before the CORE/COW_AMM split has neither
  // the new columns nor the 3-col PK. Add columns idempotently then rebuild
  // the PK only if it doesn't already include `protocol`.
  await sql`ALTER TABLE protocol_snapshots ADD COLUMN IF NOT EXISTS protocol TEXT NOT NULL DEFAULT 'CORE'`
  await sql`ALTER TABLE protocol_snapshots ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'api-v3'`
  await sql`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM information_schema.key_column_usage
        WHERE constraint_name = 'protocol_snapshots_pkey'
          AND column_name = 'protocol'
      ) THEN
        ALTER TABLE protocol_snapshots DROP CONSTRAINT IF EXISTS protocol_snapshots_pkey;
        ALTER TABLE protocol_snapshots ADD PRIMARY KEY (ts, chain, protocol);
      END IF;
    END $$;
  `
  await sql`CREATE INDEX IF NOT EXISTS idx_protocol_snapshots_ts ON protocol_snapshots (ts DESC)`
  await sql`CREATE INDEX IF NOT EXISTS idx_protocol_snapshots_chain_ts ON protocol_snapshots (chain, ts DESC)`
  await sql`CREATE INDEX IF NOT EXISTS idx_protocol_snapshots_protocol_ts ON protocol_snapshots (protocol, ts DESC)`

  // ── Pool parameter event timeline (lazy-fetched on pool-page visit) ──
  // One row per decoded param-change event for a single pool. UNIQUE
  // constraint on (chain, pool_address, block_number, log_index) makes
  // INSERTs idempotent — the tail-sync can safely re-process an overlapping
  // range without producing duplicates.
  await sql`
    CREATE TABLE IF NOT EXISTS pool_param_events (
      id               BIGSERIAL    PRIMARY KEY,
      chain            TEXT         NOT NULL,
      pool_address     TEXT         NOT NULL,
      protocol_version SMALLINT     NOT NULL,
      block_number     BIGINT       NOT NULL,
      block_timestamp  BIGINT       NOT NULL,
      log_index        INT          NOT NULL,
      tx_hash          TEXT         NOT NULL,
      event_name       TEXT         NOT NULL,
      args             JSONB        NOT NULL,
      captured_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
      UNIQUE (chain, pool_address, block_number, log_index)
    )
  `
  await sql`CREATE INDEX IF NOT EXISTS idx_pool_param_events_pool ON pool_param_events (chain, pool_address, block_number)`
  await sql`CREATE INDEX IF NOT EXISTS idx_pool_param_events_pool_event ON pool_param_events (chain, pool_address, event_name)`

  // ── Per-pool sync watermark ──
  // Tracks last successfully-synced block and the wall-clock time of the last
  // sync attempt. Used to (a) compute the next `fromBlock` for tail-sync and
  // (b) skip the RPC roundtrip when `last_synced_at` is within the TTL.
  await sql`
    CREATE TABLE IF NOT EXISTS pool_sync_state (
      chain          TEXT         NOT NULL,
      pool_address   TEXT         NOT NULL,
      last_block     BIGINT       NOT NULL,
      last_synced_at TIMESTAMPTZ  NOT NULL DEFAULT now(),
      PRIMARY KEY (chain, pool_address)
    )
  `
}

// ── pool_param_events helpers ──────────────────────────────────────────────

export type PoolParamEventRow = {
  chain: string
  poolAddress: string
  protocolVersion: number
  blockNumber: number
  blockTimestamp: number
  logIndex: number
  txHash: string
  eventName: string
  args: Record<string, unknown>
}

export async function getPoolParamEvents(
  chain: string,
  poolAddress: string
): Promise<PoolParamEventRow[]> {
  const rows = await sql`
    SELECT
      chain,
      pool_address,
      protocol_version,
      block_number,
      block_timestamp,
      log_index,
      tx_hash,
      event_name,
      args
    FROM pool_param_events
    WHERE chain = ${chain} AND pool_address = ${poolAddress.toLowerCase()}
    ORDER BY block_number ASC, log_index ASC
  `
  return (rows as Record<string, unknown>[]).map(r => ({
    chain: r.chain as string,
    poolAddress: r.pool_address as string,
    protocolVersion: Number(r.protocol_version),
    blockNumber: Number(r.block_number),
    blockTimestamp: Number(r.block_timestamp),
    logIndex: Number(r.log_index),
    txHash: r.tx_hash as string,
    eventName: r.event_name as string,
    args: (r.args ?? {}) as Record<string, unknown>,
  }))
}

export async function insertPoolParamEvents(
  rows: readonly PoolParamEventRow[]
): Promise<void> {
  if (rows.length === 0) return
  // neon-serverless `sql` helper doesn't support multi-row VALUES tuples
  // through tagged-template params, so we batch via `sql.transaction([...])`
  // with one parameterized statement per row. INSERT ... ON CONFLICT keeps
  // re-runs idempotent against the (chain, pool, block, log_index) UNIQUE.
  const statements = rows.map(
    r => sql`
      INSERT INTO pool_param_events (
        chain, pool_address, protocol_version,
        block_number, block_timestamp, log_index,
        tx_hash, event_name, args
      ) VALUES (
        ${r.chain},
        ${r.poolAddress.toLowerCase()},
        ${r.protocolVersion},
        ${r.blockNumber},
        ${r.blockTimestamp},
        ${r.logIndex},
        ${r.txHash.toLowerCase()},
        ${r.eventName},
        ${JSON.stringify(r.args)}::jsonb
      )
      ON CONFLICT (chain, pool_address, block_number, log_index) DO NOTHING
    `
  )
  await sql.transaction(statements)
}

// ── pool_sync_state helpers ────────────────────────────────────────────────

export type PoolSyncState = {
  chain: string
  poolAddress: string
  lastBlock: number
  lastSyncedAt: Date
}

export async function getPoolSyncState(
  chain: string,
  poolAddress: string
): Promise<PoolSyncState | null> {
  const rows = await sql`
    SELECT chain, pool_address, last_block, last_synced_at
    FROM pool_sync_state
    WHERE chain = ${chain} AND pool_address = ${poolAddress.toLowerCase()}
    LIMIT 1
  `
  const r = (rows as Record<string, unknown>[])[0]
  if (!r) return null
  return {
    chain: r.chain as string,
    poolAddress: r.pool_address as string,
    lastBlock: Number(r.last_block),
    lastSyncedAt: new Date(r.last_synced_at as string),
  }
}

export async function upsertPoolSyncState(
  chain: string,
  poolAddress: string,
  lastBlock: number
): Promise<void> {
  await sql`
    INSERT INTO pool_sync_state (chain, pool_address, last_block, last_synced_at)
    VALUES (${chain}, ${poolAddress.toLowerCase()}, ${lastBlock}, now())
    ON CONFLICT (chain, pool_address) DO UPDATE
      SET last_block = EXCLUDED.last_block,
          last_synced_at = now()
  `
}
