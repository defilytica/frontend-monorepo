'use client'

import {
  Box,
  Button,
  ButtonGroup,
  Card,
  Flex,
  HStack,
  Heading,
  Spinner,
  Text,
  VStack,
} from '@chakra-ui/react'
import { useMemo, useState } from 'react'
import FadeInOnView from '@repo/lib/shared/components/containers/FadeInOnView'
import { NoisyCard } from '@repo/lib/shared/components/containers/NoisyCard'
import type { GqlChainValues } from '@repo/lib/config/networks'
import type { OrderFlowRange, OrderFlowResponse } from './api-types'
import { buildSankeyGraph } from './buildSankeyGraph'
import {
  CATEGORY_COLORS,
  formatCategory,
  formatPct,
  formatUsdCompact,
} from './format'
import { PoolOrderFlowSankey, type TokenMap } from './PoolOrderFlowSankey'
import {
  PoolOrderFlowDetailsModal,
  type SankeySelection,
} from './PoolOrderFlowDetailsModal'
import type { LabeledSwap, SourceCategory } from './types'
import { usePoolOrderFlowData } from './usePoolOrderFlowData'

const MIN_SWAPS_FOR_RENDER = 10
const MIN_USD_PER_SWAP = 100

const RANGE_DAYS: Record<OrderFlowRange, number> = { '24h': 1, '7d': 7, '30d': 30 }

const LEGEND_ORDER: readonly SourceCategory[] = [
  'aggregator',
  'intent',
  'direct',
  'market_maker',
  'mev_bot',
  'bridge',
  'unknown',
]

type PoolToken = {
  address: string
  symbol: string
  logoURI?: string | null
}

type Props = {
  chain: GqlChainValues
  poolId: string
  poolTokens: readonly PoolToken[]
}

/** Per-range slice of the 30d payload. Recomputed in-memory on each range
 *  toggle — no api-v3 roundtrip. */
type RangeView = {
  swaps: LabeledSwap[]
  volumeUsd: number
  labeledUsd: number
  labeledPct: number
}

function sliceByRange(
  data: OrderFlowResponse,
  range: OrderFlowRange,
  now: number
): RangeView {
  const cutoff = now - RANGE_DAYS[range] * 86400
  // The 30d view is special: don't re-filter, since `data.swaps` already
  // is the 30d set (and possibly capped narrower). Just return as-is.
  const swaps =
    range === '30d' ? data.swaps : data.swaps.filter(s => s.timestamp >= cutoff)
  let volumeUsd = 0
  let labeledUsd = 0
  for (const s of swaps) {
    volumeUsd += s.valueUSD
    if (s.source.category !== 'unknown') labeledUsd += s.valueUSD
  }
  return {
    swaps,
    volumeUsd,
    labeledUsd,
    labeledPct: volumeUsd > 0 ? labeledUsd / volumeUsd : 0,
  }
}

export function PoolOrderFlow({ chain, poolId, poolTokens }: Props) {
  const [range, setRange] = useState<OrderFlowRange>('7d')
  const [selection, setSelection] = useState<SankeySelection | null>(null)
  const { data, loading, error } = usePoolOrderFlowData(chain, poolId)

  const tokenMap = useMemo<TokenMap>(() => {
    const m: TokenMap = {}
    for (const t of poolTokens) {
      m[t.address.toLowerCase()] = { symbol: t.symbol, logoURI: t.logoURI ?? null }
    }
    return m
  }, [poolTokens])

  // Slice the 30d payload to the selected window. Cheap (one pass).
  // The component re-renders on every range click but never re-fetches.
  const view = useMemo<RangeView | null>(() => {
    if (!data) return null
    return sliceByRange(data, range, data.fetchedWindow.to)
  }, [data, range])

  // Aggregate the per-range slice into Sankey nodes/links.
  const graph = useMemo(() => {
    if (!view) return null
    return buildSankeyGraph(view.swaps, { minUsd: MIN_USD_PER_SWAP })
  }, [view])

  return (
    <FadeInOnView animateOnce={false}>
      <Card overflow="hidden" variant="level1">
        <NoisyCard
          cardProps={{ height: 'full', overflow: 'hidden' }}
          contentProps={{ display: 'flex' }}
        >
          <VStack
            align="stretch"
            h="full"
            p={{ base: 'sm', md: 'md' }}
            spacing="md"
            w="full"
          >
            <Header
              data={data}
              loading={loading}
              onRangeChange={setRange}
              range={range}
              view={view}
            />

            {view && view.swaps.length >= MIN_SWAPS_FOR_RENDER && graph && (
              <CategoryLegend graph={graph} />
            )}

            {/* Explicit height — this card stands alone in the page-level
                column (unlike PoolHistoryChart which sits in a horizontal
                Stack that anchors its height). Without a concrete height
                here the `flex: 1 / minH` chain doesn't resolve and ECharts
                falls back to its internal default of 100px. */}
            <Box h={{ base: '420px', md: '480px' }} position="relative" w="full">
              <Body
                data={data}
                error={error}
                graph={graph}
                loading={loading}
                onSelect={setSelection}
                tokenMap={tokenMap}
                view={view}
              />
            </Box>
          </VStack>
        </NoisyCard>
      </Card>

      {graph && view && (
        <PoolOrderFlowDetailsModal
          graph={graph}
          onClose={() => setSelection(null)}
          periodVolumeUsd={view.volumeUsd}
          selection={selection}
          swaps={view.swaps}
          tokenMap={tokenMap}
        />
      )}
    </FadeInOnView>
  )
}

