'use client'

import { useEffect, useState } from 'react'
import { GqlChain } from '@repo/lib/shared/services/api/generated/graphql'
import type { GqlChainValues } from '@repo/lib/config/networks'
import { chainToSlugMap } from '@repo/lib/modules/pool/pool.utils'
import type { OrderFlowResponse } from './api-types'

type State = {
  data: OrderFlowResponse | null
  error: Error | null
}

type Result = State & { loading: boolean }

const INITIAL: State = { data: null, error: null }

/**
 * Fetches the 30d labeled-swap feed from `/api/pool/[chain]/[id]/order-flow`.
 *
 * Crucially, this hook does **not** take a range parameter — the server
 * always returns 30d and the component filters in-memory. That's the
 * single biggest piece of rate-limit insurance: switching ranges in the
 * UI never re-hits api-v3.
 *
 * Mirrors the plain fetch + useState + useEffect pattern used elsewhere
 * in this app (see `useBiggestSwaps`). The route's `Cache-Control:
 * s-maxage=600` covers cross-tab revisits within 10 minutes.
 */
export function usePoolOrderFlowData(
  chain: GqlChainValues,
  poolId: string
): Result {
  const slug = chainToSlugMap[chain as GqlChain]
  const [state, setState] = useState<State>(INITIAL)

  useEffect(() => {
    if (!slug) return
    const url = `/api/pool/${slug}/${poolId.toLowerCase()}/order-flow`
    // Abort if the component unmounts or pool changes before the response
    // arrives. The previous range-keyed effect could pile up parallel api-v3
    // calls; this version only re-fires when chain/pool change so the
    // abort is mostly for unmount cleanup.
    const controller = new AbortController()
    fetch(url, { signal: controller.signal })
      .then(r => {
        if (!r.ok) throw new Error(`order-flow HTTP ${r.status}`)
        return r.json() as Promise<OrderFlowResponse>
      })
      .then(data => {
        if (controller.signal.aborted) return
        setState({ data, error: null })
      })
      .catch(error => {
        if (controller.signal.aborted) return
        if (error instanceof Error && error.name === 'AbortError') return
        setState(prev => ({ data: prev.data, error: error as Error }))
      })
    return () => {
      controller.abort()
    }
  }, [slug, poolId])

  if (!slug) {
    return { data: null, loading: false, error: new Error(`no URL slug for ${chain}`) }
  }
  // Loading is derived: we're "loading" until there's data or an error.
  const loading = state.data == null && state.error == null
  return { data: state.data, error: state.error, loading }
}
