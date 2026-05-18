/**
 * App-Router loading boundary for the pool detail route.
 *
 * Next renders this while `page.tsx` is awaiting its data — the cold scan
 * (drpc-side log walk) is the long pole, typically 10-20s for a fresh
 * pool against the 90-day window. The throbber sits in the same
 * `DefaultPageContainer` as the rendered page so layout doesn't jump on
 * resolution.
 */

'use client'

import { Box, Spinner, Text, VStack } from '@chakra-ui/react'
import { DefaultPageContainer } from '@repo/lib/shared/components/containers/DefaultPageContainer'

export default function Loading(): React.JSX.Element {
  return (
    <DefaultPageContainer pb="2xl" pt={['md', 'lg']}>
      <Box
        alignItems="center"
        display="flex"
        justifyContent="center"
        minH={{ base: '50vh', md: '60vh' }}
      >
        <VStack spacing="md">
          <Spinner color="font.linkHover" size="xl" thickness="3px" />
          <Text fontWeight="medium">Indexing pool parameter changes</Text>
          <Text fontSize="sm" maxW="380px" textAlign="center" variant="secondary">
            First visit scans up to 90 days of on-chain events. Subsequent loads are near-instant.
          </Text>
        </VStack>
      </Box>
    </DefaultPageContainer>
  )
}
