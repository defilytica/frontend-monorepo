'use client'

import {
  Badge,
  Box,
  Button,
  Card,
  Divider,
  Flex,
  HStack,
  Heading,
  SimpleGrid,
  Stack,
  Text,
  VStack,
} from '@chakra-ui/react'
import Link from 'next/link'
import { ArrowUpRight } from 'react-feather'
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

// Block-explorer URL stems per chain (mirrors the per-chain map in
// PoolEventLog so the analytics surface uses one address-link target).
const EXPLORER_ADDRESS_URL: Partial<Record<string, string>> = {
  MAINNET: 'https://etherscan.io/address/',
  ARBITRUM: 'https://arbiscan.io/address/',
  AVALANCHE: 'https://snowtrace.io/address/',
  BASE: 'https://basescan.org/address/',
  GNOSIS: 'https://gnosisscan.io/address/',
  OPTIMISM: 'https://optimistic.etherscan.io/address/',
  POLYGON: 'https://polygonscan.com/address/',
  SEPOLIA: 'https://sepolia.etherscan.io/address/',
  FRAXTAL: 'https://fraxscan.com/address/',
  MODE: 'https://explorer.mode.network/address/',
  ZKEVM: 'https://zkevm.polygonscan.com/address/',
  SONIC: 'https://sonicscan.org/address/',
  HYPEREVM: 'https://hyperliquid.cloud.blockscout.com/address/',
  PLASMA: 'https://plasmascan.to/address/',
  MONAD: 'https://testnet.monadexplorer.com/address/',
}

const ZERO_ADDR = '0x0000000000000000000000000000000000000000'

