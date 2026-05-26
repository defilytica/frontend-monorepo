'use client'

import { useEffect, useState } from 'react'
import type { AnalyticsMerklPayload } from '@analytics/app/api/merkl/[address]/route'

export type UseMerklRewardsResult = {
  loading: boolean
  error: string | null
  payload: AnalyticsMerklPayload | null
}

const EMPTY: AnalyticsMerklPayload = { totalUnclaimedUsd: 0, rewards: [] }

/**
 * Fetch the aggregated Merkl rewards payload for an address. The heavy
 * lifting (chain fan-out, aggregation, USD conversion) lives in the route
 * handler; this hook just owns lifecycle + abort.
 */
export function useMerklRewards(address: string | null): UseMerklRewardsResult {
  const [state, setState] = useState<UseMerklRewardsResult>({
    loading: !!address,
    error: null,
    payload: address ? null : EMPTY,
  })

  useEffect(() => {
    if (!address) {
      setState({ loading: false, error: null, payload: EMPTY })
      return
    }
    setState({ loading: true, error: null, payload: null })
    const controller = new AbortController()
    fetch(`/api/merkl/${address}`, { signal: controller.signal })
      .then(async res => {
        if (!res.ok) throw new Error(`merkl ${res.status}`)
        return (await res.json()) as AnalyticsMerklPayload
      })
      .then(payload => {
        setState({ loading: false, error: null, payload })
      })
      .catch((err: Error) => {
        if (err.name === 'AbortError') return
        setState({ loading: false, error: err.message, payload: null })
      })
    return () => controller.abort()
  }, [address])

  return state
}
