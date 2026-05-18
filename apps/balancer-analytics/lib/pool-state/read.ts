/**
 * Current pool state via helper-contract `multicall`.
 *
 * Two-layer dispatch:
 *   1. `readUniversalV3State` — VaultExplorer reads common to every V3
 *      pool: swap fee, aggregate fees, paused, recovery mode. One
 *      multicall per pool.
 *   2. `readTypeSpecificState` — pool-type-aware extras (amp factor + ramp
 *      for Stable, weights for Weighted, surge params for StableSurge…).
 *      Phase B ships Stable only.
 *
 * Helper-contract addresses come from `lib/contracts/v3-addresses.ts`. When
 * an address is `null` (chain not yet populated), the corresponding read
 * returns `null` rather than throwing — the page degrades to chart +
 * event timeline only.
 */

import 'server-only'
import {
  type Abi,
  type Address,
  type ContractFunctionParameters,
  parseAbi,
} from 'viem'
import { GqlChain } from '@repo/lib/shared/services/api/generated/graphql'
import { getPublicClient } from '@analytics/lib/drpc/client'
import { getV3HelperAddresses } from '@analytics/lib/contracts/v3-addresses'

// Minimal ABIs — only the getters we actually call. Keeping them inlined
// (rather than re-importing the full deployed ABIs) makes the multicall
// type-safe and keeps bundle weight irrelevant.

const VAULT_EXPLORER_ABI = parseAbi([
  'function getStaticSwapFeePercentage(address pool) view returns (uint256)',
  'function getAggregateFeePercentages(address pool) view returns (uint256 swapFee, uint256 yieldFee)',
  'function isPoolPaused(address pool) view returns (bool)',
  'function isPoolInRecoveryMode(address pool) view returns (bool)',
]) satisfies Abi

const STABLE_POOL_ABI = parseAbi([
  'function getAmplificationParameter() view returns (uint256 value, bool isUpdating, uint256 precision)',
  'function getAmplificationState() view returns ((uint64 startValue, uint64 endValue, uint32 startTime, uint32 endTime) amplificationState, uint256 precision)',
]) satisfies Abi

const FEE_CONTROLLER_ABI = parseAbi([
  'function getPoolCreatorSwapFeePercentage(address pool) view returns (uint256)',
  'function getPoolCreatorYieldFeePercentage(address pool) view returns (uint256)',
]) satisfies Abi

// V2 pools emit their getters directly (no VaultExplorer in V2). All V2
// pool types — Weighted, Stable, ComposableStable, etc. — inherit the
// base-pool surface, so these readers work uniformly across them.
const V2_BASE_POOL_ABI = parseAbi([
  'function getSwapFeePercentage() view returns (uint256)',
  'function getPausedState() view returns (bool paused, uint256 pauseWindowEndTime, uint256 bufferPeriodEndTime)',
  'function inRecoveryMode() view returns (bool)',
  'function getProtocolFeePercentageCache(uint256 feeType) view returns (uint256)',
]) satisfies Abi

const V2_STABLE_POOL_ABI = parseAbi([
  'function getAmplificationParameter() view returns (uint256 value, bool isUpdating, uint256 precision)',
]) satisfies Abi

// V2 protocol-fee types (from balancer-v2-monorepo IProtocolFeePercentagesProvider).
// Used to query the per-pool fee cache. We don't expose the AUM type
// because no current pool surfaces it in analytics; add later if needed.
const V2_FEE_TYPE_SWAP = 0n
const V2_FEE_TYPE_YIELD = 2n

export type UniversalV3State = {
  swapFeePercentage: string
  aggregateSwapFeePercentage: string
  aggregateYieldFeePercentage: string
  poolCreatorSwapFeePercentage: string | null
  poolCreatorYieldFeePercentage: string | null
  isPaused: boolean
  isInRecoveryMode: boolean
}

export type V2BasePoolState = {
  swapFeePercentage: string
  isPaused: boolean
  pauseWindowEndTime: number
  bufferPeriodEndTime: number
  /** V2 added recovery mode mid-lifecycle — pre-fork pools don't implement
   *  `inRecoveryMode()` so the call may fail. `null` means "not exposed". */
  isInRecoveryMode: boolean | null
  /** Protocol swap fee cache (1e18-scaled). Reflects the snapshot of the
   *  protocol fee that was last committed for this pool. `null` if the
   *  pool doesn't implement the cache (older Weighted variants). */
  protocolSwapFeeCache: string | null
  /** Protocol yield fee cache. Same caveats as above; non-yield pools
   *  return zero rather than null. */
  protocolYieldFeeCache: string | null
}

