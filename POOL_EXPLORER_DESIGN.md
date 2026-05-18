# Pool Explorer — Parameter History & Impact Visualization

A design plan for the `apps/balancer-analytics` pool explorer. This is **not** a re-implementation of `frontend-v3`'s pool page. The goal is a per-pool, parameter-aware, time-aligned view that visualizes:

- **Continuous metrics** (TVL, volume, fees, share price) over time
- **Discrete parameter changes** (swap fee, amp factor, weights, pause state, …) as events on the same timeline
- **Impact** — how a parameter change correlates with subsequent metric movement

Dated 2026-05-18. To be reviewed before any phase is executed.

---

## 1. Approach in one paragraph

Three data lanes, each playing to its strength:

1. **api-v3 `poolGetSnapshots`** (already wired via `@repo/lib`) — continuous daily series (TVL, volume24h, fees24h, surplus24h, sharePrice, swapsCount, amounts).
2. **On-chain event logs via drpc** — exact, immutable history of parameter changes. Fetched lazily on pool-page visit through an internal route handler that hides the org-wide drpc key. Cached write-through into a single Postgres table.
3. **Helper contracts via drpc** — current pool state via multicall against V3 `VaultExplorer`, `ProtocolFeeController`, and pool-type-specific getters. No history, just "what is right now."

Helper contracts answer **what is**, events answer **what was**, api-v3 answers **what happened as a result**.

No background indexer / cron. The pool page warms its own cache. First visit pays once; subsequent visits fetch only the tail.

---

## 2. Architecture

```
Browser
  └── Server Component  app/pool/[chain]/[id]/page.tsx
       ├── api-v3 poolGetPool          (@repo/lib · Apollo · pool metadata + type)
       ├── api-v3 poolGetSnapshots     (@repo/lib · Apollo · 90d default series)
       ├── /api/pool/[chain]/[id]/events   ← internal · hides DRPC_API_KEY
       │     ├── SELECT MAX(block) FROM pool_param_events WHERE pool=?
       │     ├── eth_getLogs from (last_block + 1) → (head - 12)
       │     ├── INSERT new rows (UNIQUE on chain, pool, block, log_index)
       │     └── SELECT * FROM pool_param_events WHERE pool=? ORDER BY block
       └── /api/pool/[chain]/[id]/state    ← internal · hides DRPC_API_KEY
             └── multicall VaultExplorer + ProtocolFeeController + pool-type getters
```

Why lazy-on-visit beats cron:

- Hot pools stay hot (tail sync = ~4 RPC requests).
- Cold pools never burn budget.
- DB is a passive write-through cache. Truncating is a safe recovery.
- No background workers to maintain.
- Cost scales with traffic, not pool count.

---

## 3. Internal API surface

Three route handlers under `apps/balancer-analytics/app/api/pool/[chain]/[id]/`:

| Route | Verb | Purpose | Caching |
|---|---|---|---|
| `events/route.ts` | GET | Param-change event timeline. Triggers tail-sync on call. | `Cache-Control: s-maxage=30, stale-while-revalidate=300` |
| `state/route.ts` | GET | Current pool params via helper multicall. | `Cache-Control: s-maxage=60` (drpc-only, no DB) |
| `events/route.ts` | POST | Force re-sync from a specific block (debug / data corrections). | `no-store` |

Hardening for every route:

- `import 'server-only'` — guarantees `DRPC_API_KEY` never bundles to the client.
- `zod` validation on chain (must be in `PROJECT_CONFIG.supportedNetworks`) and pool address (checksummed `0x[a-fA-F0-9]{40}`).
- IP rate limit (10 req/min/IP for `/events`) — Vercel BotID + simple in-memory limiter.
- Per-`(chain, pool)` sync TTL in DB (skip RPC if synced within last 30s).
- In-flight dedupe: `Map<key, Promise>` so N concurrent requests fan out to 1 RPC roundtrip.

drpc client: viem `fallback([http(drpc), http(publicRPC)])` per chain. Concurrency cap with `p-limit` (4 per chain) so a burst of page loads doesn't generate hundreds of in-flight requests.

---

## 4. DB schema

One new table, mirroring the existing `protocol_snapshots` pattern in `apps/balancer-analytics/lib/db.ts`:

