'use client'

import { SimpleGrid } from '@chakra-ui/react'
import { KpiCard } from '../../_components/KpiCard'
import { usd } from '../../_components/format'
import { useMerklRewards } from '@analytics/lib/hooks/useMerklRewards'
import type { PortfolioSummary } from '@analytics/lib/hooks/usePortfolioByAddress'

const pct = (n: number, digits = 2) => `${(n * 100).toFixed(digits)}%`

export function PortfolioKpiStrip({
  summary,
  address,
}: {
  summary: PortfolioSummary
  address: string
}) {
  // Format share-of-TVL with a sensible precision: most wallets are well
  // under 0.1% so showing 4 digits keeps the number meaningful instead of
  // rounding everyone down to "0.00%".
  const shareLabel = formatShare(summary.shareOfProtocolTvl)
  // BAL emissions stopped and Aura is decommissioned, so the headline daily
  // earnings number is now fees + IB yield only. Reward APR items still get
  // shown per-position in the table for the rare pools that carry them.
  const dailyFlow = summary.dailyFeesUsd + summary.dailyYieldUsd
  const flowApr = summary.totalUsd > 0 ? (dailyFlow * 365) / summary.totalUsd : 0
  const dailyPct = summary.totalUsd > 0 ? dailyFlow / summary.totalUsd : 0

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
        label="Share of Balancer TVL"
        sub={
          summary.protocolTvl > 0
            ? `${usd(summary.totalUsd)} of ${usd(summary.protocolTvl)}`
            : 'Protocol TVL unavailable'
        }
        textured
        tooltip="Position value as a fraction of total Balancer TVL across all supported chains."
        value={shareLabel}
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
        label="Merkl unclaimed"
        sub={
          merklCount > 0
            ? merklTokens
              ? `${merklCount} token${merklCount === 1 ? '' : 's'} · ${merklTokens}${merklCount > 3 ? '…' : ''}`
              : `${merklCount} token${merklCount === 1 ? '' : 's'}`
            : 'No active reward campaigns'
        }
        textured
        tooltip="Unclaimed Merkl rewards across Balancer-supported chains. Includes amounts already vested but not yet claimed; pending (still vesting) amounts are listed in the Merkl card below."
        value={merklTotal > 0 ? usd(merklTotal) : '—'}
      />
    </SimpleGrid>
  )
}

function formatShare(share: number): string {
  if (!Number.isFinite(share) || share <= 0) return '—'
  if (share >= 0.01) return `${(share * 100).toFixed(2)}%`
  if (share >= 0.0001) return `${(share * 100).toFixed(4)}%`
  return '< 0.0001%'
}

function formatUsd(n: number): string {
  if (!Number.isFinite(n) || n === 0) return '$0'
  return usd(n)
}
