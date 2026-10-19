// ============================================================================
// The red count on a button at the top (chat, notices, the bell): how many
// wait there, "99+" past ninety-nine. One look for all three, so they never
// drift apart.
// ============================================================================

import { cn } from '@/lib/utils'

/** A count as a badge holds it. */
export const badgeText = (n: number): string => (n > 99 ? '99+' : String(n))

/** The count in the button's top corner; nothing at 0. `tone` accent marks something for this person in particular (a mention). */
export function CountBadge({ count, tone = 'rose' }: { count: number; tone?: 'rose' | 'accent' }) {
  if (count <= 0) return null
  return (
    <span
      className={cn(
        'absolute -right-0.5 -top-0.5 grid min-w-[18px] place-items-center rounded-full px-1 text-[10px] font-bold leading-[18px] text-white ring-2 ring-white dark:ring-slate-900',
        tone === 'accent' ? 'bg-accent-500' : 'bg-rose-600',
      )}
    >
      {badgeText(count)}
    </span>
  )
}
