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
import type {
  GyroEclpTypeState,
  LbpTypeState,
  QuantAmmTypeState,
  ReclammTypeState,
  StableSurgeState,
  StableTypeState,
  WeightedTypeState,
} from '@analytics/lib/pool-state/read'
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

// 1e18-scaled fixed-point → plain decimal (e.g. ECLP alpha, price ratio).
function formatScaled(value: string, maxFrac = 4): string {
  const n = Number(value) / 1e18
  if (!Number.isFinite(n)) return '—'
  return n.toLocaleString(undefined, { maximumFractionDigits: maxFrac })
}

// 1e18-scaled weight → percentage with 2 decimals (e.g. "64.64%").
function formatWeightPct(value: string): string {
  const n = Number(value) / 1e18
  if (!Number.isFinite(n)) return '—'
  return `${(n * 100).toFixed(2).replace(/\.?0+$/, '')}%`
}

function formatDuration(seconds: number): string {
  if (!seconds) return '—'
  const d = seconds / 86400
  return `${seconds.toLocaleString()} s · ~${d.toLocaleString(undefined, { maximumFractionDigits: 1 })} d`
}

type Token = { symbol: string }

/** Token-labelled weight rows. Falls back to positional labels when the
 *  weight array length doesn't line up with the api-v3 token list. */
function WeightRows({
  weights,
  tokens,
}: {
  weights: string[]
  tokens: Token[]
}): React.JSX.Element {
  return (
    <VStack align="stretch" spacing="2xs">
      {weights.map((w, i) => (
        <Flex justify="space-between" key={i}>
          <Text fontSize="xs" variant="secondary">
            {tokens[i]?.symbol ?? `token ${i}`}
          </Text>
          <Text fontFamily="mono" fontSize="xs">
            {formatWeightPct(w)}
          </Text>
        </Flex>
      ))}
    </VStack>
  )
}

function TypeSection({
  title,
  badge,
  children,
}: {
  title: string
  badge?: React.ReactNode
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <Card p={{ base: 'sm', md: 'md' }} variant="subSection">
      <Flex align="center" justify="space-between" mb="sm">
        <Text fontSize="xs" fontWeight="600" textTransform="uppercase" variant="secondary">
          {title}
        </Text>
        {badge}
      </Flex>
      <Stack divider={<Divider />} spacing="sm">
        {children}
      </Stack>
    </Card>
  )
}

function WeightedSection({
  weighted,
  tokens,
}: {
  weighted: WeightedTypeState
  tokens: Token[]
}): React.JSX.Element {
  return (
    <TypeSection title="Weights">
      <WeightRows tokens={tokens} weights={weighted.normalizedWeights} />
    </TypeSection>
  )
}

function GyroEclpSection({ eclp }: { eclp: GyroEclpTypeState }): React.JSX.Element {
  return (
    <TypeSection title="ECLP parameters">
      <StateRow hint="lower price bound" label="alpha" value={formatScaled(eclp.alpha)} />
      <StateRow hint="upper price bound" label="beta" value={formatScaled(eclp.beta)} />
      <StateRow hint="stretching factor" label="lambda" value={formatScaled(eclp.lambda)} />
      <StateRow hint="rotation cos" label="c" value={formatScaled(eclp.c)} />
      <StateRow hint="rotation sin" label="s" value={formatScaled(eclp.s)} />
    </TypeSection>
  )
}

function ReclammSection({ rc }: { rc: ReclammTypeState }): React.JSX.Element {
  const updateActive =
    rc.priceRatio.endTime > 0 && rc.priceRatio.start !== rc.priceRatio.end
  return (
    <TypeSection
      badge={
        <Badge colorScheme={rc.isWithinTargetRange ? 'green' : 'orange'} size="sm">
          {rc.isWithinTargetRange ? 'in range' : 'out of range'}
        </Badge>
      }
      title="reCLAMM"
    >
      <StateRow
        hint="current max/min price spread"
        label="Price ratio"
        value={formatScaled(rc.currentPriceRatio)}
      />
      <StateRow
        label="Centeredness margin"
        value={formatWeightPct(rc.centerednessMargin)}
      />
      <StateRow
        hint="max daily price-range drift"
        label="Daily price shift"
        value={formatWeightPct(rc.dailyPriceShiftExponent)}
      />
      {updateActive && (
        <Box borderColor="border.base" borderLeft="2px solid" pl="md">
          <Text fontSize="xs" mb="xs" variant="secondary">
            Price-ratio update
          </Text>
          <VStack align="stretch" spacing="2xs">
            <Flex justify="space-between">
              <Text fontSize="xs" variant="secondary">
                start
              </Text>
              <Text fontFamily="mono" fontSize="xs">
                {formatScaled(rc.priceRatio.start)} · {formatTimestamp(rc.priceRatio.startTime)}
              </Text>
            </Flex>
            <Flex justify="space-between">
              <Text fontSize="xs" variant="secondary">
                end
              </Text>
              <Text fontFamily="mono" fontSize="xs">
                {formatScaled(rc.priceRatio.end)} · {formatTimestamp(rc.priceRatio.endTime)}
              </Text>
            </Flex>
          </VStack>
        </Box>
      )}
    </TypeSection>
  )
}