function shortAddr(addr: string): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`
}

function AddressLink({
  address,
  chain,
  zeroLabel = 'Balancer DAO',
  zeroHint = 'Controlled by the Authorizer (Omni governance)',
}: {
  address: string | null
  chain: string
  /** Label shown when `address` is `0x000…000`. Manager roles delegate
   *  to the DAO Authorizer at the zero address, not "no one"; factories
   *  override this to `"—"` since address(0) there really means missing. */
  zeroLabel?: string
  zeroHint?: string
}): React.JSX.Element {
  if (!address || address.toLowerCase() === ZERO_ADDR) {
    return (
      <Text color="font.secondary" fontSize="sm" title={zeroHint}>
        {zeroLabel}
      </Text>
    )
  }
  const base = EXPLORER_ADDRESS_URL[chain]
  const label = shortAddr(address)
  if (!base) {
    return (
      <Text fontFamily="mono" fontSize="sm">
        {label}
      </Text>
    )
  }
  return (
    <Link href={`${base}${address}`} rel="noreferrer" target="_blank">
      <Flex
        _hover={{ color: 'font.linkHover' }}
        align="center"
        color="font.link"
        fontFamily="mono"
        fontSize="sm"
        gap="2xs"
        transition="color 0.15s"
      >
        {label}
        <ArrowUpRight size={12} />
      </Flex>
    </Link>
  )
}

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
 *  weight array length doesn't line up with the api-v3 token list.
 *  Rendered as `StateRow`s so weights align on the same value tab as every
 *  other key/value row in the panel. */
function WeightRows({
  weights,
  tokens,
}: {
  weights: string[]
  tokens: Token[]
}): React.JSX.Element {
  return (
    <VStack align="stretch" spacing="sm" w="full">
      {weights.map((w, i) => (
        <StateRow
          key={i}
          label={tokens[i]?.symbol ?? `token ${i}`}
          value={formatWeightPct(w)}
        />
      ))}
    </VStack>
  )
}

/**
 * Flat panel section — no inner Card, no double-border. Adopts the
 * frontend-v3 PoolAttributes pattern: small heading, divider, then a
 * list of key/value rows. Visually distinct from neighbouring sections
 * via the outer Card's divider stack, not an inner border.
 */
/**
 * Self-contained section card. Each section (Fee parameters, Permissions,
 * Weights, ECLP, reCLAMM, …) renders as its own free-standing Card so
 * `PoolStatePanel` can lay them out in a `SimpleGrid` — independent
 * grouping, no single-column tower of rows, and visually obvious which
 * params belong together.
 */
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
    <Card h="full" overflow="hidden" p={{ base: 'md', md: 'md' }} variant="subSection">
      <VStack align="stretch" h="full" spacing="sm" w="full">
        <Flex align="center" justify="space-between">
          <Heading fontSize="md" variant="h4">
            {title}
          </Heading>
          {badge}
        </Flex>
        <Divider opacity={0.4} />
        <Stack align="stretch" spacing="sm" w="full">
          {children}
        </Stack>
      </VStack>
    </Card>
  )
}

// ── Manage-parameters deep links to ops.balancer.fi ──────────────────
//
// Builders shipped by the Balancer ops team. Per-pool links carry both
// the network slug (lowercase GqlChain — matches ops.balancer.fi's
// convention) and the 20-byte address.

const OPS_BASE = 'https://ops.balancer.fi'

type ManageLink = { label: string; hint: string; href: string }

/** Inline action button — appended after the rows of a section card to
 *  give users a direct deep-link into ops.balancer.fi's payload builder
 *  for whatever that section controls. Looks like a standard Chakra
 *  outline Button (label left, external-link icon right). */
function ManageButton({ link }: { link: ManageLink }): React.JSX.Element {
  return (
    // `alignSelf='flex-start'` keeps the button content-width — the parent
    // section Stack is `align='stretch'`, which would otherwise force it to
    // span the whole card. `tertiary` is the monorepo's neutral action
    // variant (background.level3 + shadow); reads as a real button against
    // the subSection card.
    <Button
      alignSelf="flex-start"
      as="a"
      fontWeight={500}
      href={link.href}
      rel="noreferrer"
      rightIcon={<ArrowUpRight size={14} />}
      size="sm"
      target="_blank"
      title={link.hint}
      variant="tertiary"
    >
      {link.label}
    </Button>
  )
}

/**
 * Permissions + deployment metadata sourced from api-v3 (factory,
 * swapFeeManager, pauseManager, poolCreator, version). Always renders
 * for a successfully resolved pool — answers "who can change what?"
 * which the existing "current values" cards above don't.
 */
function PermissionsSection({
  poolDetail,
}: {
  poolDetail: PoolPageData['poolDetail']
}): React.JSX.Element {
  const chain = poolDetail.chain as string
  const showVersion = typeof poolDetail.version === 'number' && poolDetail.version > 0
  return (
    // Single-column inside the section card — Permissions sits in a
    // half-width grid cell on lg+, so a 2-column inner grid would push
    // labels and addresses uncomfortably tight.
    <TypeSection title="Permissions & deployment">
      {showVersion && (
        <StateRow
          hint="protocol sub-version"
          label="Version"
          value={`v${poolDetail.protocolVersion}.${poolDetail.version}`}
        />
      )}
      <StateRow
        hint="deployer contract"
        label="Factory"
        value={
          <AddressLink
            address={poolDetail.factory}
            chain={chain}
            zeroHint="No factory recorded"
            zeroLabel="—"
          />
        }
      />
      <StateRow
        hint="can change the swap fee"
        label="Swap-fee manager"
        value={<AddressLink address={poolDetail.swapFeeManager} chain={chain} />}
      />
      <StateRow
        hint="can pause the pool"
        label="Pause manager"
        value={<AddressLink address={poolDetail.pauseManager} chain={chain} />}
      />
      <StateRow
        hint="original creator"
        label="Pool creator"
        value={<AddressLink address={poolDetail.poolCreator} chain={chain} />}
      />
    </TypeSection>
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

function ReclammSection({
  rc,
  manageButton,
}: {
  rc: ReclammTypeState
  manageButton?: React.ReactNode
}): React.JSX.Element {
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
        <>
          <StateRow
            hint="price-ratio update start"
            label="Update from"
            value={`${formatScaled(rc.priceRatio.start)} · ${formatTimestamp(rc.priceRatio.startTime)}`}
          />
          <StateRow
            hint="price-ratio update target"
            label="Update to"
            value={`${formatScaled(rc.priceRatio.end)} · ${formatTimestamp(rc.priceRatio.endTime)}`}
          />
        </>
      )}
      {manageButton}
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
        <Box>
          <Text fontSize="xs" mb="sm" variant="secondary">
            Gradual update · {formatTimestamp(lbp.update.startTime)} →{' '}
            {formatTimestamp(lbp.update.endTime)}
          </Text>
          <VStack align="stretch" spacing="sm" w="full">
            {lbp.update.startWeights.map((sw, i) => (
              <StateRow
                key={i}
                label={tokens[i]?.symbol ?? `token ${i}`}
                value={`${formatWeightPct(sw)} → ${formatWeightPct(lbp.update.endWeights[i] ?? '0')}`}
              />
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

function StableSurgeSection({
  ss,
  manageButton,
}: {
  ss: StableSurgeState
  manageButton?: React.ReactNode
}): React.JSX.Element {
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
      {manageButton}
    </TypeSection>
  )
}

// Fixed pixel width for the label column on `md+`. Using exact width
// (not `minWidth`) so every section's rows align to the same x-position
// regardless of label content. 180px comfortably fits every label we
// render today (longest are ~130px — "Pool-creator yield", "Swap-fee
// manager", "Aggregate swap fee") with extra breathing room before the
// value column.
const STATE_LABEL_WIDTH = '280px'

function StateRow({
  label,
  value,
  hint,
}: {
  label: string
  value: string | React.ReactNode
  hint?: string
}): React.JSX.Element {
  // Mirrors frontend-v3 `PoolAttributes` row exactly: `direction='row'`
  // on `md+` with no `align` prop (Chakra's default `flex-start` lines
  // the value's first text line up with the label's first text line),
  // a fixed-width label box on `md+`, `:` suffix on the label, and the
  // value sitting flush after a `1.3rem` spacing gap (md + 30%). No `flex`
  // or `textAlign='right'` on the value — values therefore start at the
  // same x position across every row.
  return (
    <Stack
      direction={{ base: 'column', md: 'row' }}
      spacing={{ base: '2xs', md: '1.3rem' }}
      w="full"
    >
      <Box flexShrink={0} w={{ md: STATE_LABEL_WIDTH }}>
        <Text color="font.secondary" fontSize="sm">
          {label}:
        </Text>
        {hint && (
          <Text color="font.secondary" fontSize="2xs" opacity={0.7}>
            {hint}
          </Text>
        )}
      </Box>
      {typeof value === 'string' ? (
        <Text fontFamily="mono" fontSize="sm" minW={0} wordBreak="break-word">
          {value}
        </Text>
      ) : (
        <Box fontFamily="mono" fontSize="sm" minW={0}>
          {value}
        </Box>
      )}
    </Stack>
  )
}

/**
 * Amp factor + ramp schedule rows. Shared between V3 and V2 stable pools
 * since the `StableTypeState` shape is identical — V2 just synthesizes a
 * degenerate ramp (start == end, both times 0) which the ramp-schedule
 * block conditionally hides.
 */
function AmpFactorRows({ stable: s }: { stable: StableTypeState }): React.JSX.Element {
  const showRamp =
    s.amplificationState.endTime > 0 &&
    s.amplificationState.startValue !== s.amplificationState.endValue
  const precision = s.amplificationParameter.precision
  return (
    <>
      <Divider />
      <StateRow
        hint={s.amplificationParameter.isUpdating ? 'ramping' : 'static'}
        label="Amp factor"
        value={
          <HStack spacing="xs">
            <Text fontFamily="mono" fontSize="sm">
              {formatAmp(s.amplificationParameter.value, precision)}
            </Text>
            {s.amplificationParameter.isUpdating && (
              <Badge colorScheme="purple" size="sm">
                updating
              </Badge>
            )}
          </HStack>
        }
      />
      {/* Ramp start/target as plain StateRows so their values sit on the same
          160px tab as every other row (was a flush-right space-between block,
          which pushed the values far to the right of the tab). */}
      {showRamp && (
        <>
          <StateRow
            hint="ramp start"
            label="Ramp from"
            value={`${formatAmp(s.amplificationState.startValue, precision)} · ${formatTimestamp(s.amplificationState.startTime)}`}
          />
          <StateRow
            hint="ramp target"
            label="Ramp to"
            value={`${formatAmp(s.amplificationState.endValue, precision)} · ${formatTimestamp(s.amplificationState.endTime)}`}
          />
        </>
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

  // ── Inline manage buttons (ops.balancer.fi payload builders) ────────
  // Previously these lived in a dedicated "Manage parameters" card;
  // pulled into the relevant section cards now (fee setter → Fee
  // parameters, surge tuning → StableSurge hook, reCLAMM payload →
  // reCLAMM) so the card grid stays compact and each action sits next
  // to the values it changes.
  const opsNetwork = poolDetail.chain.toLowerCase()
  // All four payload builders below now accept `?network=&pool=` query
  // params to preload the target pool. Keep this consistent across every
  // ManageButton so users land on the correct pool's form, not an empty one.
  const opsQuery = `?network=${opsNetwork}&pool=${poolDetail.address}`
  const feeSetterButton = (
    <ManageButton
      link={
        poolDetail.protocolVersion === 3
          ? {
              label: 'Set static swap fee',
              hint: 'V3 fee-setter payload builder',
              href: `${OPS_BASE}/payload-builder/fee-setter-v3${opsQuery}`,
            }
          : {
              label: 'Set static swap fee',
              hint: 'V2 fee-setter payload builder',
              href: `${OPS_BASE}/payload-builder/fee-setter${opsQuery}`,
            }
      }
    />
  )
  const surgeManageButton = state.stableSurge ? (
    <ManageButton
      link={{
        label: 'Tune StableSurge thresholds',
        hint: 'Surge hook payload builder',
        href: `${OPS_BASE}/hooks/stable-surge${opsQuery}`,
      }}
    />
  ) : null
  const reclammManageButton = state.reclamm ? (
    <ManageButton
      link={{
        label: 'Manage reCLAMM',
        hint: 'reCLAMM payload builder',
        href: `${OPS_BASE}/payload-builder/reclamm${opsQuery}`,
      }}
    />
  ) : null
  // Amp-factor update is V3 STABLE-only.
  const ampUpdateButton =
    isV3 && s ? (
      <ManageButton
        link={{
          label: 'Update amp factor',
          hint: 'V3 amplification-factor update payload builder',
          href: `${OPS_BASE}/payload-builder/amp-factor-update-v3${opsQuery}`,
        }}
      />
    ) : null

  // Each `state.*` slot is at most one block per pool — gather the
  // type-specific Card to render in the grid as a single ReactNode so
  // the grid composition stays declarative below.
  let typeSpecificCard: React.ReactNode = null
  if (state.weighted) {
    typeSpecificCard = (
      <WeightedSection tokens={poolDetail.tokens} weighted={state.weighted} />
    )
  } else if (state.gyroEclp) {
    typeSpecificCard = <GyroEclpSection eclp={state.gyroEclp} />
  } else if (state.reclamm) {
    typeSpecificCard = (
      <ReclammSection manageButton={reclammManageButton} rc={state.reclamm} />
    )
  } else if (state.lbp) {
    typeSpecificCard = <LbpSection lbp={state.lbp} tokens={poolDetail.tokens} />
  } else if (state.quantAmm) {
    typeSpecificCard = <QuantAmmSection qa={state.quantAmm} tokens={poolDetail.tokens} />
  }

  return (
    // No outer Card — the heading floats above a grid of independent
    // section cards (frontend-v3 PoolInfo pattern). Manage stays
    // full-width because its action rows benefit from horizontal space;
    // the rest live in a 2-column grid that wraps on narrow viewports.
    <VStack align="stretch" spacing="md" w="full">
      <Flex align="center" justify="space-between">
        <Heading fontSize="1.25rem" variant="h4">
          Current state
        </Heading>
        {hasAnyState && (
          <HStack spacing="xs">
            {isPaused && <Badge colorScheme="red">paused</Badge>}
            {isInRecovery && <Badge colorScheme="orange">recovery</Badge>}
            {!isPaused && !isInRecovery && <Badge colorScheme="green">active</Badge>}
          </HStack>
        )}
      </Flex>

      {isV3 && !u && (
        <Text color="font.secondary" fontSize="sm">
          Current state unavailable — VaultExplorer not configured for {poolDetail.chain}.
        </Text>
      )}

      {isV2 && !v2 && (
        <Text color="font.secondary" fontSize="sm">
          Current state unavailable — V2 pool reads failed.
        </Text>
      )}

      {/* Section cards — each is a peer in the 2-col grid. Manage
          actions live inside the section they affect rather than in a
          separate Manage card (fee setter → Fee parameters; surge
          tuning → StableSurge hook; reCLAMM payload → reCLAMM). */}
      <SimpleGrid columns={{ base: 1, lg: 2 }} spacing="md" w="full">
        {u && (
          <TypeSection title="Fee parameters">
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
            {feeSetterButton}
            {ampUpdateButton}
          </TypeSection>
        )}

        {v2 && (
          <TypeSection title="Fee parameters">
            <StateRow label="Swap fee" value={formatPercent(v2.swapFeePercentage)} />
            {v2.protocolSwapFeeCache !== null && (
              <StateRow
                hint="last cached value on this pool"
                label="Protocol swap fee"
                value={formatPercent(v2.protocolSwapFeeCache)}
              />
            )}
            {v2.protocolYieldFeeCache !== null && v2.protocolYieldFeeCache !== '0' && (
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
            {feeSetterButton}
          </TypeSection>
        )}

        <PermissionsSection poolDetail={poolDetail} />

        {typeSpecificCard}

        {state.stableSurge && (
          <StableSurgeSection manageButton={surgeManageButton} ss={state.stableSurge} />
        )}
      </SimpleGrid>
    </VStack>
  )
}
