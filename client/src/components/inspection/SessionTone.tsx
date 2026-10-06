import { AlertOctagon, History, PauseCircle } from 'lucide-react'
import { Badge } from '@/components/ui'
import { sessionTone, type SessionTone } from '@/domain'
import { PT_MIN_TEST_FREQUENCY_PCT, ptRequiredFor } from '@qc/shared/rules'
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
// Rows are opaque (the tint laid over the card's white or slate-900) so a sticky first cell can take the row's colour.
const STYLE: Record<NonNullable<SessionTone>, { block: string; row: string; badge: 'amber' | 'red' | 'neutral' }> = {
  hold: {
    block: 'border-l-4 border-l-amber-400 bg-amber-50/70 dark:border-l-amber-500 dark:bg-amber-500/10',
    row: 'bg-[#fffcf6] hover:bg-[#fef7d8] dark:bg-[#262527] dark:hover:bg-[#312b25]',
    badge: 'amber',
  },
  defect: {
    block: 'border-l-4 border-l-rose-500 bg-rose-50/70 dark:border-l-rose-500 dark:bg-rose-500/10',
    row: 'bg-[#fff5f6] hover:bg-[#ffecee] dark:bg-[#261b2f] dark:hover:bg-[#311d32]',
    badge: 'red',
  },
  prior: {
    block: 'border-l-4 border-l-slate-400 bg-slate-100/80 dark:border-l-slate-500 dark:bg-slate-800/60',
    row: 'bg-[#f4f7fa] hover:bg-[#ebeff5] dark:bg-[#18222f] dark:hover:bg-[#1e293b]',
    badge: 'neutral',
  },
}

type Signals = Pick<InspectionSession, 'defectCount' | 'defectPieces' | 'holdCount' | 'priorDefectsElsewhere'>

const formatQty = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(3).replace(/\.?0+$/, ''))

type SampleSignals = { defectCount?: number; holdCount?: number }

/**
 * §5.6 — PT coverage of a welding session against 5% of its production.
 * `finalQty` is the quantity typed (or recorded); before it is known the
 * requirement is not, and the line says so.
 */
export function ptCoverage(session: { ptTestedCount?: number }, finalQty: number | null | undefined): { tested: number; required: number | null; short: number; met: boolean } {
  const tested = session.ptTestedCount ?? 0
  const required = finalQty !== null && finalQty !== undefined && Number.isFinite(finalQty) && finalQty >= 0 ? ptRequiredFor(finalQty) : null
  const short = required === null ? 0 : Math.max(0, required - tested)
  return { tested, required, short, met: required !== null && short === 0 }
}

/** The PT line in words: "12 tested · 15 required (5% of 300) · short by 3". */
export function ptCoverageText(session: { ptTestedCount?: number }, finalQty: number | null | undefined): string {
  const c = ptCoverage(session, finalQty)
  if (c.required === null) return `${c.tested} tested · required is ${PT_MIN_TEST_FREQUENCY_PCT}% of the final quantity, known at close`
  return `${c.tested} tested · ${c.required} required (${PT_MIN_TEST_FREQUENCY_PCT}% of ${finalQty}, rounded up)${c.short > 0 ? ` · short by ${c.short}` : ' · met'}`
}

/** The PT coverage as a badge: green when met, amber when short, quiet until the final quantity is known. */
export function PtCoverageBadge({ session, finalQty, className }: { session: { ptTestedCount?: number }; finalQty: number | null | undefined; className?: string }) {
  const c = ptCoverage(session, finalQty)
  if (c.required === null) return <Badge tone="neutral" className={className}>PT {c.tested} tested</Badge>
  return (
    <Badge tone={c.met ? 'green' : 'amber'} className={className} icon={c.met ? undefined : <AlertOctagon className="h-3 w-3" />}>
      PT {c.tested} / {c.required}{c.short > 0 ? ` · short by ${c.short}` : ''}
    </Badge>
  )
}

/**
 * A sample chip wears the sample's worst signal, the same colours as a
 * session: amber with a defect on Hold, red with defects, otherwise the
 * quiet brand blue it had. `onWhite` is the variant for a chip sitting on a
 * white card rather than the page.
 */
