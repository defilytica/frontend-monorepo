# Pool Explorer — Phase B Handoff

Working notes from the session that built Phases A + B of the pool parameter timeline. Read this **after** `POOL_EXPLORER_DESIGN.md` (which has the architectural intent).

Dated 2026-05-18.

---

## TL;DR

`apps/balancer-analytics` now has a per-pool detail page at `/pool/[chain]/[id]` that visualizes parameter changes (fee adjustments, amp ramps, pause toggles, surge config…) on the same time axis as TVL/volume/fees over 90 days. Built on Postgres-cached on-chain log scans through drpc, plus VaultExplorer / pool-contract multicall reads for current state.

Phase B is **feature complete**. The one known data issue (§8) was **resolved on 2026-05-19** — root cause was a poisoned sync watermark, fixed structurally with a self-healing cold-floor rescan.

---

## 1. Routes

| Route | Purpose |
|---|---|
| `app/pool/[chain]/[id]/page.tsx` | Server component — pool detail page |
| `app/pool/[chain]/[id]/loading.tsx` | "Indexing pool parameter changes" throbber |
| `app/api/pool/[chain]/[id]/events/route.ts` | `GET` (paged events) + `POST` (force re-sync) |
| `app/api/pool/[chain]/[id]/state/route.ts` | `GET` current pool state via multicall |

URL forms accepted everywhere:
- 42-char address (`0x` + 40 hex) — V3 canonical
- 66-char V2 poolId (`0x` + 64 hex)

The page resolves the canonical api-v3 `id` internally (falls back to `poolGetPools` by `addressIn` when only the 42-char address is supplied for a V2 pool). On-chain calls always use the 20-byte slice.

`?refresh` on the URL forces a re-sync past the 30s TTL.

---

## 2. Data flow

```
Browser
  └── page.tsx (server component)
       ├── api-v3 poolGetPool          (metadata for the header)
       ├── api-v3 poolGetSnapshots(90d) (TVL / volume / fees series)
       ├── syncPoolEvents(chain, addr)  (drpc — populates pool_param_events)
       ├── readUniversalV3State / readV2BasePoolState
       └── readStableTypeState  / readV2StableTypeState  (when STABLE)
```

`syncPoolEvents` flow:
1. `ensureSchemaOnce()` lazy-bootstraps the schema
2. TTL check (30s) → serve DB rows if fresh
3. Resolve metadata from api-v3 (cached 5m)
4. Compute `fromBlock` — warm = `watermark+1`, cold = 90-day cap clamped to pool createTime
5. **Filter A + Filter B run in parallel** with independent `.catch` (one failure doesn't drop the other's events)
6. Resolve unique block timestamps via `eth_getBlockByNumber`
7. Decode logs → `insertPoolParamEvents` (idempotent on UNIQUE constraint)
8. Advance `pool_sync_state.last_block` **only if both filters succeeded**

---

## 3. File map

```
apps/balancer-analytics/
├── app/
│   ├── api/pool/[chain]/[id]/
│   │   ├── events/route.ts         GET + POST events
│   │   └── state/route.ts          GET state
│   └── pool/[chain]/[id]/
│       ├── page.tsx                Server component, parallel fetch
│       ├── loading.tsx             Throbber boundary
│       └── _components/
│           ├── PoolPageView.tsx          Layout orchestrator
│           ├── PoolHistoryChart.tsx      Echarts (TVL/vol/fees + event markers + amp markArea)
│           ├── PoolStatePanel.tsx        Current state (V2 + V3 dispatch)
│           ├── PoolEventLog.tsx          PaginatedTable + category filters
│           ├── eventStyles.ts            Per-event color + pin label + legend label registry
│           └── formatEventArgs.ts        Shared %/amp/time arg formatter
├── lib/
│   ├── abis/                       Hand-curated event ABIs (used by parseAbi via event-signatures.ts) + deployed JSON ABIs
│   ├── contracts/
│   │   ├── drpc-endpoints.ts       Wraps @repo/lib's drpcUrl with public-RPC fallback
│   │   └── v3-addresses.ts         VaultExplorer + ProtocolFeeController + StableSurgeHook per chain
│   ├── drpc/
│   │   ├── client.ts               Memoized viem PublicClient (per-chain, p-limit(4))
│   │   ├── get-logs.ts             chunkedGetLogs — parallel chunks + split-on-range + retry-on-transient + scrub-on-throw
│   │   ├── block-timestamps.ts     eth_getBlockByNumber with in-call dedupe
│   │   └── scrub.ts                scrubSecret / scrubError — strips drpc key from log lines
│   ├── pool-events/
│   │   ├── event-signatures.ts     parseAbi blocks for tracked events (single source of truth for sync queries)
│   │   ├── sync.ts                 Orchestrator — TTL, fetch metadata, run filters, decode, persist
│   │   ├── decode.ts               Viem logs → PoolParamEventRow[]
│   │   ├── initial-cap.ts          90-day fromBlock per chain
│   │   └── types.ts                Wire types
│   └── pool-state/
│       └── read.ts                 readUniversalV3State / readStableTypeState / readV2BasePoolState / readV2StableTypeState
└── POOL_EXPLORER_DESIGN.md         Architectural intent (read first)
```

