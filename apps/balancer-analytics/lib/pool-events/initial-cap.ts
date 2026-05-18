/**
 * 90-day initial-history cap (see POOL_EXPLORER_DESIGN.md §8).
 *
 * On cold start we don't walk the full pool history — we cap at 90 days and
 * surface a "Load full history" affordance in the UI. The cap is computed
 * by `(head − blocksPerWindow)` using an average block time per chain.
 *
 * Average block times are intentionally pessimistic (slightly *high* where
 * uncertain) so we don't accidentally over-shoot and burn request budget on
 * a chain we mis-estimated. Sources: chain explorers, public block-time
 * dashboards.
 *
 * The cap is a *floor* — if api-v3 reports a `createTime` later than
 * `head − blocksPerWindow`, we start from the pool's actual deployment
 * block instead (no point scanning blocks before the pool existed). That
 * lookup happens in `sync.ts`, not here.
 */

import { GqlChain } from '@repo/lib/shared/services/api/generated/graphql'

/** Average block time in seconds per chain. */
const SECONDS_PER_BLOCK: Record<GqlChain, number> = {
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

export const NINETY_DAYS_SECONDS = 90 * 24 * 60 * 60

/**
 * Return the `fromBlock` for a 90-day cold-start scan, given the current head.
 * Never goes below 0n. Callers should clamp further if they know the pool's
 * deployment block.
 */
export function ninetyDayFromBlock(chain: GqlChain, head: bigint): bigint {
  const spb = SECONDS_PER_BLOCK[chain] ?? 12
  const blocks = BigInt(Math.ceil(NINETY_DAYS_SECONDS / spb))
  return head > blocks ? head - blocks : 0n
}