```sql
CREATE TABLE pool_param_events (
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
);
CREATE INDEX ON pool_param_events (chain, pool_address, block_number);
CREATE INDEX ON pool_param_events (chain, pool_address, event_name);
```

Plus a small TTL table for the per-pool sync watermark:

```sql
CREATE TABLE pool_sync_state (
  chain           TEXT         NOT NULL,
  pool_address    TEXT         NOT NULL,
  last_block      BIGINT       NOT NULL,
  last_synced_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
  PRIMARY KEY (chain, pool_address)
);
```

**Block timestamps:** stored directly on each `pool_param_events` row, not in a separate cache table. `eth_getLogs` returns `block_number` but not `block_timestamp`, so we resolve via `eth_getBlockByNumber` during ingestion. Within a single sync we dedupe with an in-memory `Set<bigint>` over the decoded logs (a pool can have multiple events in one block — e.g. a governance batch — so we fetch each unique block once and fan the timestamp out to all events sharing it). Cross-pool overlap is rare enough that a persistent block-timestamp cache isn't worth the moving part.

**Reorg safety:** only persist events from blocks ≤ `head − 12`. Fetch `head − 12 → head` fresh every call without persisting.

Schema bootstrap goes in `lib/db.ts` `ensureSchema()` alongside the existing `protocol_snapshots` migration.

---

## 5. Events to decode

ABIs hand-curated in `apps/balancer-analytics/lib/abis/` (~30 lines per type). Revisit codegen from `balancer-deployments` only if signatures start to drift.

### V3 Vault (`0xbA1333333333a1BA1108E8412f11850A5C319bA9`)
Filter by indexed `pool` topic. Single `eth_getLogs` call covers all topics in one chunk.

- `SwapFeePercentageChanged(address indexed pool, uint256 swapFeePercentage)`
- `AggregateSwapFeePercentageChanged(address indexed pool, uint256 aggregateSwapFeePercentage)`
- `AggregateYieldFeePercentageChanged(address indexed pool, uint256 aggregateYieldFeePercentage)`
- `PoolPausedStateChanged(address indexed pool, bool paused)`
- `PoolRecoveryModeStateChanged(address indexed pool, bool recoveryMode)`
- `PoolRegistered(...)` — t0 anchor for the timeline

### V3 ProtocolFeeController
Same filter pattern as the Vault, address from `balancer-deployments`. Per-pool events (filtered by indexed `pool`):

- `PoolCreatorSwapFeePercentageChanged(address indexed pool, uint256 poolCreatorSwapFeePercentage)`
- `PoolCreatorYieldFeePercentageChanged(address indexed pool, uint256 poolCreatorYieldFeePercentage)`
- `ProtocolSwapFeePercentageChanged(address indexed pool, …)` — per-pool override of the protocol swap fee
- `ProtocolYieldFeePercentageChanged(address indexed pool, …)` — per-pool override of the protocol yield fee
- `InitialPoolAggregateSwapFeePercentage(address indexed pool, …)` — t0 anchor (initial aggregate at registration)
- `InitialPoolAggregateYieldFeePercentage(address indexed pool, …)` — t0 anchor (initial aggregate at registration)
- `PoolRegisteredWithFeeController(address indexed pool, …)` — t0 anchor parallel to Vault's `PoolRegistered`

**Skipped** (not param-shaped or not per-pool): `GlobalProtocolSwap/YieldFeePercentageChanged` (protocol-wide), `PoolCreatorFeesWithdrawn`, `ProtocolSwapFeeCollected`, `ProtocolYieldFeeCollected`, `ProtocolFeesWithdrawn` (accounting events — could power a future "fees-flowed" overlay, not Phase B).

### V3 Pool contract (filter by `address = pool`)
Type-dependent, dispatched on `poolGetPool.type`:

- **StablePool**: `AmpUpdateStarted(uint256 startValue, uint256 endValue, uint256 startTime, uint256 endTime)`, `AmpUpdateStopped(uint256 currentValue)`
- **LBP v3**: `GradualSwapFeeUpdateScheduled`, `GradualWeightUpdateScheduled`
- **reCLAMM**: recenter events (TBD verify in v3 monorepo)
- **StableSurge hook** (emitted on the hook contract, not the pool — separate address filter, but still filterable by indexed `pool`):
  - `ThresholdSurgePercentageChanged(address indexed pool, uint256 newSurgeThresholdPercentage)` (note: word order is `Threshold` first)
  - `MaxSurgeFeePercentageChanged(address indexed pool, uint256 newMaxSurgeFeePercentage)`
  - `StableSurgeHookRegistered(address indexed pool, address indexed factory)` — t0 anchor for surge attachment

