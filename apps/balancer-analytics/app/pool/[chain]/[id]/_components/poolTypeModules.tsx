/**
 * Pool-type module registry — declarative list of cards that render between
 * the snapshot/history bento and the state panel on the pool detail page.
 *
 * Each entry owns its own gating predicate (`shouldRender`) so adding a new
 * pool-type-specific card (Autorange, LBP timeline, ...) is one entry here
 * plus the component — `PoolPageView` does not need to grow more `&&` chains.
 *
 * Modules run in declaration order. The order-flow module renders first so
 * the universal "where does swap volume come from?" view is always the lead
 * insight; pool-type-specific modules follow underneath.
 *
 * Note: boosted-pool buffer content lives inside `PoolStatePanel`'s Current
 * state grid (as `BufferSection` cards) rather than as a top-level module
 * here — buffer composition + wrapper capacity belongs with the other
 * "current parameters" sections visually, not as a separate page-level card.
 */

import type { PoolPageData } from '../page'
import { PoolOrderFlow } from './PoolOrderFlow/PoolOrderFlow'

type PoolTypeModule = {
  key: string
  shouldRender: (data: PoolPageData) => boolean
  render: (data: PoolPageData) => React.JSX.Element
}

export const POOL_TYPE_MODULES: readonly PoolTypeModule[] = [
  {
    key: 'order-flow',
    // CowAmm pools route 100% of flow through CowSwap; the Sankey is trivial.
    shouldRender: ({ poolDetail }) => poolDetail.type !== 'COW_AMM',
    render: ({ poolDetail, snapshots }) => (
      <PoolOrderFlow
        chain={poolDetail.chain}
        poolId={poolDetail.id}
        poolTokens={poolDetail.tokens}
        poolTvlUsd={snapshots[snapshots.length - 1]?.totalLiquidity ?? 0}
      />
    ),
  },
]
