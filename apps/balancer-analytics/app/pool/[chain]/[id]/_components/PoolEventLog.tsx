'use client'

import {
  Box,
  Card,
  Flex,
  Grid,
  GridItem,
  HStack,
  Heading,
  Text,
  VStack,
} from '@chakra-ui/react'
import Link from 'next/link'
import { useCallback, useMemo, useState } from 'react'
import { PaginatedTable } from '@repo/lib/shared/components/tables/PaginatedTable'
import { getPaginationProps } from '@repo/lib/shared/components/pagination/getPaginationProps'
import type { GqlChain } from '@repo/lib/shared/services/api/generated/graphql'
import type { PoolParamEvent } from '@analytics/lib/pool-events/types'
import { CATEGORY_ORDER, getEventStyle, type EventCategory } from './eventStyles'
import { formatEventArgValue } from './formatEventArgs'

const dateFmt = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
})

const EXPLORER_URL: Partial<Record<string, string>> = {
  MAINNET: 'https://etherscan.io/tx/',
  ARBITRUM: 'https://arbiscan.io/tx/',
  AVALANCHE: 'https://snowtrace.io/tx/',
  BASE: 'https://basescan.org/tx/',
  GNOSIS: 'https://gnosisscan.io/tx/',
  OPTIMISM: 'https://optimistic.etherscan.io/tx/',
  POLYGON: 'https://polygonscan.com/tx/',
  SEPOLIA: 'https://sepolia.etherscan.io/tx/',
  FRAXTAL: 'https://fraxscan.com/tx/',
  MODE: 'https://explorer.mode.network/tx/',
  ZKEVM: 'https://zkevm.polygonscan.com/tx/',
  SONIC: 'https://sonicscan.org/tx/',
  HYPEREVM: 'https://hyperliquid.cloud.blockscout.com/tx/',
  PLASMA: 'https://plasmascan.to/tx/',
  MONAD: 'https://testnet.monadexplorer.com/tx/',
}

function shortHash(h: string): string {
  return `${h.slice(0, 8)}…${h.slice(-6)}`
}

const CATEGORY_LABELS: Record<EventCategory, string> = {
  fee: 'Fees',
  amp: 'Amp',
  state: 'Pause / recovery',
  surge: 'Surge',
  rate: 'Rate',
  registration: 'Registration',
  other: 'Other',
}

// Responsive grid columns mirror the PoolExplorer pattern: same template
// for header and body, with `minmax(0, 1fr)` on Args so it absorbs
// leftover horizontal space gracefully. On `base` we collapse to a single
// stacked column (see `EventRow` below) so narrow viewports don't need
// horizontal scroll just to read one event.
const GRID_COLS = {
  base: '1fr',
  md: '180px 240px minmax(0, 1fr) 140px',
}

function ArgList({ args }: { args: Record<string, string | number | boolean> }): React.JSX.Element {
  const entries = Object.entries(args)
  if (entries.length === 0) {
    return (
      <Text color="font.secondary" fontSize="xs">
        —
      </Text>
    )
  }
  // Horizontal key/value on `md+`, stacked on `base` so long values
  // (timestamps, formatted percentages) can't overflow a narrow viewport.
  return (
    <Box>
      {entries.map(([k, v]) => (
        <Flex
          align={{ base: 'flex-start', md: 'baseline' }}
          direction={{ base: 'column', md: 'row' }}
          gap={{ base: '2xs', md: 'sm' }}
          key={k}
        >
          <Text color="font.secondary" fontSize="2xs" minW={{ base: 0, md: '80px' }}>
            {k}
          </Text>
          <Text fontFamily="mono" fontSize="xs" wordBreak="break-word">
            {formatEventArgValue(k, v)}
          </Text>
        </Flex>
      ))}
    </Box>
  )
}