### V2 (`0xBA12222222228d8Ba445958a75a0704d566BF2C8`)
V2 emits param events from the **pool contract directly**, not the Vault. Filter by `address = pool`:

Universal (all V2 pool types):
- `SwapFeePercentageChanged(uint256 swapFeePercentage)`
- `PausedStateChanged(bool paused)`
- `RecoveryModeStateChanged(bool enabled)` — verified from deployed ABI
- `ProtocolFeePercentageCacheUpdated(uint256 indexed feeType, uint256 protocolFeePercentage)` — V2's per-pool protocol fee cache; useful to track but not strictly a config change

Stable / ComposableStable V2:
- `AmpUpdateStarted(uint256 startValue, uint256 endValue, uint256 startTime, uint256 endTime)`
- `AmpUpdateStopped(uint256 currentValue)`
- *(Optional, phase later)* `TokenRateProviderSet`, `TokenRateCacheUpdated` — for V2 stable pools with rate providers (wstETH, rETH, etc.)

### Topic-filter structure

Per chunk, the smallest set of `eth_getLogs` calls that covers a V3 pool:

1. **Filter A** — Vault + FeeController + StableSurge hook (when applicable). Every event in this group has `pool` as `topics[1]`, so a single multi-address / multi-topic0 call works:
   `address = [vault, feeController, surgeHook?]`, `topics = [[all_topic0s], pool_padded]`