export type StableTypeState = {
  amplificationParameter: {
    value: string
    isUpdating: boolean
    precision: string
  }
  amplificationState: {
    startValue: string
    endValue: string
    startTime: number
    endTime: number
    precision: string
  }
}

export async function readUniversalV3State(
  chain: GqlChain,
  poolAddress: Address
): Promise<UniversalV3State | null> {
  const helpers = getV3HelperAddresses(chain)
  if (!helpers?.vaultExplorer) return null

  const client = getPublicClient(chain)

  // Build multicall: 4 reads against VaultExplorer + 2 against the
  // ProtocolFeeController (when present).
  const explorerCalls: ContractFunctionParameters[] = [
    {
      address: helpers.vaultExplorer,
      abi: VAULT_EXPLORER_ABI,
      functionName: 'getStaticSwapFeePercentage',
      args: [poolAddress],
    },
    {
      address: helpers.vaultExplorer,
      abi: VAULT_EXPLORER_ABI,
      functionName: 'getAggregateFeePercentages',
      args: [poolAddress],
    },
    {
      address: helpers.vaultExplorer,
      abi: VAULT_EXPLORER_ABI,
      functionName: 'isPoolPaused',
      args: [poolAddress],
    },
    {
      address: helpers.vaultExplorer,
      abi: VAULT_EXPLORER_ABI,
      functionName: 'isPoolInRecoveryMode',
      args: [poolAddress],
    },
  ]

  const feeControllerCalls: ContractFunctionParameters[] = helpers.protocolFeeController
    ? [
        {
          address: helpers.protocolFeeController,
          abi: FEE_CONTROLLER_ABI,
          functionName: 'getPoolCreatorSwapFeePercentage',
          args: [poolAddress],
        },
        {
          address: helpers.protocolFeeController,
          abi: FEE_CONTROLLER_ABI,
          functionName: 'getPoolCreatorYieldFeePercentage',
          args: [poolAddress],
        },
      ]
    : []

  const results = await client.multicall({
    contracts: [...explorerCalls, ...feeControllerCalls],
    allowFailure: true,
  })

  // Bail if the core VaultExplorer reads failed — the pool likely isn't
  // registered on V3 (could be a V2 address that the caller passed by
  // mistake).
  if (results[0].status !== 'success') return null

  const swapFee = results[0].result as bigint
  const aggregate = results[1].result as readonly [bigint, bigint] | undefined
  const aggregateSwap = aggregate?.[0] ?? 0n
  const aggregateYield = aggregate?.[1] ?? 0n
  const paused = (results[2].result as boolean | undefined) ?? false
  const recovery = (results[3].result as boolean | undefined) ?? false

  let poolCreatorSwap: string | null = null
  let poolCreatorYield: string | null = null
  if (feeControllerCalls.length) {
    const swapResult = results[explorerCalls.length]
    const yieldResult = results[explorerCalls.length + 1]
    if (swapResult?.status === 'success') {
      poolCreatorSwap = (swapResult.result as bigint).toString()
    }
    if (yieldResult?.status === 'success') {
      poolCreatorYield = (yieldResult.result as bigint).toString()
    }
  }

  return {
    swapFeePercentage: swapFee.toString(),
    aggregateSwapFeePercentage: aggregateSwap.toString(),
    aggregateYieldFeePercentage: aggregateYield.toString(),
    poolCreatorSwapFeePercentage: poolCreatorSwap,
    poolCreatorYieldFeePercentage: poolCreatorYield,
    isPaused: paused,
    isInRecoveryMode: recovery,
  }
}

export async function readStableTypeState(
  chain: GqlChain,
  poolAddress: Address
): Promise<StableTypeState | null> {
  const client = getPublicClient(chain)
  const results = await client.multicall({
    contracts: [
      {
        address: poolAddress,
        abi: STABLE_POOL_ABI,
        functionName: 'getAmplificationParameter',
      },
      {
        address: poolAddress,
        abi: STABLE_POOL_ABI,
        functionName: 'getAmplificationState',
      },
    ],
    allowFailure: true,
  })

  if (results[0].status !== 'success') return null
  const param = results[0].result as readonly [bigint, boolean, bigint]
  const stateOk = results[1].status === 'success'
  const stateTuple = stateOk
    ? (results[1].result as readonly [
        { startValue: bigint; endValue: bigint; startTime: number; endTime: number },
        bigint,
      ])
    : null

  return {
    amplificationParameter: {
      value: param[0].toString(),
      isUpdating: param[1],
      precision: param[2].toString(),
    },
    amplificationState: stateTuple
      ? {
          startValue: stateTuple[0].startValue.toString(),
          endValue: stateTuple[0].endValue.toString(),
          startTime: Number(stateTuple[0].startTime),
          endTime: Number(stateTuple[0].endTime),
          precision: stateTuple[1].toString(),
        }
      : {
          // Fallback when `getAmplificationState` isn't available (older
          // pool variants): synthesize a degenerate state with the current
          // value so the inspector still renders without conditional UI.
          startValue: param[0].toString(),
          endValue: param[0].toString(),
          startTime: 0,
          endTime: 0,
          precision: param[2].toString(),
        },
  }
}

