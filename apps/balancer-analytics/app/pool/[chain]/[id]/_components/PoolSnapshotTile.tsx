'use client'

/**
 * Left half of the pool-detail bento — at-a-glance metrics that mirror
 * frontend-v3's `PoolSnapshot`. TVL, 24h volume, 24h fees, pool age,
 * with a small delta pill on TVL (latest vs the snapshot ~24h prior).
 *
 * Reads from the same `PoolPageData['snapshots']` array the chart
 * consumes — no extra fetch.
 */

import {
  Card,
  Divider,
  HStack,
  Heading,
  Stack,
  Text,
  VStack,
  type StackProps,
} from '@chakra-ui/react'
import { NoisyCard } from '@repo/lib/shared/components/containers/NoisyCard'
import type { PoolPageData } from '../page'
import { getEventStyle } from './eventStyles'

type Snap = PoolPageData['snapshots'][number]
type Ev = PoolPageData['events'][number]

const usdCompact = (n: number) =>
  new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    notation: 'compact',
    maximumFractionDigits: 2,
  }).format(n || 0)

// Uniform compact format keeps the tile fits-on-260px clean: even a
// $1.5B pool reads as "$1.5B" rather than "$1,500,000,000".

function deltaPct(curr: number, prev: number): number | null {
  if (!Number.isFinite(curr) || !Number.isFinite(prev) || prev <= 0) return null
  return ((curr - prev) / prev) * 100
}

function DeltaBadge({ pct }: { pct: number | null }): React.JSX.Element | null {
  if (pct === null || !Number.isFinite(pct)) return null
  const positive = pct >= 0
  return (
    <Text
      color={positive ? 'green.400' : 'red.400'}
      fontFamily="mono"
      fontSize="xs"
      fontWeight={500}
    >
      {positive ? '+' : ''}
      {pct.toFixed(2)}%
    </Text>
  )
}

function MetricRow({
  label,
  value,
  delta,
  hint,
}: {
  label: string
  value: string
  delta?: number | null
  hint?: string
}): React.JSX.Element {
  return (
    <VStack align="flex-start" spacing="2xs" w="full">
      <HStack color="font.secondary" spacing="xs">
        <Text fontSize="xs" letterSpacing="0.02em" textTransform="uppercase">
          {label}
        </Text>
        {hint && (
          <Text fontSize="2xs" opacity={0.7}>
            {hint}
          </Text>
        )}
      </HStack>
      <HStack align="baseline" spacing="sm">
        <Heading fontWeight={600} size="h4">
          {value}
        </Heading>
        {delta !== undefined && <DeltaBadge pct={delta} />}
      </HStack>
    </VStack>
  )
}

// Locale-independent DD.MM.YYYY, HH:mm — matches the event log column.
const pad2 = (n: number): string => (n < 10 ? `0${n}` : `${n}`)
function fmtWhen(unixSec: number): string {
  const d = new Date(unixSec * 1000)
  return `${pad2(d.getDate())}.${pad2(d.getMonth() + 1)}.${d.getFullYear()}, ${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

/** Last-change row — different shape than the USD metrics (event label
 *  on its own line, timestamp underneath) so we lay it out by hand
 *  instead of reusing `MetricRow`. */
function LastChangeRow({ event }: { event: Ev | null }): React.JSX.Element {
  return (
    <VStack align="flex-start" spacing="2xs" w="full">
      <Text
        color="font.secondary"
        fontSize="xs"
        letterSpacing="0.02em"
        textTransform="uppercase"
      >
        Last parameter change
      </Text>
      {event ? (
        <>
          <HStack align="center" spacing="xs">
            <Text fontSize="md" fontWeight={600}>
              {getEventStyle(event.eventName).legendLabel}
            </Text>
          </HStack>
          <Text color="font.secondary" fontFamily="mono" fontSize="xs">
            {fmtWhen(event.blockTimestamp)}
          </Text>
        </>
      ) : (
        <Text color="font.secondary" fontSize="sm" fontStyle="italic">
          No changes recorded
        </Text>
      )}
    </VStack>
  )
}

export function PoolSnapshotTile({
  snapshots,
  events,
  ...stackProps
}: {
  snapshots: PoolPageData['snapshots']
  events: PoolPageData['events']
} & StackProps): React.JSX.Element {
  const sorted = [...snapshots].sort((a, b) => a.timestamp - b.timestamp)
  const latest = sorted.at(-1)
  // ~24h prior snapshot — for cron-fed daily series this is sorted[len-2].
  // For hourly series (rare here), walk back to find ts ≤ latest-86400.
  let prev: Snap | undefined
  if (latest) {
    const target = latest.timestamp - 86400
    for (let i = sorted.length - 2; i >= 0; i--) {
      if (sorted[i].timestamp <= target) {
        prev = sorted[i]
        break
      }
    }
    if (!prev) prev = sorted.at(-2)
  }

  const tvl = latest?.totalLiquidity ?? 0
  const tvlDelta = prev ? deltaPct(tvl, prev.totalLiquidity) : null
  const vol = latest?.volume24h ?? 0
  const fees = latest?.fees24h ?? 0

  // Latest tracked param event (max blockTimestamp). Stable+amp pools can
  // have multiple events at the same block — break ties on logIndex too.
  let lastEvent: Ev | null = null
  for (const e of events) {
    if (
      !lastEvent ||
      e.blockTimestamp > lastEvent.blockTimestamp ||
      (e.blockTimestamp === lastEvent.blockTimestamp && e.logIndex > lastEvent.logIndex)
    ) {
      lastEvent = e
    }
  }

  return (
    <Card overflow="hidden" position="relative" {...stackProps}>
      <NoisyCard
        cardProps={{ height: 'full', overflow: 'hidden' }}
        contentProps={{ display: 'flex' }}
      >
        <Stack
          align="stretch"
          divider={<Divider opacity={0.4} />}
          h="full"
          p={{ base: 'md', md: 'lg' }}
          spacing="md"
          w="full"
        >
          <Heading size="h5">Metrics</Heading>
          <MetricRow
            delta={tvlDelta}
            hint="vs 24h ago"
            label="TVL"
            value={usdCompact(tvl)}
          />
          <MetricRow
            hint="latest snapshot"
            label="Volume (24h)"
            value={usdCompact(vol)}
          />
          <MetricRow
            hint="latest snapshot"
            label="Fees (24h)"
            value={usdCompact(fees)}
          />
          <LastChangeRow event={lastEvent} />
        </Stack>
      </NoisyCard>
    </Card>
  )
}