2. **Filter B** — Pool-emitted events (Stable amp updates, LBP weight schedules, reCLAMM recenter, …). These have no indexed `pool` (they're scoped to the emitting contract):
   `address = pool`, `topics = [[type_specific_topic0s]]`

V2 pools collapse to just Filter B (V2 emits everything from the pool contract).

---

## 6. Helper contracts (the `/state` route)

One multicall per pool. Calls dispatch on `poolGetPool.type`:

### V3 universal (`VaultExplorer`)
- `getStaticSwapFeePercentage(pool)`
- `getAggregateSwapFeePercentage(pool)`
- `getAggregateYieldFeePercentage(pool)`
- `getPoolPausedState(pool)`
- `getPoolConfig(pool)`
- `getCurrentLiveBalances(pool)`

### V3 type-specific
- **Stable**: `pool.getAmplificationParameter()` → `(value, isUpdating, precision)`
- **Weighted**: `pool.getNormalizedWeights()`
- **StableSurge**: surge hook's `getSurgeThresholdPercentage(pool)`, `getMaxSurgeFeePercentage(pool)`
- **ECLP / 2CLP / reCLAMM / QuantAMM**: their type-specific getters

### V3 `ProtocolFeeController`
- `getPoolCreatorSwapFeePercentage(pool)`
- `getPoolCreatorYieldFeePercentage(pool)`

`VaultExplorer` + `ProtocolFeeController` addresses per chain come from `balancer/balancer-deployments`. Baked into a `lib/contracts/v3-addresses.ts` const map at build time (not fetched at runtime).

---

## 7. The page

`apps/balancer-analytics/app/pool/[chain]/[id]/page.tsx` — Server Component.

Parallel data fetch via `Promise.all([poolGetPool, poolGetSnapshots, fetch(/events), fetch(/state)])`. Stream with Next 16 RSC: the api-v3 portion renders immediately, drpc data fills in.

### Client view (echarts)

1. **Combined chart**
   - Line series: TVL
   - Bar series: volume24h
   - Stacked bar: fees24h (split swap fee / yield fee where applicable)
   - `markPoint` annotations for events (one icon per event type, color-coded by category)
   - `markArea` rendering "amp-update in progress" ramps from `AmpUpdateStarted` → `AmpUpdateStopped` / `endTime`

2. **Parameter inspector** (right rail)
   - Pool-type-specific component
   - Subscribes to chart cursor; resolves the parameter snapshot at the hovered timestamp by walking the event stream up to that point
   - One component per type, ship in this order:
     1. `StableInspector` — most analytically interesting (amp ramps)
     2. `WeightedInspector`
     3. `StableSurgeInspector`
     4. Later: `ECLPInspector`, `reCLAMMInspector`, `LbpInspector`

3. **Event log** (below chart)
   - Chronological table
   - Click row → seek chart cursor to that timestamp

4. **(Phase E) Compare mode**
   - Two-cursor selection
   - Param diff panel (before / after)
   - Metric delta panel (Δ TVL, Δ volume, Δ fees over the selected window)

### Time horizon

90 days by default — aligned with api-v3's `poolGetSnapshots` `NINETY_DAYS` range. Toggle expands both sources simultaneously to `ALL_TIME` / pool-creation. Single piece of UI state drives every data source consistently.

---

## 8. Cost analysis (drpc)

Billing: **$6 / 1M requests** on the org-wide drpc key, billed globally to Balancer.

### Requests per cold start (90-day cap)

| Chain | Chunks | getLogs (×2) | Block lookups | Multicall | Total |
|---|---|---|---|---|---|
| Mainnet | 7 | 14 | ~50 | 1 | ~65 |
| Base / Optimism | 39 | 78 | ~50 | 1 | ~130 |
| Arbitrum | 310 | 620 | ~50 | 1 | ~670 |
| Polygon / Avax | 39 | 78 | ~50 | 1 | ~130 |
| Gnosis | 16 | 32 | ~50 | 1 | ~85 |

### Warm visit
~4 requests (`blockNumber` + 2 × `getLogs` + multicall).

### Cost translation
- Mainnet cold start: **$0.0004** per pool
- Arbitrum cold start (worst): **$0.004** per pool
- Warm visit: **$0.000024** per pool

### Monthly projections

| Scenario | Requests | Cost |
|---|---|---|
| Steady state (6k visits, 99% warm) | ~30k | **$0.18** |
| Bootstrap month (200 visits/day, 30% cold) | ~300k | **$1.80** |
| Pathological (every pool cold-started on Arbitrum) | ~470k | **$2.81** |

Effectively noise against the org-wide drpc bill. Guard rails below remain useful for **latency, reliability, and rate-limit-bound failure modes** — not for cost.

### Cost-control levers (still ship them)

1. **90-day initial cap** with explicit "load full history" affordance.
2. **Per-(chain, pool) sync TTL** in DB. Skip RPC if `last_synced_at > now() - 30s`.
3. **In-flight dedupe** at the route handler.
4. **IP rate limit** (10 req/min/IP) + Vercel BotID.
5. **`createTime` lower bound** from `poolGetPool` — never search before pool deployment.
6. **drpc fallback transport** with public RPC as backup.
7. **Chunk cap per request**: >500 chunks → 202 + queue (one-shot serverless function, no cron). User sees "loading full history…" without us auto-burning the whole range on one page load.

---

## 9. Phasing

| Phase | Deliverable | Verifies |
|---|---|---|
| **A — Plumbing** | drpc env wiring + internal route key handling, viem client factory with fallback + p-limit, `pool_param_events` + `pool_sync_state` + `block_timestamps` tables in `lib/db.ts`, `lib/abis/` skeleton, three route handlers (empty event list / dummy state OK) | Auth, validation, key hiding, DB write-through, env wiring |
| **B — Stable proof** | Full pipeline for one mainnet Stable pool. Decode + persist `SwapFeePercentageChanged` + `AmpUpdate*` + pause events. Render line+bar chart with markers. `StableInspector` with amp ramp visualization. | Worst-case event volume on a real pool, ramp rendering UX, end-to-end pipeline |
| **C — Broaden types** | Weighted + Stable Surge inspectors. Pool-type dispatch in `/state`. Loading skeletons / cold-start UX. | Type dispatch pattern, multi-pool concurrency under p-limit |
| **D — Multi-chain** | Wire all `supportedNetworks` chains. drpc slug map. Smoke-test one pool per chain (especially Arbitrum and Base). | Per-chain throttle tuning, real-world request budget |
| **E — Compare mode** | Two-cursor selection, param diff panel, metric delta tile | Final UX polish |
| **F — Long-tail types** | ECLP, reCLAMM, LBP, QuantAMM inspectors | Coverage breadth |

Phase A + B together is the risk-bearing core. Once Stable works end-to-end on one pool, the rest is replication.

---

## 10. Open decisions (final review pass)

1. **drpc block-range limits.** Confirmed in their pricing tier? Especially Arbitrum/Base — if the indexed-topic limit is 10k (not 100k) on L2, cold-start cost on Arbitrum jumps 10× (still ~$0.04 per pool, still fine). Worth a one-off probe before Phase A.

2. **ABI source.** Hand-curated `lib/abis/` for v1 (faster), revisit codegen from `balancer-deployments` if signatures drift. Confirm.

3. **Cold-start cap behavior.** With 90d cap, what does "Load full history" do for a 3-year-old mainnet pool?
   - Option a) Synchronously fetch the full range on click (~5–10s wait).
   - Option b) Trigger an async backfill job, page shows "backfilling…" tag for ~30s, then refresh.
   - Recommend **(a)** for v1 — pool age >2y is rare, total request count for full mainnet history is still ~150 requests.

