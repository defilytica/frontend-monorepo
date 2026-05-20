'use client'

import {
  Badge,
  Box,
  Card,
  Flex,
  Grid,
  GridItem,
  HStack,
  Heading,
  Stack,
  Text,
  VStack,
} from '@chakra-ui/react'
import Link from 'next/link'
import { useCallback, useState } from 'react'
import { DefaultPageContainer } from '@repo/lib/shared/components/containers/DefaultPageContainer'
import FadeInOnView from '@repo/lib/shared/components/containers/FadeInOnView'
import { chainToSlugMap } from '@repo/lib/modules/pool/pool.utils'
import type { PoolPageData } from '../page'
import { PoolHistoryChart } from './PoolHistoryChart'
import { PoolStatePanel } from './PoolStatePanel'
import { PoolEventLog } from './PoolEventLog'
import { HistoryRangeToggle } from './HistoryRangeToggle'
import { CompareModeToolbar } from './CompareModeToolbar'

function shortAddr(addr: string): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`
}

function frontendPoolHref(p: PoolPageData['poolDetail']): string {
  const slug = chainToSlugMap[p.chain] ?? 'ethereum'
  const variant = p.protocolVersion === 3 ? 'v3' : 'v2'
  return `https://balancer.fi/pools/${slug}/${variant}/${p.id}`
}

export function PoolPageView({ data }: { data: PoolPageData }): React.JSX.Element {
  const { poolDetail, snapshots, events, state, fullHistory } = data
  const tokenSymbols = poolDetail.tokens.map(t => t.symbol).join(' / ')

  // Compare-mode cursor state (Phase E). Click cycle:
  //   0 cursors → set A
  //   A only    → set B (toolbar normalizes left/right order)
  //   both set  → restart from clicked timestamp (new A, B clears)
  // The toolbar renders only when at least one cursor is set.
  const [cursors, setCursors] = useState<{ a: number | null; b: number | null }>({
    a: null,
    b: null,
  })
  const handleCursorClick = useCallback((t: number) => {
    setCursors(prev => {
      if (prev.a === null) return { a: t, b: null }
      if (prev.b === null) return { a: prev.a, b: t }
      return { a: t, b: null }
    })
  }, [])
  const clearCursors = useCallback(() => setCursors({ a: null, b: null }), [])

  return (
    <DefaultPageContainer pb="2xl" pt={['md', 'lg']}>
      <VStack align="stretch" spacing={{ base: 'lg', md: 'xl' }}>
        <FadeInOnView animateOnce={false}>
          <Stack align="flex-start" direction={{ base: 'column', md: 'row' }} spacing="md">
            <Box flex="1" minW={0}>
              <HStack mb="xs" spacing="sm">
                <Badge variant="outline">v{poolDetail.protocolVersion}</Badge>
                <Badge textTransform="lowercase" variant="outline">
                  {poolDetail.type}
                </Badge>
                <Badge textTransform="lowercase" variant="outline">
                  {poolDetail.chain}
                </Badge>
              </HStack>
              <Heading
                pb="xs"
                size="h3"
                sx={{ textWrap: 'balance' }}
                variant="special"
              >
                {poolDetail.name}
              </Heading>
              <Text sx={{ textWrap: 'balance' }} variant="secondary">
                {tokenSymbols} — parameter timeline and impact
              </Text>
            </Box>
            <VStack align={{ base: 'flex-start', md: 'flex-end' }} spacing="xs">
              <Link href={frontendPoolHref(poolDetail)} rel="noreferrer" target="_blank">
                <Text _hover={{ color: 'font.linkHover' }} fontSize="sm" variant="secondary">
                  Open in balancer.fi →
                </Text>
              </Link>
              <Text fontFamily="mono" fontSize="xs" variant="secondary">
                {shortAddr(poolDetail.address)}
              </Text>
            </VStack>
          </Stack>
        </FadeInOnView>

        <Grid gap={{ base: 'md', md: 'lg' }} templateColumns={{ base: '1fr', xl: '1fr 340px' }}>
          <GridItem minW={0}>
            <FadeInOnView animateOnce={false}>
              <Card
                overflow="hidden"
                p={{ base: 'sm', md: 'md' }}
                variant="level1"
              >
                <VStack align="stretch" spacing="md">
                  <Flex
                    align={{ base: 'flex-start', md: 'center' }}
                    direction={{ base: 'column', md: 'row' }}
                    gap="sm"
                    justify="space-between"
                  >
                    <VStack align="flex-start" spacing="xs">
                      <Heading size="h5">
                        {fullHistory ? 'Full history' : '90-day history'}
                      </Heading>
                      <Text color="font.secondary" fontSize="xs">
                        {events.length.toLocaleString()} parameter event
                        {events.length === 1 ? '' : 's'} indexed
                        {fullHistory ? ' · since pool creation' : ' · last 90 days'}
                      </Text>
                    </VStack>
                    <HistoryRangeToggle fullHistory={fullHistory} />
                  </Flex>
                  <Card p={{ base: 'sm', md: 'md' }} variant="subSection">
                    <PoolHistoryChart
                      cursors={cursors}
                      events={events}
                      onCursorClick={handleCursorClick}
                      snapshots={snapshots}
                    />
                  </Card>
                </VStack>
              </Card>
            </FadeInOnView>
          </GridItem>
          <GridItem>
            <FadeInOnView animateOnce={false}>
              <PoolStatePanel poolDetail={poolDetail} state={state} />
            </FadeInOnView>
          </GridItem>
        </Grid>

        {(cursors.a !== null || cursors.b !== null) && (
          <FadeInOnView animateOnce={false}>
            <CompareModeToolbar
              cursorA={cursors.a}
              cursorB={cursors.b}
              events={events}
              onClear={clearCursors}
              snapshots={snapshots}
            />
          </FadeInOnView>
        )}

        <FadeInOnView animateOnce={false}>
          <PoolEventLog chain={poolDetail.chain} events={events} />
        </FadeInOnView>
      </VStack>
    </DefaultPageContainer>
  )
}