// ── Header (title + subtitle + range toggle) ───────────────────────────────

function Header({
  data,
  loading,
  range,
  onRangeChange,
  view,
}: {
  data: OrderFlowResponse | null
  loading: boolean
  range: OrderFlowRange
  onRangeChange: (r: OrderFlowRange) => void
  view: RangeView | null
}) {
  const subtitle = (() => {
    if (loading && !data) return 'Loading order flow…'
    if (!data || !view) return 'No data'
    const swapCount = view.swaps.length.toLocaleString()
    const volume = formatUsdCompact(view.volumeUsd)
    const labeled = formatPct(view.labeledPct)
    // When the 30d data is capped (we hit HARD_CAP before the cutoff), the
    // fetched window is narrower than 30d. Surface that honestly so the
    // user knows the "30d" view is actually e.g. the last 7 days.
    const days =
      data.totals.capped && range === '30d'
        ? Math.max(
            1,
            Math.round((data.fetchedWindow.to - data.fetchedWindow.oldestSwapTs) / 86400)
          )
        : RANGE_DAYS[range]
    const cappedNote =
      data.totals.capped && range === '30d'
        ? ` · last ${days}d (cap reached)`
        : ''
    return `${swapCount} swaps · ${volume} volume · ${labeled} labeled${cappedNote}`
  })()

  return (
    <Flex
      align={{ base: 'flex-start', md: 'center' }}
      direction={{ base: 'column', md: 'row' }}
      gap="sm"
      justify="space-between"
    >
      <VStack align="flex-start" spacing="xs">
        <Heading size="h5">Order flow</Heading>
        <Text color="font.secondary" fontSize="xs">
          {subtitle}
        </Text>
      </VStack>
      <ButtonGroup isAttached size="sm" variant="outline">
        {(['24h', '7d', '30d'] as const).map(r => (
          <Button
            key={r}
            onClick={() => onRangeChange(r)}
            variant={r === range ? 'solid' : 'outline'}
          >
            {r}
          </Button>
        ))}
      </ButtonGroup>
    </Flex>
  )
}

// ── Legend (category share stacked above the Sankey) ───────────────────────

function CategoryLegend({
  graph,
}: {
  graph: NonNullable<ReturnType<typeof buildSankeyGraph>>
}) {
  return (
    <HStack flexWrap="wrap" spacing={4}>
      {LEGEND_ORDER.flatMap(cat => {
        const share = graph.categoryShare[cat]
        if (!share || share.pct <= 0) return []
        return [
          <HStack key={cat} spacing={2}>
            <Box bg={CATEGORY_COLORS[cat]} h={3} rounded="sm" w={3} />
            <Text color="font.secondary" fontSize="xs">
              {formatCategory(cat)} {formatPct(share.pct)}
            </Text>
          </HStack>,
        ]
      })}
    </HStack>
  )
}

// ── Body (loading / error / empty / Sankey) ────────────────────────────────

function Body({
  loading,
  error,
  data,
  graph,
  tokenMap,
  view,
  onSelect,
}: {
  loading: boolean
  error: Error | null
  data: OrderFlowResponse | null
  graph: ReturnType<typeof buildSankeyGraph> | null
  tokenMap: TokenMap
  view: RangeView | null
  onSelect: (sel: SankeySelection) => void
}) {
  if (loading && !data) {
    return (
      <CenteredMessage>
        <Spinner color="font.linkHover" size="lg" thickness="3px" />
        <Text color="font.secondary" fontSize="sm">
          Loading order flow…
        </Text>
      </CenteredMessage>
    )
  }
  if (error) {
    return (
      <CenteredMessage>
        <Text color="font.secondary" fontSize="sm">
          Unable to load order flow ({error.message})
        </Text>
      </CenteredMessage>
    )
  }
  if (!data || !view) {
    return (
      <CenteredMessage>
        <Text color="font.secondary" fontSize="sm">
          No data
        </Text>
      </CenteredMessage>
    )
  }
  if (view.swaps.length < MIN_SWAPS_FOR_RENDER) {
    return (
      <CenteredMessage>
        <Text color="font.secondary" fontSize="sm">
          Not enough swap volume in this period to render order flow.
        </Text>
        <Text color="font.secondary" fontSize="xs" opacity={0.7}>
          ({view.swaps.length} swap{view.swaps.length === 1 ? '' : 's'} found)
        </Text>
      </CenteredMessage>
    )
  }
  if (!graph || graph.nodes.length === 0) {
    return (
      <CenteredMessage>
        <Text color="font.secondary" fontSize="sm">
          All swaps in this period are below the ${MIN_USD_PER_SWAP} dust filter.
        </Text>
      </CenteredMessage>
    )
  }
  return (
    <PoolOrderFlowSankey
      graph={graph}
      onSelect={onSelect}
      periodVolumeUsd={view.volumeUsd}
      tokenMap={tokenMap}
    />
  )
}

function CenteredMessage({ children }: { children: React.ReactNode }) {
  return (
    <Flex
      align="center"
      direction="column"
      gap="sm"
      h="full"
      justify="center"
      textAlign="center"
    >
      {children}
    </Flex>
  )
}