4. **Refresh-on-visit policy.** TTL = 30s recommended. Lower (10s) is wasteful given drpc round-trip; higher (60s) means open tabs show stale state for too long. Confirm 30s.

5. **Pool-type dispatch fallback.** When `poolGetPool.type` is a type we haven't built an inspector for (e.g. QuantAMM in v1), what does the page do?
   - Recommend: render the chart + universal-state inspector only (swap fee, paused, recovery mode, aggregate fees). Better than a 404. Add a "More parameters coming soon" affordance.

6. **Event source for V2 `WeightedPool2Tokens` etc.** Survey factory variants before the ABI list freezes — some old factories may emit different event names. Recommend a quick on-chain probe in Phase A.

---

## 11. Non-goals (what this is **not**)

- Not a re-implementation of `frontend-v3`'s pool page. Add/remove liquidity, swaps, position tracking — all stay in `frontend-v3`.
- Not a real-time monitor. 30s TTL on tail sync is fine; sub-second polling is out of scope.
- Not a custom indexer. We never run a background worker. DB is passive write-through cache.
- Not historical price-impact modeling. The chart shows correlation between events and metrics; explanatory analysis is the user's job, not the dashboard's.
- Not transaction-level event display (every swap, every join/exit). Those are aggregates via api-v3 — the new page is about *parameter* events specifically.

---

## 12. File layout (target)

```
apps/balancer-analytics/
  app/
    pool/[chain]/[id]/
      page.tsx                              # server component
      _components/
        PoolHistoryChart.tsx                # echarts wrapper
        ParameterInspector.tsx              # dispatch on type
        inspectors/
          StableInspector.tsx
          WeightedInspector.tsx
          StableSurgeInspector.tsx
          UniversalInspector.tsx            # fallback
        EventLog.tsx
        CompareToolbar.tsx                  # phase E
    api/pool/[chain]/[id]/
      events/route.ts                       # GET + POST
      state/route.ts                        # GET
  lib/
    abis/
      v3-vault.ts
      v3-fee-controller.ts
      v3-stable-pool.ts
      v3-weighted-pool.ts
      v3-stable-surge-hook.ts
      v2-base-pool.ts
      v2-stable-pool.ts
    contracts/
      v3-addresses.ts                       # VaultExplorer + FeeController per chain
      drpc-endpoints.ts                     # chain → drpc URL
    db.ts                                   # extend ensureSchema()
    drpc/
      client.ts                             # viem fallback + p-limit
      get-logs.ts                           # chunked getLogs with retry
      block-timestamps.ts                   # eth_getBlockByNumber, in-memory dedupe per sync
    pool-events/
      decode.ts                             # event decoders per type
      sync.ts                               # tail-sync orchestration
      types.ts                              # decoded event shapes
    pool-state/
      read.ts                               # multicall dispatch per pool type
      types.ts
```

---

## 13. Decision asked

Approve the plan as written. If approved, Phase A begins with:

1. DB schema extensions (`pool_param_events`, `pool_sync_state`) in `lib/db.ts` `ensureSchema()`
2. drpc env var + chain endpoint map
3. viem client factory with fallback transport + p-limit
4. Three route handler skeletons returning empty / dummy responses
5. ABI scaffolding (empty exports, ready for Phase B)

Phase B then validates the full pipeline end-to-end on one Stable pool before any other pool type is wired.
