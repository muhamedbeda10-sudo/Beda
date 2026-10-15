// ============================================================================
// §20 — a report the assistant built or changed (save_report), as a small card
// in its answer: its title, what it shows, what its form asks for, its
// sections, whether it is shared. It is saved already, so the card opens it;
// changed or deleted since, it says so.
// ============================================================================

import { memo } from 'react'
import { ArrowRight, FileChartColumn, Users } from 'lucide-react'
import type { AiReportPart } from '@qc/shared/ai'
import { Badge } from '@/components/ui'
import { cn } from '@/lib/utils'

/** What the card says of the report since: nothing while it stands as the card left it. */
export function reportCardSince(part: Pick<AiReportPart, 'state'>): string | null {
  if (part.state === 'removed') return 'Deleted since'
  if (part.state === 'changed') return 'Changed since'
  return null
}

/** What its form asks for and its sections, in one line. */
export function reportCardLine(part: Pick<AiReportPart, 'inputs' | 'sectionCount'>): string {
  const sections = `${part.sectionCount} ${part.sectionCount === 1 ? 'section' : 'sections'}`
  return part.inputs.length > 0 ? `Asks for ${part.inputs.join(', ')} · ${sections}` : sections
}

export const AiReportCard = memo(function AiReportCard({ part, onOpen }: { part: AiReportPart; onOpen?: (reportId: string) => void }) {
  const since = reportCardSince(part)
  const live = part.state !== 'removed'
  return (
    <aside
      aria-label={`${part.action === 'create' ? 'Report built' : 'Report changed'}: ${part.title}`}
      className={cn(
        'my-2 flex items-start gap-3 rounded-xl px-3 py-2.5 ring-1',
        live ? 'bg-brand-50/70 ring-brand-200 dark:bg-brand-500/10 dark:ring-brand-500/30' : 'bg-slate-50 ring-slate-200 dark:bg-slate-800/40 dark:ring-slate-700',
      )}
    >
      <span aria-hidden className={cn('mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-lg', live ? 'bg-brand-600 text-white' : 'bg-slate-300 text-slate-700 dark:bg-slate-700 dark:text-slate-200')}>
        <FileChartColumn className="h-4 w-4" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-center gap-1.5 text-[11px] font-bold uppercase tracking-wide text-muted">
          {part.action === 'create' ? 'Report built' : 'Report changed'}
          {part.shared && (
            <Badge tone="blue" tip="Everyone given the assistant may open it; each sees the data they may read">
              <Users className="h-3 w-3" /> Shared
            </Badge>
          )}
          {since && <Badge tone="neutral">{since}</Badge>}
        </p>
        <p dir="auto" className={cn('mt-0.5 break-words text-13 font-semibold text-slate-800 dark:text-slate-100', !live && 'line-through decoration-slate-400')}>
          {part.title}
        </p>
        {part.description && (
          <p dir="auto" className="mt-0.5 line-clamp-3 text-xs text-muted">
            {part.description}
          </p>
        )}
        <p dir="auto" className="mt-1 text-xs text-muted">
          {reportCardLine(part)}
        </p>
        {live && onOpen && (
          <p className="mt-1 text-xs">
            <button type="button" onClick={() => onOpen(part.reportId)} className="inline-flex items-center gap-1 font-semibold text-brand-700 hover:underline dark:text-brand-300 touch:min-h-[44px]">
              Open report <ArrowRight className="h-3.5 w-3.5 rtl:rotate-180" />
            </button>
          </p>
        )}
      </div>
    </aside>
  )
})
