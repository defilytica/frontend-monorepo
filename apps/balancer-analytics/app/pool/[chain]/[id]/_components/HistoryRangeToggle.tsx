'use client'

/**
 * Range toggle for the pool detail page. The 90-day vs full-history window
 * is server state (a `?fullHistory` search param read by `page.tsx`), not
 * client state — the toggle just navigates to the same path with the param
 * added/removed and lets the server re-render with the wider range. This
 * keeps a single source of truth driving *both* the event scan and the
 * api-v3 snapshot series (POOL_EXPLORER_DESIGN.md §7).
 *
 * `useTransition` gives immediate inline feedback ("Loading full history…")
 * while the route transition is in flight; the route's `loading.tsx`
 * throbber covers the heavier cold scan that a full-history widen kicks off
 * (~150 RPC requests for a multi-year mainnet pool).
 */

import { Button, Spinner } from '@chakra-ui/react'
import { usePathname, useRouter } from 'next/navigation'
import { useTransition } from 'react'

export function HistoryRangeToggle({
  fullHistory,
}: {
  fullHistory: boolean
}): React.JSX.Element {
  const router = useRouter()
  const pathname = usePathname()
  const [isPending, startTransition] = useTransition()

  const toggle = () => {
    // Drop any other one-shot params (e.g. ?refresh) — the range is the
    // only state this control owns, and a clean URL keeps the toggle
    // idempotent on repeated clicks.
    const next = fullHistory ? pathname : `${pathname}?fullHistory`
    startTransition(() => router.push(next))
  }

  return (
    <Button
      isDisabled={isPending}
      leftIcon={isPending ? <Spinner size="xs" /> : undefined}
      onClick={toggle}
      size="sm"
      variant="tertiary"
    >
      {isPending
        ? fullHistory
          ? 'Loading 90 days…'
          : 'Loading full history…'
        : fullHistory
          ? 'Show 90 days'
          : 'Load full history'}
    </Button>
  )
}
