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
  BufferState,
  GyroEclpTypeState,
  LbpTypeState,
  QuantAmmTypeState,
  ReclammTypeState,
  StableSurgeState,
  StableTypeState,
  WeightedTypeState,
} from '@analytics/lib/pool-state/read'
import type { PoolDetailToken, PoolPageData } from '../page'

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
 * Weights, ECLP, AutoRange, …) renders as its own free-standing Card so
 * `PoolStatePanel` can lay them out in a `SimpleGrid` — independent
 * grouping, no single-column tower of rows, and visually obvious which
 * params belong together. Sections with `wide` request the full row
 * (both columns on `lg+`) — used for AutoRange where the distribution
 * bar needs horizontal room to read clearly.
 */
function TypeSection({
  title,
  badge,
  wide,
  children,
}: {
  title: string
  badge?: React.ReactNode
  /** When true, the section spans both columns on `lg+`. Other breakpoints
   *  are unaffected (the grid is already single-column on `base`/`md`). */
  wide?: boolean
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <Card
      gridColumn={wide ? { lg: 'span 2' } : undefined}
      h="full"
      overflow="hidden"
      p={{ base: 'md', md: 'md' }}
      variant="subSection"
    >
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

// ── AutoRange math — margin balances in scaled-balance space ───────────
//
// Direct port of frontend-v3's `reclAmmMath.ts` (calculateLower/UpperMargin).
// These compute the *balances* of token A at which centeredness equals the
// configured margin from above and below; in price space (via `invariant /
// balance²`) those map to the "low target" and "high target" edges of the
// in-range green band on the distribution bar. Pure functions.
function autoRangeLowerMarginBalance(
  marginPercentage: number,
  invariant: number,
  vA: number,
  vB: number
): number {
  const m = marginPercentage / 100
  const b = vA + m * vA
  const c = m * (vA * vA - (invariant * vA) / vB)
  return vA + (-b + Math.sqrt(b * b - 4 * c)) / 2
}
function autoRangeUpperMarginBalance(
  marginPercentage: number,
  invariant: number,
  vA: number,
  vB: number
): number {
  const m = marginPercentage / 100
  const b = (vA + m * vA) / m
  const c = (vA * vA - (vA * invariant) / vB) / m
  return vA + (-b + Math.sqrt(b * b - 4 * c)) / 2
}

const autoRangePriceFmt = (n: number): string => {
  if (!Number.isFinite(n)) return '—'
  return n.toLocaleString(undefined, { maximumSignificantDigits: 4 })
}

/**
 * Concentrated-liquidity distribution bar. Three proportional segments
 * across the full active range [min, max]:
 *
 *     [orange margin] [GREEN target] [orange margin]
 *                            ●
 *
 * Each segment's width tracks the actual price gap it covers. A vertical
 * marker overlays the current spot price; its color reflects status
 * (green in target, orange in margin, red if the spot escapes [min,max]).
 *
 * Boundary labels live OUTSIDE this component — surfaced in the section
 * card as a clean horizontal strip. Keeping the bar visualization-only
 * is what makes it readable inside a card's tight footprint.
 */
function AutoRangeDistroBar({
  minPrice,
  lowTarget,
  highTarget,
  maxPrice,
  spotPrice,
  isInRange,
}: {
  minPrice: number
  /** Lower edge of the green band ("Low target"). Comes from
   *  `invariant / upperMarginBalance²`. */
  lowTarget: number
  /** Upper edge of the green band ("High target"). */
  highTarget: number
  maxPrice: number
  spotPrice: number
  isInRange: boolean
}): React.JSX.Element {
  const range = maxPrice - minPrice
  const hasData =
    Number.isFinite(minPrice) &&
    Number.isFinite(maxPrice) &&
    Number.isFinite(lowTarget) &&
    Number.isFinite(highTarget) &&
    range > 0 &&
    lowTarget >= minPrice &&
    highTarget <= maxPrice &&
    lowTarget <= highTarget

  const leftOrangeW = hasData ? ((lowTarget - minPrice) / range) * 100 : 100 / 3
  const greenW = hasData ? ((highTarget - lowTarget) / range) * 100 : 100 / 3
  const rightOrangeW = hasData ? ((maxPrice - highTarget) / range) * 100 : 100 / 3

  const spotInside =
    Number.isFinite(spotPrice) && spotPrice >= minPrice && spotPrice <= maxPrice
  const spotPct = !Number.isFinite(spotPrice)
    ? null
    : spotPrice < minPrice
      ? 0
      : spotPrice > maxPrice
        ? 100
        : ((spotPrice - minPrice) / range) * 100

  const markerColor = !spotInside
    ? 'red.400'
    : isInRange
      ? 'green.300'
      : 'orange.300'

  return (
    <Box h="36px" position="relative" w="full">
      {/* The bar — taller (24px) so the colored segments read at a glance. */}
      <Flex
        borderColor="background.level0"
        borderWidth="1px"
        h="24px"
        overflow="hidden"
        position="absolute"
        rounded="md"
        top="6px"
        w="full"
      >
        <Box
          bgGradient="linear(to-b, orange.300, orange.500)"
          h="full"
          w={`${leftOrangeW}%`}
        />
        <Box
          bgGradient="linear(to-b, green.300, green.500)"
          h="full"
          w={`${greenW}%`}
        />
        <Box
          bgGradient="linear(to-b, orange.300, orange.500)"
          h="full"
          w={`${rightOrangeW}%`}
        />
      </Flex>
      {/* Spot marker — a thin vertical line capped with a dot on top.
          The dot's color signals status without needing text. */}
      {spotPct !== null && (
        <>
          <Box
            bg={markerColor}
            boxShadow="0 0 0 1px var(--chakra-colors-background-level0)"
            h="36px"
            left={`${spotPct}%`}
            position="absolute"
            rounded="sm"
            top="0"
            transform="translateX(-50%)"
            w="2px"
            zIndex={1}
          />
          <Box
            bg={markerColor}
            border="2px solid"
            borderColor="background.level0"
            boxShadow="md"
            h="10px"
            left={`${spotPct}%`}
            position="absolute"
            rounded="full"
            top="-2px"
            transform="translateX(-50%)"
            w="10px"
            zIndex={2}
          />
        </>
      )}
    </Box>
  )
}

/** Compact boundary chip — small "label · value" pair shown beneath the
 *  distribution bar. Four of these line up in a SimpleGrid so prices are
 *  readable at-a-glance without crowding the bar itself. */
function BoundaryChip({
  label,
  value,
  unit,
  emphasis,
}: {
  label: string
  value: number
  unit: string
  /** Spot price gets a colored value to match the bar's marker — every
   *  other chip stays neutral so the spot is the visual lead. */
  emphasis?: 'spot' | 'in-range' | 'out-of-range' | 'out-of-bounds'
}): React.JSX.Element {
  const valueColor =
    emphasis === 'out-of-bounds'
      ? 'red.400'
      : emphasis === 'in-range'
        ? 'green.300'
        : emphasis === 'out-of-range'
          ? 'orange.300'
          : undefined
  return (
    <VStack align="flex-start" spacing="2xs">
      <Text color="font.secondary" fontSize="xs">
        {label}
      </Text>
      <HStack align="baseline" spacing="xs">
        <Text color={valueColor} fontFamily="mono" fontSize="sm" fontWeight={500}>
          {autoRangePriceFmt(value)}
        </Text>
        <Text color="font.secondary" fontSize="2xs">
          {unit}
        </Text>
      </HStack>
    </VStack>
  )
}

function AutoRangeSection({
  rc,
  tokens,
  manageButton,
}: {
  rc: ReclammTypeState
  /** Pool tokens in registration order — tokens[0] = A, tokens[1] = B.
   *  Drives the unit label on the boundary chips (e.g. "USDC per WETH"). */
  tokens: Token[]
  manageButton?: React.ReactNode
}): React.JSX.Element {
  const updateActive =
    rc.priceRatio.endTime > 0 && rc.priceRatio.start !== rc.priceRatio.end

  // Convert all contract values to plain numbers in their natural units.
  // Live + virtual balances are 1e18-scaled by the Vault's internal
  // accounting; descaling once at the boundary lets the math read like
  // ordinary algebra. Centeredness margin is also 1e18-scaled; the math
  // function expects percent units, so divide by 1e16.
  const liveA = Number(rc.liveBalanceA) / 1e18
  const liveB = Number(rc.liveBalanceB) / 1e18
  const vA = Number(rc.virtualBalanceA) / 1e18
  const vB = Number(rc.virtualBalanceB) / 1e18
  const minPrice = Number(rc.minPrice) / 1e18
  const maxPrice = Number(rc.maxPrice) / 1e18
  const marginPct = Number(rc.centerednessMargin) / 1e16
  // Derive spot from the AMM curve: for a 50/50 weighted pool, spot price
  // (B per A) is `(liveB + virtualB) / (liveA + virtualA)`. Matches what
  // frontend-v3 does — and reliably avoids the `computeCurrentSpotPrice`
  // RPC call, which is absent on some older AutoRange deployments.
  const totalA = liveA + vA
  const totalB = liveB + vB
  const spotPrice = totalA > 0 ? totalB / totalA : NaN

  const invariant = (liveA + vA) * (liveB + vB)
  const lowerMarginBal =
    Number.isFinite(invariant) && vA > 0 && vB > 0 && marginPct > 0
      ? autoRangeLowerMarginBalance(marginPct, invariant, vA, vB)
      : NaN
  const upperMarginBal =
    Number.isFinite(invariant) && vA > 0 && vB > 0 && marginPct > 0
      ? autoRangeUpperMarginBalance(marginPct, invariant, vA, vB)
      : NaN
  // Lower balance of A → higher price ("High target", upper edge of green
  // band). Upper balance of A → lower price ("Low target", lower edge).
  const highTargetPrice = Number.isFinite(lowerMarginBal)
    ? invariant / (lowerMarginBal * lowerMarginBal)
    : NaN
  const lowTargetPrice = Number.isFinite(upperMarginBal)
    ? invariant / (upperMarginBal * upperMarginBal)
    : NaN

  const symbolA = tokens[0]?.symbol ?? 'A'
  const symbolB = tokens[1]?.symbol ?? 'B'
  const unit = `${symbolB} / ${symbolA}`

  const spotInside =
    Number.isFinite(spotPrice) &&
    Number.isFinite(minPrice) &&
    Number.isFinite(maxPrice) &&
    spotPrice >= minPrice &&
    spotPrice <= maxPrice
  const spotEmphasis: Parameters<typeof BoundaryChip>[0]['emphasis'] = !spotInside
    ? 'out-of-bounds'
    : rc.isWithinTargetRange
      ? 'in-range'
      : 'out-of-range'

  return (
    <TypeSection
      badge={
        <Badge colorScheme={rc.isWithinTargetRange ? 'green' : 'orange'} size="sm">
          {rc.isWithinTargetRange ? 'in range' : 'out of range'}
        </Badge>
      }
      title="AutoRange"
      wide
    >
      {/* Distribution bar — one big visual element, no labels on it. */}
      <AutoRangeDistroBar
        highTarget={highTargetPrice}
        isInRange={rc.isWithinTargetRange}
        lowTarget={lowTargetPrice}
        maxPrice={maxPrice}
        minPrice={minPrice}
        spotPrice={spotPrice}
      />

      {/* Five boundary chips — Min · Low target · Spot · High target · Max.
          SimpleGrid collapses to 3 columns on narrow widths so the spot
          stays prominent on every breakpoint. */}
      <SimpleGrid columns={{ base: 2, sm: 3, md: 5 }} spacing="sm" w="full">
        <BoundaryChip label="Min" unit={unit} value={minPrice} />
        <BoundaryChip label="Low target" unit={unit} value={lowTargetPrice} />
        <BoundaryChip
          emphasis={spotEmphasis}
          label="Spot"
          unit={unit}
          value={spotPrice}
        />
        <BoundaryChip label="High target" unit={unit} value={highTargetPrice} />
        <BoundaryChip label="Max" unit={unit} value={maxPrice} />
      </SimpleGrid>

      <Divider opacity={0.4} />

      {/* Parameter rows — standard StateRow layout matches every other
          section card so the page reads consistently. */}
      <StateRow
        hint="ratio of max to min price"
        label="Price ratio"
        value={formatScaled(rc.currentPriceRatio)}
      />
      <StateRow
        hint="threshold below which the pool starts shifting to recenter"
        label="Centeredness margin"
        value={formatWeightPct(rc.centerednessMargin)}
      />
      <StateRow
        hint="cap on daily drift of the bounds when out-of-center"
        label="Daily price shift"
        value={formatWeightPct(rc.dailyPriceShiftExponent)}
      />
      {rc.lastTimestamp > 0 && (
        <StateRow
          hint="bounds only update on interactions"
          label="Last interaction"
          value={formatTimestamp(rc.lastTimestamp)}
        />
      )}
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

// ── ERC4626 buffer section ─────────────────────────────────────────────
//
// One TypeSection per wrapped token. Each surfaces the Vault buffer's
// internal composition (underlying vs wrapped held by the buffer) plus
// the ERC4626 wrapper's own deposit/withdraw caps — both pieces are
// "current state" of how the pool can route swaps through this token.

const tokenCompact = new Intl.NumberFormat('en-US', {
  notation: 'compact',
  maximumFractionDigits: 2,
})

function formatTokenCompact(amount: number): string {
  if (!Number.isFinite(amount)) return '—'
  if (amount === 0) return '0'
  return tokenCompact.format(amount)
}

function parseNum(s: string | null | undefined): number {
  if (s == null) return NaN
  const n = Number(s)
  return Number.isFinite(n) ? n : NaN
}

/** Convert a raw u256 string to a human number using `decimals`. Loses
 *  precision past 2^53 but the display values we surface (USD-stable-
 *  pool buffers, ETH-likes) live well below that ceiling. */
function rawToHuman(raw: string | null, decimals: number): number {
  if (!raw || decimals < 0 || !Number.isFinite(decimals)) return NaN
  try {
    return Number(BigInt(raw)) / 10 ** decimals
  } catch {
    return NaN
  }
}

/** Tight horizontal capacity bar — fits inside a StateRow value column.
 *  Shows what fraction of the wrapper's cap the pool's current position
 *  occupies, with a small percentage readout above and the cap value
 *  beneath. Red when the pool position exceeds the cap (a full one-shot
 *  unwind would not fit). */
function CapacityBar({
  positionLabel,
  position,
  cap,
  unit,
}: {
  positionLabel: string
  position: number
  cap: number
  unit: string
}): React.JSX.Element {
  const hasData = Number.isFinite(position) && Number.isFinite(cap) && cap >= 0
  const overflow = hasData && cap > 0 ? position > cap : false
  const pct = !hasData
    ? 0
    : cap <= 0
      ? position > 0
        ? 100
        : 0
      : Math.min((position / cap) * 100, 100)
  return (
    <VStack align="stretch" spacing="2xs" w="full">
      <Flex align="center" justify="space-between">
        <Text color={overflow ? 'red.400' : 'font.secondary'} fontFamily="mono" fontSize="xs">
          {hasData ? `${pct.toFixed(1)}%` : '—'}
        </Text>
        <Text color="font.secondary" fontFamily="mono" fontSize="2xs">
          cap {formatTokenCompact(cap)} {unit}
        </Text>
      </Flex>
      <Box bg="background.level3" h="6px" overflow="hidden" rounded="sm" w="full">
        <Box
          bg={overflow ? 'red.500' : 'primary.500'}
          h="full"
          transition="width 0.3s ease"
          w={`${pct}%`}
        />
      </Box>
      <Text color="font.secondary" fontSize="2xs">
        {positionLabel}
      </Text>
    </VStack>
  )
}

/** Buffer composition bar — left segment = underlying balance, right =
 *  wrapped balance (converted to underlying units via priceRate).
 *  Surfaces the imbalance % so a reader can scan whether the next swap
 *  is likely to trigger a real wrap/unwrap on-chain. */
function BufferSplitBar({
  underlyingAmount,
  underlyingSymbol,
  wrappedAmountAsUnderlying,
  wrappedSymbol,
}: {
  underlyingAmount: number
  underlyingSymbol: string
  wrappedAmountAsUnderlying: number
  wrappedSymbol: string
}): React.JSX.Element {
  const total = underlyingAmount + wrappedAmountAsUnderlying
  const hasData = Number.isFinite(total) && total > 0
  const underlyingPct = hasData ? (underlyingAmount / total) * 100 : 0
  const wrappedPct = hasData ? 100 - underlyingPct : 0
  const imbalance = hasData ? Math.abs(underlyingPct - 50) : null
  const imbalanceColor =
    imbalance == null
      ? 'font.secondary'
      : imbalance >= 25
        ? 'red.400'
        : imbalance >= 10
          ? 'yellow.400'
          : 'green.400'
  return (
    <VStack align="stretch" spacing="2xs" w="full">
      <Flex align="center" justify="space-between">
        <Text color="font.secondary" fontFamily="mono" fontSize="xs">
          {hasData ? `${formatTokenCompact(total)} ${underlyingSymbol}` : '—'}
        </Text>
        <Text color={imbalanceColor} fontFamily="mono" fontSize="2xs">
          {imbalance == null ? '' : `${imbalance.toFixed(1)}% off 50/50`}
        </Text>
      </Flex>
      <Box bg="background.level3" h="8px" overflow="hidden" rounded="sm" w="full">
        <Flex h="full" w="full">
          <Box bg="primary.400" h="full" transition="width 0.3s ease" w={`${underlyingPct}%`} />
          <Box bg="purple.400" h="full" transition="width 0.3s ease" w={`${wrappedPct}%`} />
        </Flex>
      </Box>
      <HStack justify="space-between" spacing="xs">
        <HStack spacing="2xs">
          <Box bg="primary.400" h="2" rounded="sm" w="2" />
          <Text color="font.secondary" fontSize="2xs">
            {formatTokenCompact(underlyingAmount)} {underlyingSymbol}
          </Text>
        </HStack>
        <HStack spacing="2xs">
          <Box bg="purple.400" h="2" rounded="sm" w="2" />
          <Text color="font.secondary" fontSize="2xs">
            {formatTokenCompact(wrappedAmountAsUnderlying)} as {wrappedSymbol}
          </Text>
        </HStack>
      </HStack>
    </VStack>
  )
}

function BufferSection({
  token,
  buffer,
  manageButton,
}: {
  token: PoolDetailToken
  buffer: BufferState | null
  manageButton: React.ReactNode
}): React.JSX.Element {
  const priceRate = parseNum(token.priceRate)
  const balanceWrapped = parseNum(token.balance)
  const positionInUnderlying =
    Number.isFinite(balanceWrapped) && Number.isFinite(priceRate)
      ? balanceWrapped * priceRate
      : NaN
  const maxDeposit = parseNum(token.maxDeposit ?? '')
  const maxWithdraw = parseNum(token.maxWithdraw ?? '')
  const underlyingSymbol = token.underlyingToken?.symbol ?? '—'
  const underlyingDecimals = token.underlyingToken?.decimals ?? token.decimals

  const bufferUnderlying = buffer
    ? rawToHuman(buffer.underlyingBalanceRaw, underlyingDecimals)
    : NaN
  const bufferWrapped = buffer ? rawToHuman(buffer.wrappedBalanceRaw, token.decimals) : NaN
  const bufferWrappedAsUnderlying =
    Number.isFinite(bufferWrapped) && Number.isFinite(priceRate)
      ? bufferWrapped * priceRate
      : NaN

  const review = (token.erc4626ReviewData?.summary ?? '').toLowerCase()
  const reviewBadge =
    review === 'safe' ? (
      <Badge colorScheme="green" size="sm">
        safe
      </Badge>
    ) : review === 'unsafe' ? (
      <Badge colorScheme="red" size="sm">
        unsafe
      </Badge>
    ) : review ? (
      <Badge colorScheme="yellow" size="sm">
        {review}
      </Badge>
    ) : null

  const uninitialized = buffer?.isInitialized === false
  const initBadge = uninitialized ? (
    <Badge colorScheme="red" size="sm">
      uninitialized
    </Badge>
  ) : null

  const warnings = token.erc4626ReviewData?.warnings ?? []

  return (
    <TypeSection
      badge={
        <HStack spacing="xs">
          {initBadge}
          {reviewBadge}
        </HStack>
      }
      title={`Buffer: ${token.symbol} ↔ ${underlyingSymbol}`}
    >
      <StateRow
        hint="balanced 50/50 means most swaps avoid wrapping on-chain"
        label="Composition"
        value={
          buffer ? (
            <BufferSplitBar
              underlyingAmount={bufferUnderlying}
              underlyingSymbol={underlyingSymbol}
              wrappedAmountAsUnderlying={bufferWrappedAsUnderlying}
              wrappedSymbol={token.symbol}
            />
          ) : (
            'buffer read unavailable'
          )
        }
      />
      <StateRow
        hint="how much underlying the pool's wrapped position represents"
        label="Pool position"
        value={`${formatTokenCompact(positionInUnderlying)} ${underlyingSymbol}`}
      />
      <StateRow
        hint="how much can be deposited into the ERC4626 vault right now"
        label="Deposit headroom"
        value={
          <CapacityBar
            cap={maxDeposit}
            position={positionInUnderlying}
            positionLabel={`pool position ${formatTokenCompact(positionInUnderlying)} ${underlyingSymbol}`}
            unit={underlyingSymbol}
          />
        }
      />
      <StateRow
        hint="how much can be withdrawn from the ERC4626 vault right now"
        label="Withdraw headroom"
        value={
          <CapacityBar
            cap={maxWithdraw}
            position={positionInUnderlying}
            positionLabel={`pool position ${formatTokenCompact(positionInUnderlying)} ${underlyingSymbol}`}
            unit={underlyingSymbol}
          />
        }
      />
      {warnings.length > 0 && (
        <StateRow
          label="Warnings"
          value={
            <Text fontSize="xs" wordBreak="break-word">
              {warnings.join(' · ')}
            </Text>
          }
        />
      )}
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
  // parameters, surge tuning → StableSurge hook, AutoRange payload →
  // AutoRange) so the card grid stays compact and each action sits next
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
  const autoRangeManageButton = state.reclamm ? (
    <ManageButton
      link={{
        label: 'Manage AutoRange',
        // ops.balancer.fi's product is "AutoRange" but the live route is
        // still /payload-builder/reclamm (the /autorange slug 404s).
        hint: 'AutoRange payload builder',
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

  // Buffer sections — one section per ERC4626 token. The buffer-state
  // RPC read fires on the page and resolves to `null` for chains without
  // a VaultExplorer entry; the section renders capacity-bars-only in
  // that case so users still see maxDeposit/maxWithdraw context.
  const wrappedTokens = isV3 ? poolDetail.tokens.filter(t => t.isErc4626) : []
  const buffersByAddress = new Map<string, BufferState>()
  if (state.bufferStates) {
    for (const b of state.bufferStates) buffersByAddress.set(b.wrappedToken.toLowerCase(), b)
  }
  const bufferSections = wrappedTokens.map(token => (
    <BufferSection
      buffer={buffersByAddress.get(token.address.toLowerCase()) ?? null}
      key={token.address}
      manageButton={
        <ManageButton
          link={{
            label: 'Manage buffer',
            hint: 'Buffer management payload builder on ops.balancer.fi',
            href: `${OPS_BASE}/payload-builder/manage-buffer?network=${opsNetwork}&token=${token.address}`,
          }}
        />
      }
      token={token}
    />
  ))

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
      <AutoRangeSection
        manageButton={autoRangeManageButton}
        rc={state.reclamm}
        tokens={poolDetail.tokens}
      />
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
          tuning → StableSurge hook; AutoRange payload → AutoRange). */}
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

        {bufferSections}
      </SimpleGrid>
    </VStack>
  )
}
