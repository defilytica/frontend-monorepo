'use client'

import { SimpleGrid } from '@chakra-ui/react'
import { KpiCard } from '../../_components/KpiCard'
import { usd } from '../../_components/format'
import { useMerklRewards } from '@analytics/lib/hooks/useMerklRewards'
import type {
  PortfolioSummary,
  TokenAggregate,
} from '@analytics/lib/hooks/usePortfolioByAddress'

const pct = (n: number, digits = 2) => `${(n * 100).toFixed(digits)}%`

export function PortfolioKpiStrip({
  summary,
  tokens,
  address,
}: {
  summary: PortfolioSummary
  tokens: TokenAggregate[]
  address: string
}) {
  // BAL emissions stopped and Aura is decommissioned, so the headline daily
  // earnings number is now fees + IB yield only. Reward APR items still get
  // shown per-position in the table for the rare pools that carry them.
  const dailyFlow = summary.dailyFeesUsd + summary.dailyYieldUsd
  const flowApr = summary.totalUsd > 0 ? (dailyFlow * 365) / summary.totalUsd : 0
  const dailyPct = summary.totalUsd > 0 ? dailyFlow / summary.totalUsd : 0

  // Top token across the whole portfolio — surfaces the wallet's largest
  // single-asset exposure at a glance ("this fund is mostly WETH"). Tokens
  // is pre-sorted by valueUsd desc in usePortfolioByAddress.
  const topToken = tokens[0]
  const topShare = topToken && summary.totalUsd > 0 ? topToken.valueUsd / summary.totalUsd : 0
  const tokenCount = tokens.length

  const merkl = useMerklRewards(address)
  const merklTotal = merkl.payload?.totalUnclaimedUsd ?? 0
  const merklCount = merkl.payload?.rewards.length ?? 0
  const merklTokens = merkl.payload?.rewards.slice(0, 3).map(r => r.symbol).join(', ')

  return (
    <SimpleGrid columns={{ base: 1, md: 2, lg: 4 }} spacing="md">
      <KpiCard
        label="Total LP value"
        sub={`${formatUsd(summary.walletUsd)} wallet · ${formatUsd(summary.stakedUsd)} staked`}
        textured
        tooltip="Sum of wallet-held and staked BPT positions across Balancer v2, v3 and CoW AMM."
        value={usd(summary.totalUsd)}
      />
      <KpiCard
        label="Top token exposure"
        sub={
          topToken
            ? `${formatUsd(topToken.valueUsd)} · ${tokenCount} token${tokenCount === 1 ? '' : 's'} total`
            : 'No token exposure'
        }
        textured
        tooltip="Largest single-token exposure across all positions, computed by multiplying each pool's token composition by the user's share of the pool. The % shows how concentrated the portfolio is in that one asset."
        value={topToken ? `${topToken.symbol} ${pct(topShare)}` : '—'}
      />
      <KpiCard
        label="Est. daily yield"
        sub={`Blended APR ${pct(flowApr)} (${pct(dailyPct, 4)}/day)`}
        textured
        tooltip="Projected daily earnings from swap fees + interest-bearing token yield, based on each pool's most recent APR reading."
        value={usd(dailyFlow)}
      />
      <KpiCard
        isLoading={merkl.loading}
        label="Unclaimed incentives"
        sub={
          merklCount > 0
            ? merklTokens
              ? `${merklCount} token${merklCount === 1 ? '' : 's'} · ${merklTokens}${merklCount > 3 ? '…' : ''}`
              : `${merklCount} token${merklCount === 1 ? '' : 's'}`
            : 'No active campaigns'
        }
        textured
        tooltip="Unclaimed reward tokens across Balancer-supported chains. Currently sources from Merkl campaigns; gauge claimables are listed in the Incentive Rewards card below."
        value={merklTotal > 0 ? usd(merklTotal) : '—'}
      />
    </SimpleGrid>
  )
}

function formatUsd(n: number): string {
  if (!Number.isFinite(n) || n === 0) return '$0'
  return usd(n)
}