export function sampleChipClass(sample: SampleSignals, onWhite = false): string {
  if ((sample.holdCount ?? 0) > 0) return 'bg-amber-100 text-amber-800 ring-1 ring-amber-300 hover:bg-amber-200/70 dark:bg-amber-500/15 dark:text-amber-300 dark:ring-amber-500/40 dark:hover:bg-amber-500/25'
  if ((sample.defectCount ?? 0) > 0) return 'bg-rose-100 text-rose-800 ring-1 ring-rose-300 hover:bg-rose-200/70 dark:bg-rose-500/15 dark:text-rose-300 dark:ring-rose-500/40 dark:hover:bg-rose-500/25'
  return onWhite
    ? 'bg-white text-brand-700 ring-1 ring-brand-200 hover:bg-brand-50 dark:bg-slate-900 dark:text-brand-300 dark:ring-brand-500/20 dark:hover:bg-brand-500/20'
    : 'bg-brand-50 text-brand-700 ring-1 ring-brand-200 hover:bg-brand-100 dark:bg-brand-500/10 dark:text-brand-300 dark:ring-brand-500/20 dark:hover:bg-brand-500/20'
}

/** Why a sample chip is coloured, for its tooltip and label; empty when it is clean. */
export function sampleChipTitle(sample: SampleSignals): string {
  if ((sample.holdCount ?? 0) > 0) return 'A defect in this sample is on Hold'
  if ((sample.defectCount ?? 0) > 0) return `This sample recorded ${sample.defectCount} defect${sample.defectCount === 1 ? '' : 's'}`
  return ''
}

/** Classes for a card, list block or table row, on top of its own. */
export function sessionToneClass(session: Signals, kind: 'block' | 'row', fallback = ''): string {
  const tone = sessionTone(session)
  return tone ? STYLE[tone][kind] : fallback
}

/** The badge that says why a session is coloured; nothing when it is not. */
/**
 * `compact` is the table's form: one short badge ("Hold ×2", "3"), the whole
 * sentence in its tooltip, so the status column stays on one line.
 */
export function SessionToneBadge({ session, className, onHold, compact = false }: { session: Signals; className?: string; onHold?: () => void; compact?: boolean }) {
  const tone = sessionTone(session)
  if (!tone) return null
  const defects = session.defectCount ?? 0
  const holds = session.holdCount ?? 0
  if (tone === 'hold') {
    const full = `Hold ${holds > 1 ? `×${holds}` : ''}${defects > holds ? ` · ${defects} defect${defects === 1 ? '' : 's'}` : ''}`
    const badge = (
      <Badge tone="amber" className={cn(className, onHold && 'ring-1 ring-amber-400/60')} icon={<PauseCircle className="h-3 w-3" />} tip={compact && !onHold ? `On ${full.trim()}` : undefined}>
        {compact ? `Hold${holds > 1 ? ` ×${holds}` : ''}` : full}
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
        data-tip="Decide the Hold"
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
    // "2 defects · 200 pcs": the records, and the pieces they cover — the
    // figure the dashboard adds up, so the two can be matched by eye.
    const pieces = session.defectPieces ?? 0
    const full = `${defects} defect${defects === 1 ? '' : 's'}${pieces > 0 && pieces !== defects ? ` · ${formatQty(pieces)} pcs` : ''}`
    return (
      <Badge tone="red" className={className} icon={<AlertOctagon className="h-3 w-3" />} tip={compact ? full : undefined}>
        {compact ? defects : full}
      </Badge>
    )
  }
  // A secondary signal: a small mark beside the status, explained in its tooltip — never a second badge.
  return (
    <span
      data-tip="Defects before: this item of this order showed defects on another machine or in an earlier session."
      aria-label="Defects before"
      role="img"
      className={cn('inline-grid h-[22px] w-[22px] shrink-0 place-items-center rounded-md text-muted ring-1 ring-inset ring-neutral-200 dark:ring-neutral-700', className)}
    >
      <History className="h-3.5 w-3.5" />
    </span>
  )
}