---

## 4. Tracked events (per filter group)

### Filter A — indexed-pool events (one `eth_getLogs` per chunk)

Addresses queried: V3 Vault + ProtocolFeeController + both StableSurge hooks (active + legacy).

**V3 Vault** (`0xbA1333…ba9`):
- `SwapFeePercentageChanged`
- `AggregateSwapFeePercentageChanged`
- `AggregateYieldFeePercentageChanged`
- `PoolPausedStateChanged`
- `PoolRecoveryModeStateChanged`
- `PoolRegistered` (t0 anchor)

**V3 ProtocolFeeController** (per-chain):
- `PoolCreatorSwapFeePercentageChanged`
- `PoolCreatorYieldFeePercentageChanged`
- `ProtocolSwapFeePercentageChanged`
- `ProtocolYieldFeePercentageChanged`
- `InitialPoolAggregateSwapFeePercentage` (t0)
- `InitialPoolAggregateYieldFeePercentage` (t0)
- `PoolRegisteredWithFeeController` (t0)

**V3 StableSurgeHook** (per-chain):
- `ThresholdSurgePercentageChanged`
- `MaxSurgeFeePercentageChanged`
- `StableSurgeHookRegistered` (t0)

### Filter B — pool-emitted events (`address = poolAddress`)

**V3 STABLE**: `AmpUpdateStarted`, `AmpUpdateStopped`

**V2 base (all V2 types)**:
- `SwapFeePercentageChanged`
- `PausedStateChanged`
- `RecoveryModeStateChanged`
- `ProtocolFeePercentageCacheUpdated`

**V2 STABLE / COMPOSABLE_STABLE**: + `AmpUpdateStarted`, `AmpUpdateStopped`

---

## 5. DB schema (Postgres / Neon, in `lib/db.ts`)

Three tables, all idempotently created by `ensureSchema()`:

```sql
pool_param_events
  PK id (BIGSERIAL)
  UNIQUE (chain, pool_address, block_number, log_index)
  cols: chain TEXT, pool_address TEXT, protocol_version SMALLINT,
        block_number BIGINT, block_timestamp BIGINT, log_index INT,
        tx_hash TEXT, event_name TEXT, args JSONB, captured_at TIMESTAMPTZ
  ix:   (chain, pool_address, block_number)
        (chain, pool_address, event_name)

pool_sync_state
  PK (chain, pool_address)
  cols: last_block BIGINT, last_synced_at TIMESTAMPTZ,
        deep_synced BOOLEAN NOT NULL DEFAULT false   -- §15: full-history scan done
  (deep_synced added via idempotent ALTER in ensureSchema; monotonic —
   latches true on a successful full-history scan, never flips back)

protocol_snapshots         (pre-existing, untouched)
```

Inserts use `INSERT ... ON CONFLICT DO NOTHING` so re-runs are safe. Watermark only advances on full sync success.

---

## 6. Environment

Required server-side env vars:

```
NEXT_PRIVATE_DRPC_KEY=<balancer org-wide drpc key>
DATABASE_URL=<neon postgres url>     # auto-injected by Vercel Marketplace
```

Same `NEXT_PRIVATE_DRPC_KEY` as `frontend-v3`'s rpc proxy — one value covers both apps.

drpc URL format follows `@repo/lib`'s `drpcUrl()`: `https://lb.drpc.live/<network>/<key>`.

Already registered in `turbo.json globalEnv`. `.env.template` updated.

---

## 7. Drpc cost model (verified)

| Scenario | Requests / month | Cost @ $6/M |
|---|---|---|
| Steady state (6k visits, 99% warm) | ~30k | $0.18 |
| Bootstrap month (200/day, 30% cold) | ~300k | $1.80 |
| Pathological (every pool cold on Arbitrum) | ~470k | $2.81 |

Negligible against the org-wide drpc bill. Guard rails in place (90-day cap, 30s TTL, in-flight dedupe, p-limit(4) per chain, fallback transport) are about latency / reliability, not cost.

---

## 8. RESOLVED (2026-05-19) — poisoned watermark stranded events

**Pool:** `/pool/ethereum/0x1ea5870f7c037930ce1d5d8d9317c670e89e13e3` (rETH / Aave WETH, V3 STABLE)

**Root cause — none of the original hypotheses; it was the sync watermark.**

Triage (isolated probes against drpc + the live DB) ruled out every hypothesis in the old plan:

- viem `getLogs({ events: parseAbi([...]) })` decoded the `AmpUpdateStarted` log **perfectly** (topic0 matched, args `{50000,100000,1776438275,1776898800}`). Topic-encoding hypothesis: **false**.
- `decodeLogsToRows` would have kept it (clean args, block/logIndex/txHash present). Decoder-drop hypothesis: **false**.
- `chunkedGetLogs` over the *exact* cold-start range returned the event reliably. Range-math / chunker hypothesis: **false**.

