'use client'

import {
  Box,
  Button,
  Card,
  Flex,
  HStack,
  Heading,
  Link,
  Skeleton,
  Text,
  VStack,
} from '@chakra-ui/react'
import NextLink from 'next/link'
import { ArrowUpRight } from 'react-feather'
import { useMerklRewards } from '@analytics/lib/hooks/useMerklRewards'

const usd = (n: number) =>
  new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    notation: 'compact',
    maximumFractionDigits: 2,
  }).format(n)

const tokens = (n: number) =>
  new Intl.NumberFormat('en-US', {
    notation: 'compact',
    maximumFractionDigits: 4,
  }).format(n)

const MERKL_URL = 'https://app.merkl.xyz/'

export function PortfolioMerklCard({ address }: { address: string }) {
  const { loading, error, payload } = useMerklRewards(address)
  const rewards = payload?.rewards ?? []
  const totalUsd = payload?.totalUnclaimedUsd ?? 0
  const hasRewards = rewards.length > 0
  // Stable, deep link to the user's own Merkl dashboard so "Open Merkl"
  // lands directly on the same address rather than the rotating home page.
  const merklUserUrl = `${MERKL_URL}?user=${address}`

  return (
    <Card h="full" variant="level1">
      <Flex align="center" flexWrap="wrap" gap="xs" justify="space-between" mb="md">
        <Heading size="h6">Merkl rewards</Heading>
        <Text color="font.secondary" fontSize="xs">
          unclaimed
        </Text>
      </Flex>

      {loading ? (
        <VStack align="stretch" spacing="sm">
          <Skeleton h="40px" />
          <Skeleton h="20px" />
          <Skeleton h="20px" />
        </VStack>
      ) : error ? (
        <Text color="font.secondary" fontSize="sm">
          Merkl lookup failed. Try refreshing.
        </Text>
      ) : !hasRewards ? (
        <VStack align="flex-start" spacing="sm">
          <Text color="font.secondary" fontSize="sm">
            No unclaimed Merkl rewards on Balancer-supported chains.
          </Text>
          <Text color="font.tertiary" fontSize="xs">
            Eligible activity (vault deposits, paired-asset LPing) shows up here once Merkl
            campaigns finalise the snapshot.
          </Text>
          <Button
            as={NextLink}
            href={merklUserUrl}
            rel="noopener noreferrer"
            rightIcon={<ArrowUpRight size={12} />}
            size="xs"
            target="_blank"
            variant="tertiary"
          >
            Open Merkl dashboard
          </Button>
        </VStack>
      ) : (
        <VStack align="stretch" spacing="sm">
          <Box>
            <Text color="font.secondary" fontSize="xs">
              Total unclaimed
            </Text>
            <Text
              color="font.maxContrast"
              fontSize="2xl"
              fontWeight="bold"
              letterSpacing="-0.4px"
            >
              {totalUsd > 0 ? usd(totalUsd) : '—'}
            </Text>
          </Box>
          <VStack align="stretch" spacing="xs">
            {rewards.slice(0, 5).map(r => {
              const usdLabel =
                r.unclaimedUsd != null && r.unclaimedUsd > 0
                  ? usd(r.unclaimedUsd)
                  : `${tokens(r.unclaimed)} ${r.symbol}`
              return (
                <Flex align="center" justify="space-between" key={`${r.chainId}-${r.tokenAddress}`}>
                  <HStack spacing="xs">
                    <Box
                      bg="background.level3"
                      borderRadius="full"
                      color="font.maxContrast"
                      fontSize="2xs"
                      fontWeight="bold"
                      h="20px"
                      minW="20px"
                      px="xs"
                      textAlign="center"
                    >
                      {r.symbol.slice(0, 4).toUpperCase()}
                    </Box>
                    <VStack align="flex-start" spacing={0}>
                      <Text fontSize="sm" fontWeight="medium">
                        {r.symbol}
                      </Text>
                      <Text color="font.tertiary" fontSize="2xs">
                        {r.chainName}
                      </Text>
                    </VStack>
                  </HStack>
                  <VStack align="flex-end" spacing={0}>
                    <Text fontFamily="mono" fontSize="xs" fontWeight="medium">
                      {usdLabel}
                    </Text>
                    {r.unclaimedUsd != null && r.unclaimedUsd > 0 && (
                      <Text color="font.tertiary" fontSize="2xs">
                        {tokens(r.unclaimed)} {r.symbol}
                      </Text>
                    )}
                  </VStack>
                </Flex>
              )
            })}
            {rewards.length > 5 && (
              <Text color="font.tertiary" fontSize="2xs">
                +{rewards.length - 5} more reward tokens
              </Text>
            )}
          </VStack>
          <Link
            as={NextLink}
            color="font.highlight"
            fontSize="xs"
            fontWeight="medium"
            href={merklUserUrl}
            rel="noopener noreferrer"
            target="_blank"
          >
            <HStack spacing="xs">
              <span>Claim on Merkl</span>
              <ArrowUpRight size={12} />
            </HStack>
          </Link>
        </VStack>
      )}
    </Card>
  )
}
