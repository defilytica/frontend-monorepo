'use client'

import { Box, Flex, HStack, Text } from '@chakra-ui/react'
import ReactECharts from 'echarts-for-react'
import { useMemo } from 'react'
import type { PoolPageData } from '../page'
import { CATEGORY_ORDER, EVENT_STYLES, getEventStyle, type EventCategory } from './eventStyles'
import { formatEventArgValue } from './formatEventArgs'

const usdCompact = (n: number) =>
  new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    notation: 'compact',
    maximumFractionDigits: 2,
  }).format(n || 0)

const usdFull = (n: number) =>
  new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  }).format(n || 0)

const dateLabelFmt = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' })

type Snapshot = PoolPageData['snapshots'][number]
type Ev = PoolPageData['events'][number]

/**
 * Linear interpolate TVL at a given timestamp from the snapshot series.
 * Snapshots are daily-bucketed; events between snapshots get the lerp of
 * the surrounding two. Outside the series range we clamp to the nearest
 * edge.
 */
function tvlAt(snapshots: Snapshot[], ts: number): number {
  if (snapshots.length === 0) return 0
  if (ts <= snapshots[0].timestamp) return snapshots[0].totalLiquidity
  const last = snapshots[snapshots.length - 1]
  if (ts >= last.timestamp) return last.totalLiquidity
  for (let i = 1; i < snapshots.length; i++) {
    const a = snapshots[i - 1]
    const b = snapshots[i]
    if (ts >= a.timestamp && ts <= b.timestamp) {
      const t = (ts - a.timestamp) / Math.max(1, b.timestamp - a.timestamp)
      return a.totalLiquidity + (b.totalLiquidity - a.totalLiquidity) * t
    }
  }
  return last.totalLiquidity
}

type MarkPoint = {
  coord: [number, number]
  itemStyle: { color: string }
  symbol: string
  symbolSize: number
  symbolOffset?: [number, number]
  label: {
    show: boolean
    formatter: string
    color: string
    fontSize: number
    fontWeight: number
    offset: [number, number]
  }
  meta: { event: Ev }
}

