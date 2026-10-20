// ============================================================================
// Whom one of the person's reports is shared with, as the assistant's
// share_report left it: a small card in its answer, with whom the call added
// and removed, whom it is shared with now, and Open sharing — the report's
// Share panel, to see who ran it or change it by hand. Deleted since, it says
// so.
// ============================================================================

import { memo } from 'react'
import { ArrowRight, Share2 } from 'lucide-react'
import type { AiReportSharePart } from '@qc/shared/ai'
import { Badge } from '@/components/ui'
import { cn } from '@/lib/utils'
import type { AiOpenReportOptions } from './workspace'

/** The card's lines: what the call changed, and whom the report is shared with now. */
export function shareCardLines(part: Pick<AiReportSharePart, 'added' | 'removed' | 'sharedWith'>): { label: string; text: string }[] {
  const lines: { label: string; text: string }[] = []
  if (part.added.length > 0) lines.push({ label: 'Added', text: part.added.join(', ') })
  if (part.removed.length > 0) lines.push({ label: 'Removed', text: part.removed.join(', ') })
  lines.push({ label: 'Shared with', text: part.sharedWith.length > 0 ? part.sharedWith.join(', ') : 'Nobody' })
  return lines
}

export const AiReportShareCard = memo(function AiReportShareCard({ part, onOpen }: { part: AiReportSharePart; onOpen?: (reportId: string, opts?: AiOpenReportOptions) => void }) {
  const live = part.state !== 'removed'
  return (
    <aside
      aria-label={`Sharing: ${part.title}`}
      className={cn(
        'my-2 flex items-start gap-3 rounded-xl px-3 py-2.5 ring-1',
        live ? 'bg-brand-50/70 ring-brand-200 dark:bg-brand-500/10 dark:ring-brand-500/30' : 'bg-slate-50 ring-slate-200 dark:bg-slate-800/40 dark:ring-slate-700',
      )}
    >
      <span aria-hidden className={cn('mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-lg', live ? 'bg-brand-600 text-white' : 'bg-slate-300 text-slate-700 dark:bg-slate-700 dark:text-slate-200')}>
        <Share2 className="h-4 w-4" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-center gap-1.5 text-[11px] font-bold uppercase tracking-wide text-muted">
          Report sharing
          {!live && <Badge tone="neutral">Deleted since</Badge>}
        </p>
        <p dir="auto" className={cn('mt-0.5 break-words text-13 font-semibold text-slate-800 dark:text-slate-100', !live && 'line-through decoration-slate-400')}>
          {part.title}
        </p>
        <dl className="mt-1 space-y-0.5 text-xs">
          {shareCardLines(part).map((l) => (
            <div key={l.label} className="flex flex-wrap gap-x-1">
              <dt className="font-semibold text-slate-600 dark:text-slate-300">{l.label}:</dt>
              <dd dir="auto" className="min-w-0 break-words text-muted">
                {l.text}
              </dd>
            </div>
          ))}
        </dl>
        {live && onOpen && (
          <p className="mt-1 text-xs">
            <button type="button" onClick={() => onOpen(part.reportId, { share: true })} className="inline-flex items-center gap-1 font-semibold text-brand-700 hover:underline dark:text-brand-300 touch:min-h-[44px]">
              Open sharing <ArrowRight className="h-3.5 w-3.5 rtl:rotate-180" />
            </button>
          </p>
        )}
      </div>
    </aside>
  )
})
