import { AlertOctagon, History, PauseCircle } from 'lucide-react'
import { Badge } from '@/components/ui'
import { sessionTone, type SessionTone } from '@/domain'
import { cn } from '@/lib/utils'
import type { InspectionSession } from '@qc/shared/types'

/**
 * The colour a session carries in every list:
 *   amber — a defect is on Hold, waiting for a decision
 *   red   — the session recorded defects
 *   grey  — clean here, but the same item of the same order showed defects
 *           on another machine or in an earlier session
 * The rule itself lives in the shared domain (sessionTone); this is its paint.
 */
const STYLE: Record<NonNullable<SessionTone>, { block: string; row: string; badge: 'amber' | 'red' | 'neutral' }> = {
  hold: {
    block: 'border-l-4 border-l-amber-400 bg-amber-50/70 dark:border-l-amber-500 dark:bg-amber-500/10',
    row: 'bg-amber-50/70 hover:bg-amber-100/70 dark:bg-amber-500/10 dark:hover:bg-amber-500/15',
    badge: 'amber',
  },
  defect: {
    block: 'border-l-4 border-l-rose-500 bg-rose-50/70 dark:border-l-rose-500 dark:bg-rose-500/10',
    row: 'bg-rose-50/70 hover:bg-rose-100/70 dark:bg-rose-500/10 dark:hover:bg-rose-500/15',
    badge: 'red',
  },
  prior: {
    block: 'border-l-4 border-l-slate-400 bg-slate-100/80 dark:border-l-slate-500 dark:bg-slate-800/60',
    row: 'bg-slate-100/80 hover:bg-slate-200/70 dark:bg-slate-800/60 dark:hover:bg-slate-800',
    badge: 'neutral',
  },
}

type Signals = Pick<InspectionSession, 'defectCount' | 'holdCount' | 'priorDefectsElsewhere'>

/** Classes for a card, list block or table row, on top of its own. */
export function sessionToneClass(session: Signals, kind: 'block' | 'row', fallback = ''): string {
  const tone = sessionTone(session)
  return tone ? STYLE[tone][kind] : fallback
}

/** The badge that says why a session is coloured; nothing when it is not. */
export function SessionToneBadge({ session, className, onHold }: { session: Signals; className?: string; onHold?: () => void }) {
  const tone = sessionTone(session)
  if (!tone) return null
  const defects = session.defectCount ?? 0
  const holds = session.holdCount ?? 0
  if (tone === 'hold') {
    const badge = (
      <Badge tone="amber" className={cn(className, onHold && 'ring-1 ring-amber-400/60')} icon={<PauseCircle className="h-3 w-3" />}>
        Hold {holds > 1 ? `×${holds}` : ''}
        {defects > holds ? ` · ${defects} defect${defects === 1 ? '' : 's'}` : ''}
      </Badge>
    )
    // Where a decision may be made from here, the badge is the way in.
    return onHold ? (
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation()
          onHold()
        }}
        title="Decide the Hold"
        aria-label="Decide the Hold"
        className="inline-flex min-h-[32px] items-center rounded-full transition-transform hover:scale-105 focus:outline-none focus:ring-2 focus:ring-amber-400"
      >
        {badge}
      </button>
    ) : (
      badge
    )
  }
  if (tone === 'defect') {
    return (
      <Badge tone="red" className={className} icon={<AlertOctagon className="h-3 w-3" />}>
        {defects} defect{defects === 1 ? '' : 's'}
      </Badge>
    )
  }
  return (
    <span title="This item of this order showed defects on another machine or in an earlier session." className={cn('inline-flex', className)}>
      <Badge tone="neutral" icon={<History className="h-3 w-3" />}>
        Defects before
      </Badge>
    </span>
  )
}
