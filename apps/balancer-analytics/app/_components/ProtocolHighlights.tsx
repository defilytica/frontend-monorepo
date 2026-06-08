'use client'

import {
  Box,
  Card,
  Flex,
  HStack,
  LinkBox,
  LinkOverlay,
  SimpleGrid,
  Skeleton,
  Text,
  VStack,
} from '@chakra-ui/react'
import NextLink from 'next/link'
import { getChainShortName } from '@repo/lib/config/app.config'
import { NetworkIcon } from '@repo/lib/shared/components/icons/NetworkIcon'
import { chainToSlugMap } from '@repo/lib/modules/pool/pool.utils'
import {
  APR_MIN_TVL_USD,
  useDashboardHighlights,
  type PoolLeader,
} from '@analytics/lib/hooks/useDashboardHighlights'
import { usd } from './format'

const pct = (n: number, digits = 1) => `${(n * 100).toFixed(digits)}%`

// Pool detail route matches PoolExplorer's getPoolHref — analytics-app local
// `/pool/[chain]/[id]`, using api-v3's canonical id (works for V2 long ids).
function poolHref(pool: PoolLeader['pool']): string {
  const slug = chainToSlugMap[pool.chain] ?? 'ethereum'
  return `/pool/${slug}/${pool.id}`
}

function poolLabel(pool: PoolLeader['pool']): string {
  return pool.symbol ?? pool.name ?? pool.address.slice(0, 8)
}

export function ProtocolHighlights() {
  const { loading, topVolumeChain, topFeePool, topAprPool } = useDashboardHighlights()

  return (
    <SimpleGrid columns={{ base: 1, md: 3 }} spacing="md">
      <HighlightCard
        accent="orange.300"
        isLoading={loading}
        label="Top chain · 24h volume"
        leader={
          topVolumeChain && (
            <HStack minW={0} spacing="xs">
              <NetworkIcon chain={topVolumeChain.chain} size={5} />
              <Text color="font.maxContrast" fontSize="sm" fontWeight="semibold" noOfLines={1}>
                {getChainShortName(topVolumeChain.chain)}
              </Text>
            </HStack>
          )
        }
        sub={
          topVolumeChain
            ? `${pct(topVolumeChain.share)} of total · ${topVolumeChain.chainCount} chains tracked`
            : 'No 24h volume recorded'
        }
        value={topVolumeChain ? usd(topVolumeChain.volume24h) : '—'}
      />

      <HighlightCard
        accent="green.400"
        href={topFeePool ? poolHref(topFeePool.pool) : undefined}
        isLoading={loading}
        label="Most profitable pool · 24h fees"
        leader={
          topFeePool && (
            <HStack minW={0} spacing="xs">
              <NetworkIcon chain={topFeePool.pool.chain} size={5} />
              <Text color="font.maxContrast" fontSize="sm" fontWeight="semibold" noOfLines={1}>
                {poolLabel(topFeePool.pool)}
              </Text>
            </HStack>
          )
        }
        sub={
          topFeePool
            ? `TVL ${usd(topFeePool.tvl)} · ${pct(topFeePool.totalApr)} APR`
            : 'No pool fees recorded'
        }
        value={topFeePool ? usd(topFeePool.fees24h) : '—'}
      />

      <HighlightCard
        accent="purple.300"
        href={topAprPool ? poolHref(topAprPool.pool) : undefined}
        isLoading={loading}
        label={`Top APR pool · TVL ≥ ${usd(APR_MIN_TVL_USD)}`}
        leader={
          topAprPool && (
            <HStack minW={0} spacing="xs">
              <NetworkIcon chain={topAprPool.pool.chain} size={5} />
              <Text color="font.maxContrast" fontSize="sm" fontWeight="semibold" noOfLines={1}>
                {poolLabel(topAprPool.pool)}
              </Text>
            </HStack>
          )
        }
        sub={
          topAprPool
            ? `TVL ${usd(topAprPool.tvl)} · ${usd(topAprPool.fees24h)} fees · 24h`
            : 'No qualifying pool found'
        }
        value={topAprPool ? pct(topAprPool.totalApr, 2) : '—'}
      />
    </SimpleGrid>
  )
}

type CardProps = {
  label: string
  value: string
  sub: string
  leader: React.ReactNode
  accent: string
  isLoading?: boolean
  href?: string
}

function HighlightCard({ label, value, sub, leader, accent, isLoading, href }: CardProps) {
  const body = (
    <VStack align="stretch" h="full" justify="space-between" position="relative" spacing="md">
      <Flex align="center" justify="space-between" minW={0}>
        <Text
          color="font.secondary"
          fontSize="xs"
          fontWeight="medium"
          letterSpacing="0.4px"
          noOfLines={1}
          textTransform="uppercase"
        >
          {label}
        </Text>
        {isLoading ? <Skeleton h="20px" w="80px" /> : leader}
      </Flex>

      {isLoading ? (
        <Skeleton h="8" w="60%" />
      ) : href ? (
        <LinkOverlay
          as={NextLink}
          color="font.maxContrast"
          fontSize="2xl"
          fontWeight="bold"
          href={href}
          letterSpacing="-0.8px"
          lineHeight="1.05"
        >
          {value}
        </LinkOverlay>
      ) : (
        <Text
          color="font.maxContrast"
          fontSize="2xl"
          fontWeight="bold"
          letterSpacing="-0.8px"
          lineHeight="1.05"
        >
          {value}
        </Text>
      )}

      <Text color="font.secondary" fontSize="xs" noOfLines={1}>
        {sub}
      </Text>
    </VStack>
  )

  const Wrapper = href ? LinkBox : Box

  return (
    <Card
      _hover={href ? { borderColor: accent, transform: 'translateY(-1px)' } : undefined}
      borderColor="transparent"
      borderWidth="1px"
      h="full"
      overflow="hidden"
      p={{ base: 'md', md: 'md' }}
      position="relative"
      transition="border-color 0.15s, transform 0.15s"
      variant="level2"
    >
      <Box
        aria-hidden
        backgroundImage="url('/images/textures/slate-square-small-dark.jpg')"
        backgroundPosition="center"
        backgroundSize="cover"
        inset={0}
        opacity={0.35}
        pointerEvents="none"
        position="absolute"
      />
      <Box
        aria-hidden
        bgGradient={`linear(to-r, ${accent}, transparent)`}
        h="2px"
        left={0}
        opacity={0.85}
        position="absolute"
        right={0}
        top={0}
      />
      <Wrapper h="full" position="relative">
        {body}
      </Wrapper>
    </Card>
  )
}