/**
 * Current state for every V2 pool type. Reads come from the pool contract
 * directly — no VaultExplorer in V2. All calls are wrapped in `allowFailure`
 * so a pre-fork pool that lacks `inRecoveryMode()` or the protocol fee
 * cache still returns a partial state object instead of throwing.
 */
export async function readV2BasePoolState(
  chain: GqlChain,
  poolAddress: Address
): Promise<V2BasePoolState | null> {
  const client = getPublicClient(chain)
  const results = await client.multicall({
    contracts: [
      {
        address: poolAddress,
        abi: V2_BASE_POOL_ABI,
        functionName: 'getSwapFeePercentage',
      },
      {
        address: poolAddress,
        abi: V2_BASE_POOL_ABI,
        functionName: 'getPausedState',
      },
      {
        address: poolAddress,
        abi: V2_BASE_POOL_ABI,
        functionName: 'inRecoveryMode',
      },
      {
        address: poolAddress,
        abi: V2_BASE_POOL_ABI,
        functionName: 'getProtocolFeePercentageCache',
        args: [V2_FEE_TYPE_SWAP],
      },
      {
        address: poolAddress,
        abi: V2_BASE_POOL_ABI,
        functionName: 'getProtocolFeePercentageCache',
        args: [V2_FEE_TYPE_YIELD],
      },
    ],
    allowFailure: true,
  })

  // If `getSwapFeePercentage` itself failed, the pool isn't a V2 pool we
  // can read — likely wrong protocol version or invalid address. Return
  // null so callers can decide whether to surface a placeholder.
  if (results[0].status !== 'success') return null

  const swapFee = results[0].result as bigint
  const pausedTuple = results[1].status === 'success'
    ? (results[1].result as readonly [boolean, bigint, bigint])
    : null
  const recoveryRaw = results[2].status === 'success' ? (results[2].result as boolean) : null
  const protocolSwap =
    results[3].status === 'success' ? (results[3].result as bigint).toString() : null
  const protocolYield =
    results[4].status === 'success' ? (results[4].result as bigint).toString() : null

  return {
    swapFeePercentage: swapFee.toString(),
    isPaused: pausedTuple?.[0] ?? false,
    pauseWindowEndTime: pausedTuple ? Number(pausedTuple[1]) : 0,
    bufferPeriodEndTime: pausedTuple ? Number(pausedTuple[2]) : 0,
    isInRecoveryMode: recoveryRaw,
    protocolSwapFeeCache: protocolSwap,
    protocolYieldFeeCache: protocolYield,
  }
}

/**
 * V2 Stable / ComposableStable amp factor. Reuses the V3 `StableTypeState`
 * shape because the inspector renders identically across versions. V2
 * doesn't expose `getAmplificationState()` (no scheduled ramp accessor) —
 * the inspector still works because we synthesize a degenerate state with
 * the current value, the same fallback path V3 uses for older variants.
 */
export async function readV2StableTypeState(
  chain: GqlChain,
  poolAddress: Address
): Promise<StableTypeState | null> {
  const client = getPublicClient(chain)
  const results = await client.multicall({
    contracts: [
      {
        address: poolAddress,
        abi: V2_STABLE_POOL_ABI,
        functionName: 'getAmplificationParameter',
      },
    ],
    allowFailure: true,
  })

  if (results[0].status !== 'success') return null
  const param = results[0].result as readonly [bigint, boolean, bigint]
  return {
    amplificationParameter: {
      value: param[0].toString(),
      isUpdating: param[1],
      precision: param[2].toString(),
    },
    amplificationState: {
      startValue: param[0].toString(),
      endValue: param[0].toString(),
      startTime: 0,
      endTime: 0,
      precision: param[2].toString(),
    },
  }
}
