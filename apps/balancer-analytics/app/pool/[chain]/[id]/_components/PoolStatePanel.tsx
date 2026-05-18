'use client'

import {
  Badge,
  Box,
  Card,
  Divider,
  Flex,
  HStack,
  Heading,
  Stack,
  Text,
  VStack,
} from '@chakra-ui/react'
import type { StableTypeState } from '@analytics/lib/pool-state/read'
import type { PoolPageData } from '../page'

// V3 percentages are stored as `1e18`-scaled fixed-point. Divide and format
// as a percentage with up to 4 decimal places (covers down to 0.01 bp).
function formatPercent(value: string | null): string {
  if (value === null) return '—'
  const n = Number(value) / 1e18
  if (!Number.isFinite(n)) return '—'
  return `${(n * 100).toFixed(4).replace(/\.?0+$/, '')}%`
}

function formatAmp(value: string, precision: string): string {
  const v = Number(value)
  const p = Number(precision) || 1
  if (!Number.isFinite(v) || !Number.isFinite(p)) return value
  return (v / p).toLocaleString(undefined, { maximumFractionDigits: 2 })
}

function formatTimestamp(unix: number): string {
  if (!unix) return '—'
  return new Date(unix * 1000).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

function StateRow({
  label,
  value,
  hint,
}: {
  label: string
  value: string | React.ReactNode
  hint?: string
}): React.JSX.Element {
  // The value wrapper used to be a `<Text>` (renders as `<p>`). When `value`
  // is JSX containing another `<Text>` (e.g. the amp factor cell with its
  // "updating" badge), we ended up with `<p>` inside `<p>` — invalid HTML
  // and a hydration error. Render strings via `<Text>` (semantic) and JSX
  // values via `<Box>` (no element constraint).
  return (
    <Flex align="baseline" gap="sm" justify="space-between">
      <VStack align="flex-start" spacing="0">
        <Text fontSize="xs" variant="secondary">
          {label}
        </Text>
        {hint && (
          <Text fontSize="2xs" opacity={0.7} variant="secondary">
            {hint}
          </Text>
        )}
      </VStack>
      {typeof value === 'string' ? (
        <Text fontFamily="mono" fontSize="sm">
          {value}
        </Text>
      ) : (
        <Box fontFamily="mono" fontSize="sm">
          {value}
        </Box>
      )}
    </Flex>
  )
}

/**
 * Amp factor + ramp schedule rows. Shared between V3 and V2 stable pools
 * since the `StableTypeState` shape is identical — V2 just synthesizes a
 * degenerate ramp (start == end, both times 0) which the ramp-schedule
 * block conditionally hides.
 */
function AmpFactorRows({ stable: s }: { stable: StableTypeState }): React.JSX.Element {
  return (
    <>
      <Divider />
      <StateRow
        hint={s.amplificationParameter.isUpdating ? 'ramping' : 'static'}
        label="Amp factor"
        value={
          <HStack spacing="xs">
            <Text fontFamily="mono" fontSize="sm">
              {formatAmp(s.amplificationParameter.value, s.amplificationParameter.precision)}
            </Text>
            {s.amplificationParameter.isUpdating && (
              <Badge colorScheme="purple" size="sm">
                updating
              </Badge>
            )}
          </HStack>
        }
      />
      {s.amplificationState.endTime > 0 &&
        s.amplificationState.startValue !== s.amplificationState.endValue && (
          <Box borderColor="border.base" borderLeft="2px solid" pl="md">
            <Text fontSize="xs" mb="xs" variant="secondary">
              Ramp schedule
            </Text>
            <VStack align="stretch" spacing="2xs">
              <Flex justify="space-between">
                <Text fontSize="xs" variant="secondary">
                  start
                </Text>
                <Text fontFamily="mono" fontSize="xs">
                  {formatAmp(
                    s.amplificationState.startValue,
                    s.amplificationParameter.precision
                  )}{' '}
                  · {formatTimestamp(s.amplificationState.startTime)}
                </Text>
              </Flex>
              <Flex justify="space-between">
                <Text fontSize="xs" variant="secondary">
                  end
                </Text>
                <Text fontFamily="mono" fontSize="xs">
                  {formatAmp(
                    s.amplificationState.endValue,
                    s.amplificationParameter.precision
                  )}{' '}
                  · {formatTimestamp(s.amplificationState.endTime)}
                </Text>
              </Flex>
            </VStack>
          </Box>
        )}
    </>
  )
}

export function PoolStatePanel({
  poolDetail,
  state,
}: {
  poolDetail: PoolPageData['poolDetail']
  state: PoolPageData['state']
}): React.JSX.Element {
  const u = state.universal
  const v2 = state.v2Base
  const s = state.stable
  const isV3 = poolDetail.protocolVersion === 3
  const isV2 = poolDetail.protocolVersion === 2

  // Surface paused / recovery / active across both protocol versions. V2
  // pre-fork pools have `isInRecoveryMode: null` (the call reverted), so we
  // only show the recovery badge when the value is unambiguously true.
  const isPaused = u?.isPaused ?? v2?.isPaused ?? false
  const isInRecovery = u?.isInRecoveryMode ?? v2?.isInRecoveryMode ?? false
  const hasAnyState = u || v2

  return (
    <Card overflow="hidden" p={{ base: 'sm', md: 'md' }} variant="level1">
      <VStack align="stretch" spacing="md">
        <Flex align="center" justify="space-between">
          <Heading size="h5">Current state</Heading>
          {hasAnyState && (
            <HStack spacing="xs">
              {isPaused && <Badge colorScheme="red">paused</Badge>}
              {isInRecovery && <Badge colorScheme="orange">recovery</Badge>}
              {!isPaused && !isInRecovery && <Badge colorScheme="green">active</Badge>}
            </HStack>
          )}
        </Flex>

        {isV3 && !u && (
          <Card p="md" variant="subSection">
            <Text color="font.secondary" fontSize="sm">
              Current state unavailable — VaultExplorer not configured for {poolDetail.chain}.
            </Text>
          </Card>
        )}

        {isV2 && !v2 && (
          <Card p="md" variant="subSection">
            <Text color="font.secondary" fontSize="sm">
              Current state unavailable — V2 pool reads failed.
            </Text>
          </Card>
        )}

        {u && (
          <Card p="md" variant="subSection">
            <Stack divider={<Divider />} spacing="sm">
              <StateRow label="Swap fee" value={formatPercent(u.swapFeePercentage)} />
              <StateRow
                hint="protocol + creator on swaps"
                label="Aggregate swap fee"
                value={formatPercent(u.aggregateSwapFeePercentage)}
              />
              <StateRow
                hint="protocol + creator on rate-provider yield"
                label="Aggregate yield fee"
                value={formatPercent(u.aggregateYieldFeePercentage)}
              />
              {s && <AmpFactorRows stable={s} />}
              {(u.poolCreatorSwapFeePercentage !== null ||
                u.poolCreatorYieldFeePercentage !== null) && (
                <>
                  <Divider />
                  <StateRow
                    label="Pool-creator swap"
                    value={formatPercent(u.poolCreatorSwapFeePercentage)}
                  />
                  <StateRow
                    label="Pool-creator yield"
                    value={formatPercent(u.poolCreatorYieldFeePercentage)}
                  />
                </>
              )}
            </Stack>
          </Card>
        )}

        {v2 && (
          <Card p="md" variant="subSection">
            <Stack divider={<Divider />} spacing="sm">
              <StateRow label="Swap fee" value={formatPercent(v2.swapFeePercentage)} />
              {v2.protocolSwapFeeCache !== null && (
                <StateRow
                  hint="last cached value on this pool"
                  label="Protocol swap fee"
                  value={formatPercent(v2.protocolSwapFeeCache)}
                />
              )}
              {v2.protocolYieldFeeCache !== null &&
                v2.protocolYieldFeeCache !== '0' && (
                  <StateRow
                    hint="last cached value on this pool"
                    label="Protocol yield fee"
                    value={formatPercent(v2.protocolYieldFeeCache)}
                  />
                )}
              {v2.pauseWindowEndTime > 0 && (
                <StateRow
                  hint="emergency pause is available until"
                  label="Pause window ends"
                  value={formatTimestamp(v2.pauseWindowEndTime)}
                />
              )}
              {s && <AmpFactorRows stable={s} />}
            </Stack>
          </Card>
        )}
      </VStack>
    </Card>
  )
}