function EventHeader(): React.JSX.Element {
  // Hidden on `base` — stacked rows carry their own inline labels so a
  // sticky column header would just steal vertical space on phones.
  return (
    <Grid
      alignItems="center"
      borderBottom="1px solid"
      borderColor="border.base"
      display={{ base: 'none', md: 'grid' }}
      gap="ms"
      gridTemplateColumns={GRID_COLS}
      px={{ base: 'md', md: 'lg' }}
      py="sm"
      w="full"
    >
      <GridItem>
        <Text color="font.secondary" fontSize="xs" fontWeight="bold">
          When
        </Text>
      </GridItem>
      <GridItem>
        <Text color="font.secondary" fontSize="xs" fontWeight="bold">
          Event
        </Text>
      </GridItem>
      <GridItem>
        <Text color="font.secondary" fontSize="xs" fontWeight="bold">
          Arguments
        </Text>
      </GridItem>
      <GridItem justifySelf="end">
        <Text color="font.secondary" fontSize="xs" fontWeight="bold">
          Tx
        </Text>
      </GridItem>
    </Grid>
  )
}

/** Inline label shown above each field on `base` viewports only. Hidden on
 *  `md+` where the sticky column header carries the labels instead. */
function MobileLabel({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <Text
      color="font.secondary"
      display={{ base: 'block', md: 'none' }}
      fontSize="2xs"
      fontWeight="bold"
      mb="2xs"
      textTransform="uppercase"
    >
      {children}
    </Text>
  )
}

function EventRow({
  event,
  index,
  explorerBase,
}: {
  event: PoolParamEvent
  index: number
  explorerBase: string
}): React.JSX.Element {
  const style = getEventStyle(event.eventName)
  return (
    <Box
      _hover={{ bg: 'background.level0' }}
      borderColor="border.base"
      borderTop={index === 0 ? undefined : '1px solid'}
      transition="background 0.15s"
      w="full"
    >
      <Grid
        alignItems="flex-start"
        gap={{ base: 'sm', md: 'ms' }}
        gridTemplateColumns={GRID_COLS}
        px={{ base: 'md', md: 'lg' }}
        py="ms"
        w="full"
      >
        <GridItem>
          <MobileLabel>When</MobileLabel>
          <Text fontSize="xs">{dateFmt.format(new Date(event.blockTimestamp * 1000))}</Text>
        </GridItem>
        <GridItem minW={0}>
          <MobileLabel>Event</MobileLabel>
          <HStack mb="2xs" spacing="xs">
            <Box bg={style.color} borderRadius="full" flexShrink={0} h="8px" w="8px" />
            <Text fontSize="xs" fontWeight="500">
              {style.legendLabel}
            </Text>
          </HStack>
          <Text color="font.secondary" fontFamily="mono" fontSize="2xs">
            {event.eventName}
          </Text>
        </GridItem>
        <GridItem minW={0}>
          <MobileLabel>Arguments</MobileLabel>
          <ArgList args={event.args} />
        </GridItem>
        <GridItem
          fontFamily="mono"
          fontSize="xs"
          justifySelf={{ base: 'start', md: 'end' }}
        >
          <MobileLabel>Tx</MobileLabel>
          {explorerBase ? (
            <Link href={`${explorerBase}${event.txHash}`} rel="noreferrer" target="_blank">
              {shortHash(event.txHash)}
            </Link>
          ) : (
            shortHash(event.txHash)
          )}
        </GridItem>
      </Grid>
    </Box>
  )
}

