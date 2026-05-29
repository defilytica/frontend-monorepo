/**
 * Latest 5 Balancer governance proposals (BIPs) from the `balancer.eth`
 * Snapshot space, cached server-side. Single shared fetch via the route
 * cache (`revalidate = 600`) keeps Snapshot's public GraphQL endpoint out
 * of the per-visitor hot path.
 */

import 'server-only'
import { unstable_cache } from 'next/cache'
import {
  UpstreamError,
  gqlFetch,
  upstreamErrorToResponse,
} from '@analytics/lib/upstream/gql'
import type { GovernancePayload, ProposalState } from '@analytics/lib/governance/types'

export const runtime = 'nodejs'
export const revalidate = 600

const SNAPSHOT_URL = 'https://hub.snapshot.org/graphql'
const SPACE = 'balancer.eth'
const LIMIT = 5

const QUERY = /* GraphQL */ `
  query LatestProposals($space: String!, $first: Int!) {
    proposals(
      first: $first
      skip: 0
      where: { space: $space }
      orderBy: "created"
      orderDirection: desc
    ) {
      id
      title
      state
      author
      start
      end
      choices
      scores
      scores_total
      link
    }
  }
`

type RawProposal = {
  id: string
  title: string
  state: string
  author: string
  start: number
  end: number
  choices: string[]
  scores: number[] | null
  scores_total: number | null
  link: string | null
}

function normalizeState(state: string): ProposalState {
  if (state === 'active' || state === 'closed' || state === 'pending') return state
  return 'closed'
}

function snapshotLink(id: string, link: string | null): string {
  if (link && link.startsWith('http')) return link
  return `https://snapshot.box/#/s:${SPACE}/proposal/${id}`
}

async function buildPayload(): Promise<GovernancePayload> {
  const data = await gqlFetch<{ proposals: RawProposal[] }>(
    SNAPSHOT_URL,
    QUERY,
    { space: SPACE, first: LIMIT },
    { upstream: 'snapshot', label: 'latest-proposals', cache: 'no-store' }
  )
  const proposals = data?.proposals ?? []
  return {
    items: proposals.map(p => ({
      id: p.id,
      title: p.title,
      state: normalizeState(p.state),
      author: p.author,
      start: p.start,
      end: p.end,
      choices: p.choices ?? [],
      scores: p.scores ?? [],
      scoresTotal: p.scores_total ?? 0,
      link: snapshotLink(p.id, p.link),
    })),
    generatedAt: Math.floor(Date.now() / 1000),
    space: SPACE,
  }
}

// Fixed cache key — no params, so this is at most one Snapshot.org call per
// revalidate window across all visitors, regardless of what the URL string
// contains. Errors are caught outside the cached function so failure
// responses aren't cached (next call will retry the upstream).
const getGovernancePayload = unstable_cache(
  buildPayload,
  ['governance'],
  { revalidate: 600, tags: ['governance'] }
)

export async function GET() {
  try {
    // Browser/CDN cache aligned with the server-side `revalidate: 600` —
    // governance proposals tick slowly; 10-min freshness is generous.
    return Response.json(await getGovernancePayload(), {
      headers: {
        'Cache-Control': 'public, max-age=600, stale-while-revalidate=1800',
      },
    })
  } catch (err) {
    const now = Math.floor(Date.now() / 1000)
    const empty: GovernancePayload = { items: [], generatedAt: now, space: SPACE }
    // Same typed upstream-error mapping as /api/biggest-swaps and
    // /api/pool/[chain]/[id]/order-flow — a Snapshot.org rate limit now
    // surfaces as HTTP 429 with `error: 'rate_limited'` so the client UI
    // can render the same "wait and retry" message it does for api-v3.
    if (err instanceof UpstreamError) {
      const mapped = upstreamErrorToResponse(err, {
        includeDevDetail: process.env.NODE_ENV !== 'production',
      })
      return Response.json(
        { ...empty, ...mapped.body },
        { status: mapped.status, headers: mapped.headers }
      )
    }
    return Response.json(
      { ...empty, error: String(err) },
      { status: 502, headers: { 'Cache-Control': 'no-store' } }
    )
  }
}
