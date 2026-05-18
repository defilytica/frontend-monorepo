/**
 * Pool detail page — parameter timeline + impact visualization.
 *
 * This is the analytics surface; it does NOT replace frontend-v3's pool
 * page (no swap / add-liquidity actions, no positions). The goal is to
 * align parameter-change events with metric series so a viewer can see
 * how a swap-fee or amp-factor change correlates with TVL / volume / fees
 * over the following days.
 *
 * Data flow:
 *   - api-v3 `poolGetPool`           — pool metadata for the header
 *   - api-v3 `poolGetSnapshots(90d)` — continuous metric series
 *   - `syncPoolEvents`                — drpc-derived event timeline
 *   - `readUniversalV3State` + `readStableTypeState` — current params via
 *     VaultExplorer + pool getters multicall
 *
 * Functions are called server-side directly (no HTTP roundtrip through
 * the /api routes) — the routes exist as a public surface for external
 * consumers / debugging, not as a coupling for the page.
 */

import { notFound } from 'next/navigation'
import type { Address } from 'viem'
import { GqlChain } from '@repo/lib/shared/services/api/generated/graphql'
import { PROJECT_CONFIG } from '@repo/lib/config/getProjectConfig'
import { ChainSlug, getChainSlug } from '@repo/lib/modules/pool/pool.utils'
import { isDrpcSupportedChain } from '@analytics/lib/contracts/drpc-endpoints'
import { syncPoolEvents } from '@analytics/lib/pool-events/sync'
import {
  readStableTypeState,
  readUniversalV3State,
  readV2BasePoolState,
  readV2StableTypeState,
  type StableTypeState,
  type UniversalV3State,
  type V2BasePoolState,
} from '@analytics/lib/pool-state/read'
import type { PoolParamEvent } from '@analytics/lib/pool-events/types'
import { scrubError } from '@analytics/lib/drpc/scrub'
import { PoolPageView } from './_components/PoolPageView'

export const dynamic = 'force-dynamic'

const API_URL =
  process.env.NEXT_PUBLIC_BALANCER_API_URL ?? 'https://api-v3.balancer.fi/graphql'

type RouteParams = { chain: string; id: string }

export type PoolDetail = {
  id: string
  address: string
  name: string
  symbol: string
  type: string
  protocolVersion: 1 | 2 | 3
  chain: GqlChain
  createTime: number
  tokens: { address: string; symbol: string; weight: string | null }[]
}

export type PoolSnapshot = {
  timestamp: number
  totalLiquidity: number
  volume24h: number
  fees24h: number
  surplus24h: number
  sharePrice: number
}

export type PoolPageData = {
  poolDetail: PoolDetail
  snapshots: PoolSnapshot[]
  events: PoolParamEvent[]
  lastBlock: number
  state: {
    universal: UniversalV3State | null
    stable: StableTypeState | null
    v2Base: V2BasePoolState | null
  }
}

const POOL_DETAIL_QUERY = /* GraphQL */ `
  query AnalyticsPoolDetail($id: String!, $chain: GqlChain!) {
    poolGetPool(id: $id, chain: $chain) {
      id
      address
      name
      symbol
      type
      protocolVersion
      chain
      createTime
      poolTokens {
        address
        symbol
        weight
      }
    }
  }
`

// Fallback for V2 pools when the URL contains just the 42-char address.
// `poolGetPools` accepts an address filter, returns the canonical 66-char
// `id` we can then use for downstream `poolGetSnapshots` etc.
const POOL_BY_ADDRESS_QUERY = /* GraphQL */ `
  query AnalyticsPoolByAddress($address: String!, $chain: GqlChain!) {
    pools: poolGetPools(where: { addressIn: [$address], chainIn: [$chain] }, first: 1) {
      id
      address
      name
      symbol
      type
      protocolVersion
      chain
      createTime
      poolTokens {
        address
        symbol
        weight
      }
    }
  }
`

const SNAPSHOTS_QUERY = /* GraphQL */ `
  query AnalyticsPoolSnapshots($id: String!, $chain: GqlChain!) {
    snapshots: poolGetSnapshots(id: $id, chain: $chain, range: NINETY_DAYS) {
      timestamp
      totalLiquidity
      volume24h
      fees24h
      surplus24h
      sharePrice
    }
  }
`

/**
 * Surface viem `HttpRequestError` fields that JSON stringification drops,
 * with the drpc API key scrubbed from URLs and messages before logging.
 */
function logRpcError(label: string, chain: GqlChain, pool: string, err: unknown): void {
  console.error(label, { chain, pool, ...scrubError(err) })
}

async function gqlFetch<T>(query: string, variables: Record<string, unknown>): Promise<T | null> {
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
    cache: 'no-store',
  })
  if (!res.ok) return null
  const json = (await res.json()) as { data?: T; errors?: unknown }
  if (json.errors) return null
  return json.data ?? null
}