The DB showed the real cause: `pool_param_events` had **0 rows** for the pool, while `pool_sync_state.last_block` had advanced to **25124456** — 224k blocks *past* the amp event at block **24900352**. An earlier sync (before this pool type's Filter B was wired / before the independent-filter fix landed the same day) advanced the watermark while capturing nothing. After that, every warm sync computed `fromBlock = watermark + 1`, permanently *past* the event. **No self-healing path existed**, and — critically — `?refresh`/`force` only bypassed the 30s TTL; it did **not** reset the scan floor, so the documented recovery in the old triage plan could never have worked.

**Fix (structural, self-healing) — `lib/pool-events/sync.ts` + `lib/db.ts`:**

`runSync` now rescans from the cold floor (90-day cap clamped to `createTime`) instead of `watermark + 1` when **either**:

1. `options.force` — POST `/events` or `?refresh`. Force now means "full re-scan", not "skip the cache", so the documented recovery path actually works.
2. **Poisoned watermark** — a `pool_sync_state` row exists but `countPoolParamEvents() === 0`. This is the exact signature of the bug; the next post-TTL visit self-heals with zero user action. The 30s TTL fast-path still throttles a legitimately-empty pool to ≤1 cold scan per window (~$0.0004 on mainnet — negligible per §7).

Cold rescans are safe and cheap: `insertPoolParamEvents` is idempotent on the UNIQUE constraint, so re-scanning a range we already have only costs RPC budget, never duplicate rows.

**Verified end-to-end:** a plain GET (no force) on the poisoned pool auto-healed — recovered **3 stranded events** (the missing `AmpUpdateStarted` at 24900352 + two Filter A fee events at 24950568), all persisted to `pool_param_events`. The `[sync] log scan complete` diagnostic now carries `rescanFromCold`, `poisonedWatermark`, `persistedCount`, `forced` so any future recurrence is triageable from one terminal line.

---

## 9. Surface inventory — what's working

### Page chrome
- Header: protocol-version badge + pool-type badge + chain badge + pool name + token symbols + "Open in balancer.fi →" link + short address
- Throbber on cold sync ("Indexing pool parameter changes")
- Top navbar links work from any page (root-relative `/#section`)
- PoolExplorer (home page) rows link into `/pool/[chain]/[id]` using the canonical api-v3 `id` so V2 pools resolve correctly in one shot

### Main 90-day chart (`PoolHistoryChart`)
- Line: TVL with gradient fill
- Bars: volume24h + fees24h (stacked)
- Per-event pin markers — color-coded, abbreviated label, alternating vertical offset for adjacent same-day events
- Vertical dashed lines (markLine) at every event for visibility regardless of TVL value
- markArea for amp ramps (AmpUpdateStarted.startTime → endTime)
- Rich hover tooltip with decoded args (percentages as `0.05%`, amp values, timestamps)
- Filter chip strip above the chart — one chip per unique event name, frontend-v3-styled
- Custom tooltip on map points showing full event details

### State panel (`PoolStatePanel`)
- Status badge: active / paused / recovery
- V3 path: swap fee, aggregate swap fee, aggregate yield fee, amp factor + ramp schedule (Stable), pool-creator fees when set
- V2 path: swap fee, protocol swap fee cache, protocol yield fee cache (when non-zero), pause window end, amp factor (Stable / ComposableStable)
- Two-card hierarchy (level1 outer, subSection inner) matching PoolExplorer

### Event log (`PoolEventLog`)
- `@repo/lib`'s `PaginatedTable` with Grid-based rows
- Pagination footer (10/25/50/100 per page)
- Category filter chips (Fees / Amp / Pause-Recovery / Surge / Rate / Registration)
- Args column: multi-line key/value with formatted values (`0.05%`, `200`, `May 18, 12:30`)
- Each row: colored dot + readable label + raw event name + tx hash → block explorer link

### Pool-type coverage

| Pool type | Events tracked | Helper-contract state |
|---|---|---|
| V3 STABLE | Vault + FeeController + Surge hook + AmpUpdate | Universal + amp factor + ramp + StableSurge hook (when attached) |
| V3 WEIGHTED | Vault + FeeController | Universal + normalized weights |
| V3 GYROE | Vault + FeeController + Surge hook | Universal + ECLP params (alpha/beta/c/s/lambda) |
| V3 RECLAMM | Vault + FeeController | Universal + price ratio + centeredness + shift exponent + range badge + price-ratio schedule |
| V3 LIQUIDITY_BOOTSTRAPPING | Vault + FeeController | Universal + current weights + swap-enabled badge + gradual weight schedule |
| V3 QUANT_AMM_WEIGHTED | Vault + FeeController | Universal + dynamic weights + fix-window badge + oracle staleness |
| V3 GYRO / GYRO3 / others | Vault + FeeController + Surge hook | Universal only (2CLP/3CLP ABIs not yet verified — no live pool found) |
| V2 STABLE / COMPOSABLE_STABLE | V2 base + AmpUpdate | V2 base + amp factor |
| V2 WEIGHTED / others | V2 base | V2 base |

### Chains with full helper-contract addresses
Mainnet · Base · Arbitrum · Optimism · Gnosis · Avalanche · **Plasma** · **Monad** · **HyperEVM**. Polygon, Fraxtal, Mode, ZkEVM have zero V3 pools (V3 not deployed). Sonic has live V3 but is blocked on both `balancer-deployments` cataloguing and `PROJECT_CONFIG.supportedNetworks` inclusion — see `v3-addresses.ts` comments.

---

## 10. Operational behavior

- **Cold start**: 1–2 minutes for a 90-day mainnet scan with active vault. Throbber covers this. Subsequent visits are <1s (TTL fast path or short tail sync).
- **drpc errors**: chunker retries transient 5xx/code-19 with backoff 300ms / 800ms / 2000ms, splits range on too-large. Independent Filter A/B means one filter's failure doesn't drop the other's events.
- **Cache layering**: 30s TTL on `pool_sync_state` for the events sync; 60s edge cache on `/state`; 5m in-memory pool-metadata cache in `sync.ts`; api-v3 caches itself.

---

## 11. Security posture

Audited before this handoff:
- `.env.local` is gitignored and not tracked
- No literal drpc key or DB password in any tracked/untracked file
- All `console.*` calls in new code either go through `scrubError()` or only log validated route params (no error objects)
- `scrubAndThrow()` inside `chunkedGetLogs` removes the key from any error that escapes the chunker, so future callers can't accidentally leak through `console.error(err)`

---

## 12. Phase B → C handoff list

Outstanding work for the next session, in priority order:

1. ~~**Resolve the amp-event miss** (§8)~~ — ✅ **DONE 2026-05-19**. Poisoned watermark; structural self-healing fix shipped. See §8.
2. ~~**V3 type-specific state for ECLP / 2CLP / reCLAMM / QuantAMM / LBP**~~ — ✅ **DONE 2026-05-20**. Weighted (`getNormalizedWeights`), GyroECLP (`getECLPParams` → alpha/beta/c/s/lambda), reCLAMM (`computeCurrentPriceRatio` + centeredness + shift exponent + `getPriceRatioState` schedule + within-range badge), LBP (`getNormalizedWeights` + `isSwapEnabled` + `getGradualWeightUpdateParams`), QuantAMM (dynamic weights + fix-window + oracle staleness), and the StableSurge hook (threshold + max surge fee, additive on stable pools). Every signature was probed on a live pool before being committed (DESIGN §5). See §16. **2CLP/3CLP deferred** — no live `GYRO`/`GYRO3` V3 pools on probed chains at session time; revisit when one appears.
3. ~~**"Load full history" toggle**~~ — ✅ **DONE 2026-05-19**. `?fullHistory` server param widens both the event scan (→ deployment block) and the api-v3 snapshot series (→ `ALL_TIME`); `HistoryRangeToggle` button drives it. One-time deep scan latched via a new `pool_sync_state.deep_synced` column so repeat full-history views serve from the DB (~1.8s) instead of re-walking the chain (~28s). See §15.
4. ~~**Compare mode** (Phase E in design doc)~~ — ✅ **DONE 2026-05-20**. Two-cursor selection on the chart (click to arm A, click again for B, click again restarts; "Clear" button), with a comparison card below the chart showing TVL Δ%, volume + fees window sums, and the parameter diff (only changed params: swap fee, aggregate/protocol/creator fees, surge threshold & max surge, amp factor with linear interp during ramps, paused, recovery). Pure snapshot logic lives in `lib/pool-events/snapshot-at.ts` and was unit-tested against the rETH/Aave pool's real events. See §17.
5. ~~**Remaining chains** — populate `V3_HELPER_ADDRESSES`~~ — ✅ **DONE 2026-05-20**. **Plasma · Monad · HyperEVM** now have full helper-contract addresses (sourced from `balancer-deployments` consolidated `addresses/<chain>.json`, verified on-chain via `VaultExplorer.getVault() == 0xbA1333…ba9` on HyperEVM). All three render universal state + StableSurge hook params on real Surge pools. **Polygon, Fraxtal, Mode, ZkEVM** have zero V3 pools (V3 not deployed there — confirmed via api-v3) so they're intentionally absent. **Sonic** is documented as blocked on (1) `balancer-deployments` not cataloguing it and (2) absence from `PROJECT_CONFIG.supportedNetworks` — both need upstream changes.
6. ~~**Mobile breakpoint pass**~~ — ✅ **DONE 2026-05-20**. Event log switches to stacked labeled rows below `md` (no horizontal scroll); args list stacks key-over-value with `wordBreak`. State-panel `StateRow` allows value wrap (`flexWrap` + `textAlign="right"` + `wordBreak`); ramp / price-ratio schedule lines harden the same way. All `subSection` cards now use responsive `p={{base:'sm', md:'md'}}` to match the outer card. Touches: `_components/PoolEventLog.tsx`, `_components/PoolStatePanel.tsx`.

---

## 13. Commands cheatsheet

```bash
# Run dev (port 3002)
pnpm --filter balancer-analytics dev

# Typecheck (filter out pre-existing @sentry/nextjs noise in @repo/lib)
cd apps/balancer-analytics && pnpm exec tsc --project tsconfig.json --noEmit 2>&1 | grep -v "@sentry/nextjs"

# Lint
cd apps/balancer-analytics && pnpm exec eslint . --max-warnings 0 --cache

# Force a re-sync past TTL
curl -X POST 'http://localhost:3002/api/pool/ethereum/<address>/events' | jq '.events | length'
# Or via URL: append ?refresh

# Probe a pool's on-chain logs directly (debug)
HEAD=$(curl -s -X POST 'https://ethereum-rpc.publicnode.com' -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","method":"eth_blockNumber","id":1}' \
  | python3 -c "import json,sys; print(int(json.load(sys.stdin)['result'], 16))")
# walk chunks of 50k from $((HEAD-648000)) to $HEAD, log address=<pool>
```

---

## 14. Known-good test pools

| Chain | Address | Type | Notes |
|---|---|---|---|
| Mainnet | `0x85b2b559bc2d21104c4defdd6efca8a20343361d` | V3 STABLE | GHO/USDT/USDC — high activity, clean test |
<!-- V2 BAL8020 entry removed 2026-05-20 — api-v3 no longer indexes that pool by either 42- or 66-char id, AND the 42-char-address fallback path it tested was removed when api-v3 dropped `addressIn` from `GqlPoolFilter` (see §18). V2 pools now must be reached via their canonical 66-char poolId. -->
| Base | `0x4ee3b7bcac3a3636e362395f6dc9c4c64b530fd7` | V3 GYROE | USDC-AERO with fee changes every 30m — stress-tests pagination + filters |
| Monad | `0x2daa146dfb7eaef0038f9f15b2ec1e4de003f72b` | V3 STABLE | wnAUSD/wnUSDC/wnUSDT0 — verifies new chain wiring |
| Plasma | `0x01e2c7fcde2b8d5d1413732c4e274ba5b06b1e54` | V3 STABLE | Surge USDai-waUSDT0 — verifies §12 #5 Plasma helpers + StableSurge hook |
| HyperEVM | `0xc5619cfcce9fae18eda1d1e923aa1fdea42d93b7` | V3 STABLE | USDp-csbUSDC — verifies §12 #5 HyperEVM helpers (chain-specific addresses) |
| Mainnet | `0x1ea5870f7c037930ce1d5d8d9317c670e89e13e3` | V3 STABLE | rETH-Aave WETH — was the amp-event miss case (§8, now resolved + a §15 full-history test pool) |
| Base | `0x83470106402ed0bc83f91bb13266d35bdb23f1b9` | V3 WEIGHTED | §16 weighted smoke test (`getNormalizedWeights`) |
| Mainnet | `0x8fd6f02388a96223beab155e1e334704f939475d` | V3 GYROE | §16 ECLP smoke test (`getECLPParams` → alpha=10867.85…) |
| Base | `0x19aeb8168d921bb069c6771bbaff7c09116720d0` | V3 RECLAMM | §16 reCLAMM smoke test (cbBTC-WETH; `computeCurrentPriceRatio` + `getPriceRatioState`) |
| Base | `0x7eb68433938cda5fa79669162a59b8a1353bb73a` | V3 LBP | §16 LBP smoke test (`getGradualWeightUpdateParams` + `isSwapEnabled`) |
| Mainnet | `0x6b61d8680c4f9e560c8306807908553f95c749c5` | V3 QUANT_AMM_WEIGHTED | §16 QuantAMM smoke test (Safe Haven BTC:PAXG:USDC — dynamic weights + fix window) |

---

## 15. "Load full history" (2026-05-19)

Default view is 90 days. `?fullHistory` on the pool URL widens **both** lanes
consistently (POOL_EXPLORER_DESIGN.md §7):

- **Events** — `syncPoolEvents(..., { fullHistory: true })` scans from the
  pool's approx deployment block (api-v3 `createTime`), no 90-day floor.
- **Snapshots** — `poolGetSnapshots` range flips `NINETY_DAYS → ALL_TIME`.

Server-driven, mirroring `?refresh`. `HistoryRangeToggle` (client) just
`router.push`es the path with/without `?fullHistory` under a `useTransition`;
`loading.tsx` covers the first deep scan.

**One-time cost.** A `?fullHistory` request only does the expensive
deployment-block walk the *first* time. On success it latches
`pool_sync_state.deep_synced = true`; thereafter every full-history visit is
served on the normal warm/TTL path from the DB (the deep rows are already
persisted). Measured on the rETH/Aave pool: first deep scan **28s** (`from
block 23763305`, recovered 2 events older than 90 days), every subsequent
full-history view **~1.8s** (`cached: true`). `force` (`?refresh`/POST) still
re-deep-scans on demand for data corrections.

Guards:
- Unknown `createTime` → fall back to the 90-day cap, **do not** latch
  `deep_synced` (`scannedFullHistory` gates the latch) — avoids a
  genesis-to-head scan and avoids marking an incomplete timeline as deep.
- `deep_synced` is monotonic (`OR` in the upsert) — a later partial/tail
  sync can't un-latch it.

Diagnostic `[sync] log scan complete` now also carries `fullHistory`,
`needDeepScan`, `scannedFullHistory` alongside the §8 fields.

Files touched: `lib/pool-events/sync.ts`, `lib/db.ts` (schema + helpers),
`app/pool/[chain]/[id]/page.tsx`, `_components/PoolPageView.tsx`,
`_components/HistoryRangeToggle.tsx` (new), `events/route.ts`, `loading.tsx`.

Test: `/pool/ethereum/0x1ea5870f7c037930ce1d5d8d9317c670e89e13e3?fullHistory`
(5 events full vs 3 in the 90-day window).

---

## 16. V3 type-specific state (2026-05-20)

Phase B shipped only Stable's amp factor + ramp. §16 extends the
`PoolStatePanel` lower section to every V3 pool type the analytics app
supports, populated by helper-contract reads dispatched on
`poolDetail.type` (DESIGN §6).

### Coverage

| Pool type | Source | Surfaced params |
|---|---|---|
| WEIGHTED | pool `getNormalizedWeights()` | Per-token weight % (zipped with token symbols) |
| GYROE | pool `getECLPParams()` | alpha (lower price bound) · beta (upper) · lambda (stretch) · c · s |
| RECLAMM | pool: `computeCurrentPriceRatio` · `getCenterednessMargin` · `getDailyPriceShiftExponent` · `isPoolWithinTargetRange` · `getPriceRatioState` | Current price ratio · centeredness margin % · daily price shift % · range badge · update schedule (start/end fourth-root ratio + times) |
| LIQUIDITY_BOOTSTRAPPING | pool: `getNormalizedWeights` · `isSwapEnabled` · `getGradualWeightUpdateParams` | Current weights · swap-enabled badge · gradual weight schedule (per-token start → end + times) |
| QUANT_AMM_WEIGHTED | pool: `getNormalizedWeights` · `getWithinFixWindow` · `getOracleStalenessThreshold` | Dynamic weights · fix-window badge · oracle window |
| STABLE / COMPOSABLE_STABLE | StableSurge hook (active + legacy fallback): `getSurgeThresholdPercentage(pool)` · `getMaxSurgeFeePercentage(pool)` | Surge threshold % · max surge fee % (additive — self-nulls when no hook attached) |

2CLP / 3CLP (`GYRO` / `GYRO3`) deferred — no live pool found on the
probed chains at session time; ABIs would be guesswork against DESIGN
§5's "hand-curated, verified" mandate. Adding later requires a live pool
to probe.

### Implementation

- **`lib/pool-state/read.ts`** — six new `parseAbi` consts
  (`V3_WEIGHTED_ABI`, `V3_GYRO_ECLP_ABI`, `V3_RECLAMM_ABI`, `V3_LBP_ABI`,
  `V3_QUANT_AMM_ABI`, `V3_STABLE_SURGE_HOOK_ABI`), six readers
  (`readWeightedTypeState`, `readGyroEclpTypeState`,
  `readReclammTypeState`, `readLbpTypeState`, `readQuantAmmTypeState`,
  `readStableSurgeState`). Each is one `multicall` (or `readContract`)
  with `allowFailure: true`; returns `null` on the primary call missing
  so the panel gracefully degrades to universal state (DESIGN §10.5).
  StableSurge probes every configured hook on the chain (active +
  legacy) and uses the first that answers.
- **`app/pool/[chain]/[id]/page.tsx`** — `PoolPageData.state` gains
  `weighted | gyroEclp | reclamm | lbp | quantAmm | stableSurge`. The
  V3 dispatch fans out universal + type-specific reads in one
  `Promise.all`; type read fires only when `poolDetail.type` matches.
  A small `rescue<T>` generic helper folds the four prior ad-hoc
  `.catch(err => { logRpcError(...); return null })` blocks into one.
- **`_components/PoolStatePanel.tsx`** — `TypeSection` wrapper +
  per-type section components (`WeightedSection`, `GyroEclpSection`,
  `ReclammSection`, `LbpSection`, `QuantAmmSection`,
  `StableSurgeSection`), `WeightRows` (zipped with token symbols),
  formatters (`formatScaled` for 1e18 → decimal, `formatWeightPct`,
  `formatDuration`). Sections render in the right rail between the
  universal V3 card and the V2 card.

### Signature verification

Every ABI was decoded against a real on-chain pool before being
committed:

| Type | Pool | Decoded sample |
|---|---|---|
| WEIGHTED | Base `0x8347…f1b9` | weights `[0.x, 0.y, …]` × n tokens |
| GYROE | Mainnet `0x8fd6…475d` | alpha=10867.84, beta=10963.49, lambda=1086.78, c=6.1e-17, s=1.0 |
| RECLAMM | Base `0x19ae…20d0` | priceRatio=2.076, centeredness=0.5, shift=0.10/d, inRange=true |
| LBP | Base `0x7eb6…b73a` | weights [0.9,0.1], swapEnabled=false, schedule [0.02,0.98]→[0.9,0.1] |
| QUANTAMM | Mainnet `0x6b61…49c5` | weights [0.65,0.03,0.32], inFixWindow=true, stale=86760s |
| STABLE_GHO | Mainnet `0x85b2…361d` | surge hook present, threshold + max surge populated |

Warm page loads measured at 1.1–2.5 s across all six pools.

Files touched: `lib/pool-state/read.ts`,
`app/pool/[chain]/[id]/page.tsx`,
`app/pool/[chain]/[id]/_components/PoolStatePanel.tsx`.

---

## 17. Compare mode (2026-05-20)

POOL_EXPLORER_DESIGN.md §7.4 · Phase E. Two-cursor selection on the chart
answers "what changed between these two points, and what did the metrics
do over that window?"

### Interaction

The chart now binds a low-level zrender `click` handler (caught anywhere
inside the plot grid, not just on series points). Cycle:

| Existing cursors | Click | Result |
|---|---|---|
| none | anywhere on plot | sets **A** |
| A only | anywhere on plot | sets **B** (toolbar normalizes order) |
| A + B | anywhere on plot | restarts: new **A**, **B** cleared |
| — | "Clear" button | both cleared |

Cursors render as solid `markLine`s on the TVL series with `A` / `B`
pill labels. The chart's CSS cursor flips to `crosshair` when an
`onCursorClick` handler is wired so users see the affordance on hover.

### What the panel shows

`CompareModeToolbar.tsx` (new, client) renders below the chart card and
above the event log:

- **Window header** — A/B dates + duration in days, plus the Clear button.
- **Metric deltas** (3-up grid):
  - TVL: `tvlA → tvlB` with `±Δ%` and absolute change
  - Volume: sum of `volume24h` over inclusive `[A, B]`
  - Fees: sum of `fees24h` over inclusive `[A, B]`
- **Parameter diff** — only fields that actually changed, with a colored
  category dot (fee / amp / surge / state) and `before → after` badges:
  Swap fee, Aggregate swap/yield fee, Pool-creator + Protocol fees, Surge
  threshold + Max surge fee, Amp factor (with mid-ramp linear
  interpolation), Paused, Recovery mode.

If only A is set, the toolbar collapses to a small arming hint
("Cursor A set at ⟨date⟩. Click another point to compare.").

### Snapshot logic

`lib/pool-events/snapshot-at.ts` (pure, no React) exports:

- `computeParamSnapshot(events, t)` — walks events ≤ `t` in
  `(blockTimestamp, logIndex)` order, applies each tracked event to a
  running param record, then resolves the amp value at `t` with linear
  BigInt interpolation when inside an active `AmpUpdateStarted` window.
- `interpolateTvl(snapshots, t)` — linear interp between surrounding
  daily buckets (mirrors the chart's own `tvlAt` so cursor markers and
  the panel always agree).
- `sumWindow(snapshots, ta, tb, key)` — inclusive daily-bucket sum.
- `diffSnapshots(a, b)` — returns only the entries that differ, each
  with label + hint + category for the panel renderer.

### Verification

Unit-tested against the rETH/Aave pool's 5 real persisted events:

- Snapshot before any event → `{}`
- Snapshot after the AmpUpdateStarted but past `endTime` →
  `ampValue = endValue`, `ampIsRamping = false`
- Mid-ramp interpolation at the timestamp midpoint of `50000 → 100000`
  → 74999 (off-by-one from integer math at the chosen midpoint, correct)
- `diffSnapshots` surfaces all four real changes with clean labels:
  Swap fee · Aggregate swap fee · Protocol swap · Amp factor
- `sumWindow` / `interpolateTvl` exact on a synthetic 10-day series

Files touched: `lib/pool-events/snapshot-at.ts` (new),
`_components/CompareModeToolbar.tsx` (new),
`_components/PoolHistoryChart.tsx` (cursor markLines + zrender click),
`_components/PoolPageView.tsx` (cursor state + toolbar render).

---

## 18. Loud `gqlFetch` + api-v3 schema-drift fix (2026-05-20)

**Reported symptom.** A user-known-good URL
(`/pool/ethereum/0x6b31a94029fd7840d780191b6d63fa0d269bd883`,
`Balancer Surge Fluid wstETH-wETH`, V3 STABLE) suddenly returned a 404.

**Diagnosis.** Two compounding issues, both hidden behind the same
generic dev-log line `[pool/page] 404: api-v3 has no pool for input id`:

1. **Cloudflare 1015 rate-limit** on `api-v3.balancer.fi` triggered by
   the dev server's parallel codegen step + heavy testing. `fetch()`
   returned 429, `gqlFetch` did `if (!res.ok) return null` silently,
   page called `notFound()`. The user's URL worked again ~60s later
   without code changes.
2. **api-v3 dropped `addressIn` from `GqlPoolFilter`** (verified via
   introspection: only `idIn`, `chainIn`, `tokensIn`, `tagIn`,
   `poolTypeIn`, `protocolVersionIn` remain). The page's V2-by-42-char-
   address fallback (`POOL_BY_ADDRESS_QUERY`) issued an `addressIn`
   filter, api-v3 returned a 200 with `errors:
   [GRAPHQL_VALIDATION_FAILED]`, `gqlFetch` did `if (json.errors) return
   null` silently. This had been broken since the schema drift landed.

**Fix.**

- `gqlFetch` now logs non-OK HTTP responses (with `status` and the
  `Retry-After` header) and GraphQL `errors` arrays before returning
  `null`. Same loud-logging pattern applied to `sync.ts`'s
  `fetchPoolMetadata`. The page's 404 warning now also carries a
  `hint` field — for 42-char inputs that miss, it suggests the 66-char
  poolId form, the most common cause of legitimate-but-confusing 404s.
- Removed the dead `POOL_BY_ADDRESS_QUERY` block from `page.tsx`. The
  in-page comment now points at the introspection-verified replacement
  path. V3 pools still work via the by-id query (their id is the
  42-char address); V2 pools must be reached via their 66-char poolId
  (no general address-keyed lookup remains on api-v3).
- Removed the stale §14 BAL8020 test-pool entry — that pool is no
  longer indexed by api-v3 anyway, independent of the schema change.

**Verified.** The user's URL renders 200 in 1.3s (`Balancer Surge Fluid`
visible in the SSR'd payload). An intentional bad-pool URL now emits a
clean diagnostic trail in the dev log: GraphQL errors line above the
404 warning, so the next time api-v3 drifts or rate-limits, the cause
is one-glance triagable from the terminal.

Files touched: `app/pool/[chain]/[id]/page.tsx`,
`lib/pool-events/sync.ts`.

---

## 19. Data-loading + caching pass (2026-05-20)

After §18 the user reported "rate limits hit fast when going main →
pool repeatedly." Traced the api-v3 traffic and shipped five layered
fixes; the dashboard is now near-free on warm tabs and pool-page
click-arounds.

### Where the traffic actually was

| Source | Pre-fix | Post-fix |
|---|---|---|
| Pool-page server fetch (`poolGetPool` + `poolGetSnapshots`) | every visit, `cache: 'no-store'` | Next Data Cache, `revalidate: 60` (default) — repeat visits hit the cache. `?refresh` still bypasses via `forceFresh: true`. |
| `/api/snapshots`, `/api/biggest-swaps`, `/api/governance` | server-cached only; browser refetched on every nav | explicit `Cache-Control: public, max-age=N, stale-while-revalidate=M` on all three (60/300/600s). |
| `useProtocolSnapshots` (HeroKpiStrip + TvlOverviewChart) | `cache: 'no-store'`, doubled by StrictMode + dual consumers | module-level `Map<key, inflight \| settled>` + dropped `no-store`. Synchronous `useState` initializer when the cache has a fresh entry → no loading flicker on remount. |
| Apollo `InMemoryCache` | memory-only — wiped on hard refresh / new tab | opt-in `localStorage` persistence (24h TTL, version-gated, written on `visibilitychange` / `pagehide` / 5s post-mount). Analytics opts in via `persistKey="balancer-analytics-apollo-cache:v1"`; **frontend-v3/beets unchanged** — they don't pass `persistKey` so wallet apps with stale-cache concerns are unaffected. |
| **Dev codegen** | `graphql-codegen --watch` fetched the schema from api-v3 on every startup and document change → persistent Cloudflare 1015 in the dev log | `packages/lib/shared/services/api/schema.graphql` is now **tracked in git** and used as the default schema source. Refresh on demand with `pnpm --filter @repo/lib graphql:refresh-schema` (toggles `REFRESH_SCHEMA=1` so codegen pulls + writes back the file). |

### Layered cache stack the dashboard now has

```
landing-page Apollo query
  └─ Apollo cache-first (memory)
  └─ Apollo queryDeduplication
  └─ localStorage persist (24h, opt-in via persistKey)
  └─ network → api-v3

/api/snapshots fetch
  └─ useState initializer (synchronous)
  └─ module-level Map inflight/settled (60s TTL)
  └─ browser HTTP cache (max-age=60)
  └─ Next Data Cache (revalidate=600)
  └─ Postgres

pool-page poolGetPool / poolGetSnapshots
  └─ Next Data Cache (revalidate=60)
  └─ network → api-v3   (bypass via ?refresh / forceFresh: true)

dev codegen
  └─ packages/lib/shared/services/api/schema.graphql  (tracked file)
  └─ pnpm --filter @repo/lib graphql:refresh-schema   (manual refresh)
```

### Refresh schema workflow

Run when api-v3's GraphQL schema actually changes (rare):

```bash
pnpm --filter @repo/lib graphql:refresh-schema
```

This pulls the live schema from `NEXT_PUBLIC_BALANCER_API_URL`, writes
it to `packages/lib/shared/services/api/schema.graphql`, and
regenerates document types. Commit the updated schema file. Dev
startup (`pnpm dev`) never hits api-v3 again until the next refresh.

Files touched (across §19):
- `app/pool/[chain]/[id]/page.tsx` (#1: `next.revalidate` + `forceFresh`)
- `app/api/snapshots/route.ts`, `app/api/biggest-swaps/route.ts`,
  `app/api/governance/route.ts` (#2: Cache-Control headers)
- `lib/snapshots/useProtocolSnapshots.ts` (#3: module-level dedupe)
- `packages/lib/shared/services/api/apollo.client.ts`,
  `apollo-client-provider.tsx`,
  `apps/balancer-analytics/app/providers.tsx` (#4: opt-in Apollo
  localStorage persistence)
- `packages/lib/shared/services/api/codegen.ts`,
  `packages/lib/package.json`,
  `packages/lib/shared/services/api/schema.graphql` (#5: tracked
  schema + `REFRESH_SCHEMA=1` opt-in)