function LbpSection({
  lbp,
  tokens,
}: {
  lbp: LbpTypeState
  tokens: Token[]
}): React.JSX.Element {
  const hasSchedule = lbp.update.startTime > 0
  return (
    <TypeSection
      badge={
        <Badge colorScheme={lbp.swapEnabled ? 'green' : 'gray'} size="sm">
          {lbp.swapEnabled ? 'swaps enabled' : 'swaps disabled'}
        </Badge>
      }
      title="LBP weights"
    >
      <Box>
        <Text fontSize="xs" mb="xs" variant="secondary">
          Current
        </Text>
        <WeightRows tokens={tokens} weights={lbp.normalizedWeights} />
      </Box>
      {hasSchedule && (
        <Box borderColor="border.base" borderLeft="2px solid" pl="md">
          <Text fontSize="xs" mb="xs" variant="secondary">
            Gradual update · {formatTimestamp(lbp.update.startTime)} →{' '}
            {formatTimestamp(lbp.update.endTime)}
          </Text>
          <VStack align="stretch" spacing="2xs">
            {lbp.update.startWeights.map((sw, i) => (
              <Flex justify="space-between" key={i}>
                <Text fontSize="xs" variant="secondary">
                  {tokens[i]?.symbol ?? `token ${i}`}
                </Text>
                <Text fontFamily="mono" fontSize="xs">
                  {formatWeightPct(sw)} → {formatWeightPct(lbp.update.endWeights[i] ?? '0')}
                </Text>
              </Flex>
            ))}
          </VStack>
        </Box>
      )}
    </TypeSection>
  )
}

function QuantAmmSection({
  qa,
  tokens,
}: {
  qa: QuantAmmTypeState
  tokens: Token[]
}): React.JSX.Element {
  return (
    <TypeSection
      badge={
        <Badge colorScheme={qa.withinFixWindow ? 'purple' : 'gray'} size="sm">
          {qa.withinFixWindow ? 'in fix window' : 'free'}
        </Badge>
      }
      title="QuantAMM weights"
    >
      <Box>
        <Text fontSize="xs" mb="xs" variant="secondary">
          Current (dynamic)
        </Text>
        <WeightRows tokens={tokens} weights={qa.normalizedWeights} />
      </Box>
      <StateRow
        hint="oracle staleness threshold"
        label="Oracle window"
        value={formatDuration(qa.oracleStalenessThreshold)}
      />
    </TypeSection>
  )
}

function StableSurgeSection({ ss }: { ss: StableSurgeState }): React.JSX.Element {
  return (
    <TypeSection title="StableSurge hook">
      <StateRow
        hint="imbalance above which surge applies"
        label="Surge threshold"
        value={formatPercent(ss.surgeThresholdPercentage)}
      />
      <StateRow
        hint="max swap fee while surging"
        label="Max surge fee"
        value={formatPercent(ss.maxSurgeFeePercentage)}
      />
    </TypeSection>
  )
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
    <Flex align="baseline" flexWrap="wrap" gap="sm" justify="space-between">
      <VStack align="flex-start" minW={0} spacing="0">
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
        <Text
          fontFamily="mono"
          fontSize="sm"
          textAlign="right"
          wordBreak="break-word"
        >
          {value}
        </Text>
      ) : (
        <Box fontFamily="mono" fontSize="sm" textAlign="right">
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
              <Flex flexWrap="wrap" gap="sm" justify="space-between">
                <Text fontSize="xs" variant="secondary">
                  start
                </Text>
                <Text
                  fontFamily="mono"
                  fontSize="xs"
                  textAlign="right"
                  wordBreak="break-word"
                >
                  {formatAmp(
                    s.amplificationState.startValue,
                    s.amplificationParameter.precision
                  )}{' '}
                  · {formatTimestamp(s.amplificationState.startTime)}
                </Text>
              </Flex>
              <Flex flexWrap="wrap" gap="sm" justify="space-between">
                <Text fontSize="xs" variant="secondary">
                  end
                </Text>
                <Text
                  fontFamily="mono"
                  fontSize="xs"
                  textAlign="right"
                  wordBreak="break-word"
                >
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
          <Card p={{ base: 'sm', md: 'md' }} variant="subSection">
            <Text color="font.secondary" fontSize="sm">
              Current state unavailable — VaultExplorer not configured for {poolDetail.chain}.
            </Text>
          </Card>
        )}

        {isV2 && !v2 && (
          <Card p={{ base: 'sm', md: 'md' }} variant="subSection">
            <Text color="font.secondary" fontSize="sm">
              Current state unavailable — V2 pool reads failed.
            </Text>
          </Card>
        )}

        {u && (
          <Card p={{ base: 'sm', md: 'md' }} variant="subSection">
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

        {/* V3 type-specific lower section — at most one type block, plus the
            additive StableSurge block on stable pools that have the hook. */}
        {state.weighted && (
          <WeightedSection tokens={poolDetail.tokens} weighted={state.weighted} />
        )}
        {state.gyroEclp && <GyroEclpSection eclp={state.gyroEclp} />}
        {state.reclamm && <ReclammSection rc={state.reclamm} />}
        {state.lbp && <LbpSection lbp={state.lbp} tokens={poolDetail.tokens} />}
        {state.quantAmm && (
          <QuantAmmSection qa={state.quantAmm} tokens={poolDetail.tokens} />
        )}
        {state.stableSurge && <StableSurgeSection ss={state.stableSurge} />}

        {v2 && (
          <Card p={{ base: 'sm', md: 'md' }} variant="subSection">
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