export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<RouteParams>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}): Promise<React.JSX.Element> {
  const { chain: chainSlug, id } = await params
  const search = await searchParams
  // `?refresh` (or `?refresh=1`) on the URL forces the sync to ignore the
  // 30s TTL and re-scan from the watermark. Useful for inspecting a pool
  // whose first sync hit a transient drpc error and left the table empty.
  const forceRefresh = search.refresh !== undefined

  let chain: GqlChain
  try {
    chain = getChainSlug(chainSlug.toLowerCase() as ChainSlug)
  } catch {
    console.warn('[pool/page] 404: invalid chain slug', { chainSlug, id })
    notFound()
  }
  if (!(PROJECT_CONFIG.supportedNetworks as readonly GqlChain[]).includes(chain)) {
    console.warn('[pool/page] 404: chain not in PROJECT_CONFIG.supportedNetworks', {
      chain,
      supported: PROJECT_CONFIG.supportedNetworks,
    })
    notFound()
  }
  if (!isDrpcSupportedChain(chain)) {
    console.warn('[pool/page] 404: chain not drpc-supported', { chain })
    notFound()
  }
  // Accept either form:
  //  - 42-char address (0x + 40 hex) — canonical for V3 pools (where
  //    `pool.id === pool.address`) and also a usable shorthand for V2.
  //  - 66-char poolId (0x + 64 hex) — required for V2 / CowAmm pools, whose
  //    `id` is `address` + 2-byte type + 2-byte nonce.
  if (!/^0x[a-fA-F0-9]{40}([a-fA-F0-9]{24})?$/.test(id)) {
    console.warn('[pool/page] 404: invalid pool address or poolId', { id })
    notFound()
  }

  const rawId = id.toLowerCase()
  // Contract address used for on-chain calls (drpc) is always the first 20
  // bytes. For 42-char input that's the whole string; for 66-char input we
  // slice off the trailing type+nonce bytes.
  const contractAddress = rawId.length === 66 ? rawId.slice(0, 42) : rawId
  // api-v3 expects the canonical pool id — for V2 that's the 66-char form.
  // We resolve `apiV3Id` below: try `rawId` first, fall back to an
  // address-keyed lookup if that returns null (i.e. user passed the 42-char
  // address of a V2 pool).
  let apiV3Id = rawId

  // First pass: query by the URL-supplied id. Falls through with null for
  // V2 pools when only the 42-char address was passed; the lookup-by-address
  // recovery runs sequentially after.
  let detailRes = await gqlFetch<{
    poolGetPool: {
      id: string
      address: string
      name: string
      symbol: string
      type: string
      protocolVersion: number
      chain: GqlChain
      createTime: number
      poolTokens: { address: string; symbol: string; weight: string | null }[]
    }
  }>(POOL_DETAIL_QUERY, { id: apiV3Id, chain })

  if (!detailRes?.poolGetPool && rawId.length === 42) {
    // Likely a V2 pool referenced by its 42-char address. api-v3 needs the
    // 66-char poolId — look it up by address filter and re-fetch.
    const list = await gqlFetch<{
      pools: {
        id: string
        address: string
        name: string
        symbol: string
        type: string
        protocolVersion: number
        chain: GqlChain
        createTime: number
        poolTokens: { address: string; symbol: string; weight: string | null }[]
      }[]
    }>(POOL_BY_ADDRESS_QUERY, { address: contractAddress, chain })
    const first = list?.pools?.[0]
    if (first) {
      apiV3Id = first.id
      detailRes = { poolGetPool: first }
    }
  }

  // Snapshots and sync can run concurrently now that we know the canonical
  // identifiers — separate Promise.all once `apiV3Id` is resolved.
  const [snapshotsRes, syncRes] = await Promise.all([
    gqlFetch<{ snapshots: PoolSnapshot[] }>(SNAPSHOTS_QUERY, { id: apiV3Id, chain }),
    syncPoolEvents(chain, contractAddress, { force: forceRefresh }).catch((err: unknown) => {
      logRpcError('[pool/page] syncPoolEvents failed', chain, contractAddress, err)
      return { events: [], lastBlock: 0, cached: false, poolType: null, protocolVersion: null }
    }),
  ])

  if (!detailRes?.poolGetPool) {
    console.warn('[pool/page] 404: api-v3 has no pool for input id', {
      chain,
      rawId,
      contractAddress,
    })
    notFound()
  }

  const poolDetail: PoolDetail = {
    ...detailRes.poolGetPool,
    protocolVersion: detailRes.poolGetPool.protocolVersion as 1 | 2 | 3,
    tokens: detailRes.poolGetPool.poolTokens.map(t => ({
      address: t.address,
      symbol: t.symbol,
      weight: t.weight,
    })),
  }

  // State reads dispatch on the resolved pool protocol version. V3 uses
  // VaultExplorer + FeeController for universal state, V2 reads directly
  // off the pool contract.
  let universal: UniversalV3State | null = null
  let stable: StableTypeState | null = null
  let v2Base: V2BasePoolState | null = null
  const isStable = poolDetail.type === 'STABLE' || poolDetail.type === 'COMPOSABLE_STABLE'

  if (poolDetail.protocolVersion === 3) {
    const [u, s] = await Promise.all([
      readUniversalV3State(chain, contractAddress as Address).catch((err: unknown) => {
        logRpcError('[pool/page] readUniversalV3State failed', chain, contractAddress, err)
        return null
      }),
      isStable
        ? readStableTypeState(chain, contractAddress as Address).catch((err: unknown) => {
            logRpcError(
              '[pool/page] readStableTypeState failed',
              chain,
              contractAddress,
              err
            )
            return null
          })
        : Promise.resolve(null),
    ])
    universal = u
    stable = s
  } else if (poolDetail.protocolVersion === 2) {
    const [b, s] = await Promise.all([
      readV2BasePoolState(chain, contractAddress as Address).catch((err: unknown) => {
        logRpcError('[pool/page] readV2BasePoolState failed', chain, contractAddress, err)
        return null
      }),
      isStable
        ? readV2StableTypeState(chain, contractAddress as Address).catch((err: unknown) => {
            logRpcError(
              '[pool/page] readV2StableTypeState failed',
              chain,
              contractAddress,
              err
            )
            return null
          })
        : Promise.resolve(null),
    ])
    v2Base = b
    stable = s
  }

  const data: PoolPageData = {
    poolDetail,
    snapshots: snapshotsRes?.snapshots ?? [],
    events: syncRes.events,
    lastBlock: syncRes.lastBlock,
    state: { universal, stable, v2Base },
  }

  return <PoolPageView data={data} />
}