export function PoolEventLog({
  events,
  chain,
}: {
  events: PoolParamEvent[]
  chain: GqlChain
}): React.JSX.Element {
  const explorerBase = EXPLORER_URL[chain] ?? ''

  // Newest-first canonical order; filtering and pagination derive from this.
  const sorted = useMemo(() => [...events].sort((a, b) => b.blockTimestamp - a.blockTimestamp), [
    events,
  ])

  // Filter chips only render for categories actually present so the strip
  // stays small and meaningful.
  const presentCategories = useMemo(() => {
    const set = new Set<EventCategory>()
    for (const e of sorted) set.add(getEventStyle(e.eventName).category)
    return CATEGORY_ORDER.filter(c => set.has(c))
  }, [sorted])

  // Empty Set = show all (so users don't accidentally hide everything by
  // deselecting the last chip).
  const [enabled, setEnabled] = useState<Set<EventCategory>>(new Set())
  const [pageIndex, setPageIndex] = useState(0)
  const [pageSize, setPageSize] = useState(25)

  const toggleCategory = useCallback((cat: EventCategory) => {
    setEnabled(prev => {
      const next = new Set(prev)
      if (next.has(cat)) next.delete(cat)
      else next.add(cat)
      return next
    })
    setPageIndex(0)
  }, [])

  const filtered = useMemo(() => {
    if (enabled.size === 0) return sorted
    return sorted.filter(e => enabled.has(getEventStyle(e.eventName).category))
  }, [sorted, enabled])

  const pageItems = useMemo(() => {
    const start = pageIndex * pageSize
    return filtered.slice(start, start + pageSize)
  }, [filtered, pageIndex, pageSize])

  const paginationProps = getPaginationProps(
    filtered.length,
    { pageIndex, pageSize },
    state => {
      setPageIndex(state.pageIndex)
      setPageSize(state.pageSize)
    }
  )

  return (
    <Card overflow="hidden" p={{ base: 'sm', md: 'md' }} variant="level1">
      <VStack align="stretch" spacing="md">
        <Flex
          align={{ base: 'flex-start', md: 'center' }}
          direction={{ base: 'column', md: 'row' }}
          gap="md"
          justify="space-between"
        >
          <VStack align="flex-start" spacing="xs">
            <Heading size="h5">Parameter events</Heading>
            <Text color="font.secondary" fontSize="xs">
              {filtered.length === sorted.length
                ? `${sorted.length.toLocaleString()} event${sorted.length === 1 ? '' : 's'}`
                : `${filtered.length.toLocaleString()} of ${sorted.length.toLocaleString()} events`}
            </Text>
          </VStack>
        </Flex>

        {presentCategories.length > 1 && (
          <HStack flexWrap="wrap" spacing="xs">
            {presentCategories.map(cat => {
              const isActive = enabled.size === 0 || enabled.has(cat)
              return (
                <Flex
                  align="center"
                  bg="background.level1"
                  border="1px solid"
                  borderColor="border.base"
                  cursor="pointer"
                  fontSize="xs"
                  gap="xs"
                  key={cat}
                  onClick={() => toggleCategory(cat)}
                  opacity={isActive ? 1 : 0.45}
                  px="ms"
                  py="2xs"
                  rounded="full"
                  transition="opacity 0.15s, background 0.15s"
                  userSelect="none"
                >
                  <Text fontWeight="500">{CATEGORY_LABELS[cat]}</Text>
                </Flex>
              )
            })}
          </HStack>
        )}

        <Card overflow="hidden" p={0} variant="subSection">
          <Box w="full">
            <PaginatedTable<PoolParamEvent>
              getRowId={ev => `${ev.txHash}-${ev.logIndex}`}
              items={pageItems}
              loading={false}
              loadingLength={pageSize}
              loadingSpinnerPosition="top"
              noItemsFoundLabel={
                sorted.length === 0
                  ? "No parameter events recorded in the scanned window — either the pool's parameters have never changed, or the scan hasn't reached its deployment block yet."
                  : 'No events match the current filter.'
              }
              paginationProps={paginationProps}
              renderTableHeader={() => <EventHeader />}
              renderTableRow={({ item, index }) => (
                <EventRow event={item} explorerBase={explorerBase} index={index} />
              )}
              showPagination={filtered.length > pageSize}
            />
          </Box>
        </Card>
      </VStack>
    </Card>
  )
}
