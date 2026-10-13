// ============================================================================
// A saved table the assistant made, changed, computed again or removed, as a
// small card in its answer: its title and name (what questions and
// automations read it as), its rows and columns, and how often it is
// computed again. The change is made already, so the card offers the Saved
// tables page; its rows changed or the table removed since, it says so.
// ============================================================================

import { memo } from 'react'
import { Link } from 'react-router-dom'
import { ArrowRight, Table2 } from 'lucide-react'
import { SAVED_TABLE_REFRESH_LABEL, type AiSavedTablePart } from '@qc/shared/savedTables'
import { Badge } from '@/components/ui'
import { cn } from '@/lib/utils'

/** Columns the card names before "+N more". */
const SHOWN_COLUMNS = 8

const ACTION_TITLE: Record<AiSavedTablePart['action'], string> = {
  create: 'Saved table',
  replace: 'Saved table changed',
  update: 'Saved table updated',
  refresh: 'Saved table computed again',
  remove: 'Saved table removed',
}

/** What the card says of the table since: nothing while it stands as the card left it. */
export function savedTableCardSince(part: Pick<AiSavedTablePart, 'action' | 'state'>): string | null {
  if (part.action === 'remove') return null
  if (part.state === 'removed') return 'Removed since'
  if (part.state === 'changed') return 'Changed since'
  return null
}

/** The rows and how the table is kept, in one line. */
export function savedTableCardLine(part: Pick<AiSavedTablePart, 'rowCount' | 'source' | 'refresh'>): string {
  const rows = part.rowCount === null ? null : `${part.rowCount.toLocaleString('en-US')} ${part.rowCount === 1 ? 'row' : 'rows'}`
  const kept = part.source === 'rows' ? 'Written out' : SAVED_TABLE_REFRESH_LABEL[part.refresh]
  return [rows, kept].filter(Boolean).join(' · ')
}

export const AiSavedTableCard = memo(function AiSavedTableCard({ part }: { part: AiSavedTablePart }) {
  const since = savedTableCardSince(part)
  const removal = part.action === 'remove'
  const live = part.state === 'current' && !removal
  const shown = part.columns.slice(0, SHOWN_COLUMNS)
  const more = part.columns.length - shown.length
  return (
    <aside
      aria-label={`${ACTION_TITLE[part.action]}: ${part.title}`}
      className={cn(
        'my-2 flex items-start gap-3 rounded-xl px-3 py-2.5 ring-1',
        live ? 'bg-sky-50/70 ring-sky-200 dark:bg-sky-500/10 dark:ring-sky-500/30' : 'bg-slate-50 ring-slate-200 dark:bg-slate-800/40 dark:ring-slate-700',
      )}
    >
      <span aria-hidden className={cn('mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-lg', live ? 'bg-sky-600 text-white' : 'bg-slate-300 text-slate-700 dark:bg-slate-700 dark:text-slate-200')}>
        <Table2 className="h-4 w-4" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-center gap-1.5 text-[11px] font-bold uppercase tracking-wide text-muted">
          {ACTION_TITLE[part.action]}
          {since && <Badge tone="neutral">{since}</Badge>}
        </p>
        <p dir="auto" className={cn('mt-0.5 break-words text-13 font-semibold text-slate-800 dark:text-slate-100', (removal || part.state === 'removed') && 'line-through decoration-slate-400')}>
          {part.title}
        </p>
        <p className="mt-0.5 break-all font-mono text-[11px] text-muted">ai_saved.{part.name}</p>
        {!removal && (
          <>
            <p className="mt-1 text-xs text-muted">{savedTableCardLine(part)}</p>
            {shown.length > 0 && (
              <p className="mt-1 flex flex-wrap gap-1">
                {shown.map((c) => (
                  <span key={c} className="rounded bg-white/80 px-1.5 py-0.5 font-mono text-[11px] text-slate-700 ring-1 ring-slate-200 dark:bg-slate-900/60 dark:text-slate-200 dark:ring-slate-700">
                    {c}
                  </span>
                ))}
                {more > 0 && <span className="px-1 py-0.5 text-[11px] text-muted">+{more} more</span>}
              </p>
            )}
          </>
        )}
        <p className="mt-1 text-xs">
          <Link to="/saved-tables" className="inline-flex items-center gap-1 font-semibold text-brand-700 hover:underline dark:text-brand-300 touch:min-h-[44px]">
            Open saved tables <ArrowRight className="h-3.5 w-3.5 rtl:rotate-180" />
          </Link>
        </p>
      </div>
    </aside>
  )
})