export function PoolHistoryChart({
  snapshots,
  events,
}: {
  snapshots: PoolPageData['snapshots']
  events: PoolPageData['events']
}): React.JSX.Element {
  // Per-event-name counts for the legend chip strip. Ordered later by
  // category to match the chart's color story.
  const eventCounts = useMemo(() => {
    const counts: Record<string, number> = {}
    for (const e of events) counts[e.eventName] = (counts[e.eventName] ?? 0) + 1
    return counts
  }, [events])

  // Group event names by category for the legend's visual sectioning.
  const legendGroups = useMemo(() => {
    const byCategory = new Map<EventCategory, string[]>()
    for (const name of Object.keys(eventCounts)) {
      const cat = getEventStyle(name).category
      if (!byCategory.has(cat)) byCategory.set(cat, [])
      byCategory.get(cat)!.push(name)
    }
    // Stable alphabetic order within each group.
    for (const arr of byCategory.values()) arr.sort()
    return CATEGORY_ORDER.flatMap(cat => byCategory.get(cat) ?? [])
  }, [eventCounts])

  const option = useMemo(() => {
    const sorted = [...snapshots].sort((a, b) => a.timestamp - b.timestamp)
    const tvlSeries = sorted.map(s => [s.timestamp * 1000, s.totalLiquidity] as const)
    const volSeries = sorted.map(s => [s.timestamp * 1000, s.volume24h] as const)
    const feeSeries = sorted.map(s => [s.timestamp * 1000, s.fees24h] as const)

    const seriesStart = sorted[0]?.timestamp ?? 0
    const seriesEnd = sorted[sorted.length - 1]?.timestamp ?? 0

    const inRangeEvents = events.filter(
      e => e.blockTimestamp >= seriesStart && e.blockTimestamp <= seriesEnd
    )

    // Pins, one per event. Even-indexed pins drop slightly so labels of
    // adjacent same-day events don't stack on top of each other.
    const markPoints: MarkPoint[] = inRangeEvents.map((e, idx) => {
      const style = getEventStyle(e.eventName)
      return {
        coord: [e.blockTimestamp * 1000, tvlAt(sorted, e.blockTimestamp)],
        itemStyle: { color: style.color },
        symbol: 'pin',
        symbolSize: 34,
        symbolOffset: [0, idx % 2 === 0 ? -2 : 16],
        label: {
          show: true,
          formatter: style.pinLabel,
          color: '#fff',
          fontSize: 10,
          fontWeight: 700,
          offset: [0, -2],
        },
        meta: { event: e },
      }
    })

    // Vertical dashed lines at every in-range event — visible regardless of
    // y-axis value, drawn under the pins (`z: 1`).
    const markLines = inRangeEvents.map(e => {
      const style = getEventStyle(e.eventName)
      return {
        xAxis: e.blockTimestamp * 1000,
        lineStyle: {
          color: style.color,
          type: 'dashed' as const,
          width: 1,
          opacity: 0.55,
        },
        label: { show: false },
      }
    })

    // Amp ramps → translucent markArea between AmpUpdateStarted.startTime
    // and endTime so the "ramp in progress" window is visible at a glance.
    const ampAreas: [{ xAxis: number; itemStyle: { color: string } }, { xAxis: number }][] = []
    for (const e of events) {
      if (e.eventName !== 'AmpUpdateStarted') continue
      const startTime = Number(e.args.startTime ?? 0)
      const endTime = Number(e.args.endTime ?? 0)
      if (!startTime || !endTime || endTime <= startTime) continue
      ampAreas.push([
        { xAxis: startTime * 1000, itemStyle: { color: 'rgba(245, 158, 11, 0.14)' } },
        { xAxis: endTime * 1000 },
      ])
    }

    return {
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'cross' },
        backgroundColor: 'rgba(20, 20, 28, 0.95)',
        borderColor: 'rgba(255,255,255,0.1)',
        textStyle: { color: '#fff', fontSize: 12 },
        formatter: (rawParams: unknown) => {
          const params = rawParams as Array<{
            seriesName: string
            seriesType: string
            data: [number, number]
            color: string
          }>
          if (!params?.length) return ''
          const ts = params[0].data[0]
          const date = new Date(ts).toLocaleString(undefined, {
            month: 'short',
            day: 'numeric',
            year: 'numeric',
          })
          const lines = params
            .filter(p => p.seriesType !== undefined)
            .map(
              p =>
                `<div style="display:flex;justify-content:space-between;gap:12px;">
                  <span><span style="display:inline-block;width:8px;height:8px;background:${p.color};border-radius:50%;margin-right:6px;"></span>${p.seriesName}</span>
                  <span style="font-family:ui-monospace,monospace;">${usdFull(p.data[1])}</span>
                </div>`
            )
          return `<div><div style="margin-bottom:6px;opacity:0.7;">${date}</div>${lines.join('')}</div>`
        },
      },
      legend: {
        data: ['TVL', 'Volume 24h', 'Fees 24h'],
        bottom: 4,
        textStyle: { fontSize: 11 },
      },
      grid: {
        top: 36,
        left: 56,
        right: 64,
        bottom: 48,
      },
      xAxis: {
        type: 'time',
        axisLabel: {
          formatter: (val: number) => dateLabelFmt.format(new Date(val)),
          fontSize: 10,
        },
        splitLine: { show: false },
      },
      yAxis: [
        {
          type: 'value',
          position: 'left',
          axisLabel: {
            formatter: (val: number) => usdCompact(val),
            fontSize: 10,
          },
          splitLine: { lineStyle: { type: 'dashed', opacity: 0.2 } },
        },
        {
          type: 'value',
          position: 'right',
          axisLabel: {
            formatter: (val: number) => usdCompact(val),
            fontSize: 10,
          },
          splitLine: { show: false },
        },
      ],
      series: [
        {
          name: 'TVL',
          type: 'line',
          yAxisIndex: 0,
          data: tvlSeries,
          smooth: true,
          symbol: 'none',
          lineStyle: { color: '#E6C6A0', width: 2 },
          areaStyle: {
            color: {
              type: 'linear',
              x: 0,
              y: 0,
              x2: 0,
              y2: 1,
              colorStops: [
                { offset: 0, color: 'rgba(230, 198, 160, 0.35)' },
                { offset: 1, color: 'rgba(230, 198, 160, 0)' },
              ],
            },
          },
          markPoint: markPoints.length
            ? {
                z: 10,
                data: markPoints,
                tooltip: {
                  formatter: (raw: unknown) => {
                    const params = raw as { data?: MarkPoint }
                    const e = params.data?.meta?.event
                    if (!e) return ''
                    const style = getEventStyle(e.eventName)
                    const date = new Date(e.blockTimestamp * 1000).toLocaleString(undefined, {
                      month: 'short',
                      day: 'numeric',
                      hour: 'numeric',
                      minute: '2-digit',
                    })
                    const argRows = Object.entries(e.args)
                      .map(
                        ([k, v]) =>
                          `<div style="display:flex;justify-content:space-between;gap:14px;">
                            <span style="opacity:0.7;">${k}</span>
                            <span style="font-family:ui-monospace,monospace;">${formatEventArgValue(k, v)}</span>
                          </div>`
                      )
                      .join('')
                    return `<div style="max-width:300px;">
                      <div style="display:flex;align-items:center;gap:6px;margin-bottom:4px;">
                        <span style="display:inline-block;width:8px;height:8px;background:${style.color};border-radius:50%;"></span>
                        <span style="font-weight:600;">${style.legendLabel}</span>
                      </div>
                      <div style="opacity:0.7;margin-bottom:8px;font-size:11px;">${e.eventName} · ${date}</div>
                      ${argRows}
                    </div>`
                  },
                },
              }
            : undefined,
          markLine: markLines.length
            ? {
                z: 1,
                silent: true,
                symbol: ['none', 'none'],
                animation: false,
                data: markLines,
              }
            : undefined,
          markArea: ampAreas.length ? { silent: true, data: ampAreas } : undefined,
        },
        {
          name: 'Volume 24h',
          type: 'bar',
          yAxisIndex: 1,
          data: volSeries,
          itemStyle: { color: 'rgba(159, 149, 240, 0.55)' },
          barCategoryGap: '30%',
        },
        {
          name: 'Fees 24h',
          type: 'bar',
          yAxisIndex: 1,
          data: feeSeries,
          itemStyle: { color: 'rgba(37, 226, 164, 0.7)' },
          barCategoryGap: '30%',
          stack: 'overlay',
        },
      ],
    }
  }, [snapshots, events])

  if (snapshots.length === 0) {
    return (
      <Box opacity={0.6} py="xl" textAlign="center">
        No snapshot data available for this pool.
      </Box>
    )
  }

  const hasEvents = legendGroups.length > 0

  return (
    <Box>
      {hasEvents && (
        <HStack flexWrap="wrap" mb="md" spacing="xs">
          {legendGroups.map(name => {
            const style = EVENT_STYLES[name] ?? getEventStyle(name)
            const count = eventCounts[name]
            return (
              <Flex
                align="center"
                bg="background.level1"
                border="1px solid"
                borderColor="border.base"
                fontSize="xs"
                gap="xs"
                key={name}
                px="ms"
                py="2xs"
                rounded="full"
                title={`${name} (${count})`}
              >
                <Box bg={style.color} borderRadius="full" h="8px" w="8px" />
                <Text fontWeight="500">{style.legendLabel}</Text>
                <Text color="font.secondary" fontFamily="mono">
                  {count}
                </Text>
              </Flex>
            )
          })}
        </HStack>
      )}
      <Box h={{ base: '320px', md: '420px' }}>
        <ReactECharts
          notMerge
          option={option}
          opts={{ renderer: 'canvas' }}
          style={{ height: '100%', width: '100%' }}
        />
      </Box>
    </Box>
  )
}
