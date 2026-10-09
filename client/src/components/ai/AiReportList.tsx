// ============================================================================
// §20 — My reports: the answers this administrator saved to run again, the
// latest changed first. Search their titles and questions, open one, rename
// one in place, remove one, page back through older ones. Nobody else sees
// them.
// ============================================================================

import { useEffect, useMemo, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Check, FileChartColumn, Loader2, Pencil, Search, Trash2, X } from 'lucide-react'
import type { AiReportSummary } from '@qc/shared/ai'
import { Button, Input, Modal } from '@/components/ui'
import { cn, formatDate, formatFullTimestamp, formatTime } from '@/lib/utils'
import { deleteAiReport, renameAiReport } from '@/services/mutations'
import { AI_REPORT_SEARCH_MAX, useAiReports, useDebounced } from '@/services/queries'
import { useApp } from '@/store/AppContext'
import { useAi } from './AiAssistantProvider'
import { AI_REPORT_TITLE_MAX, cleanReportTitle, filterAiReports, mergeAiReportPages, reportPeriodLabel } from './reports'

/** Today's time, or the day. */
const when = (iso: string) => (new Date(iso).toDateString() === new Date().toDateString() ? formatTime(iso) : formatDate(iso))

const ROW_BTN = 'icon-btn h-9 w-9 shrink-0 opacity-0 focus:opacity-100 group-hover:opacity-100 disabled:opacity-30 [@media(hover:none)]:opacity-100 touch:h-11 touch:w-11'

/**
 * A title edited in place: Enter or the tick keeps it, Escape or the cross
 * leaves it as it was. `onSave` resolves once it is kept (and the editor
 * closes); a refusal leaves the editor open with what was typed.
 */
export function ReportTitleEditor({ initial, onSave, onCancel, className }: { initial: string; onSave: (title: string) => Promise<boolean>; onCancel: () => void; className?: string }) {
  const [value, setValue] = useState(initial)
  const [busy, setBusy] = useState(false)
  const input = useRef<HTMLInputElement>(null)

  useEffect(() => {
    input.current?.focus()
    input.current?.select()
  }, [])

  const title = cleanReportTitle(value)
  const submit = async () => {
    if (!title || busy) return
    if (title === initial) return onCancel()
    setBusy(true)
    const kept = await onSave(title)
    if (!kept) setBusy(false)
  }

  return (
    <form
      className={cn('flex min-w-0 flex-1 items-center gap-1', className)}
      onSubmit={(e) => {
        e.preventDefault()
        void submit()
      }}
    >
      <input
        ref={input}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          // Escape leaves the title as it was — and only that: the panel around it stays open.
          if (e.key !== 'Escape') return
          e.preventDefault()
          onCancel()
        }}
        maxLength={AI_REPORT_TITLE_MAX}
        disabled={busy}
        dir="auto"
        aria-label="The report's title"
        className="input h-9 min-w-0 flex-1 px-2.5 py-0 text-sm font-semibold touch:h-11"
      />
      <button type="submit" disabled={!title || busy} className="icon-btn h-9 w-9 shrink-0 text-emerald-700 disabled:opacity-40 dark:text-emerald-300 touch:h-11 touch:w-11" aria-label="Keep the title" data-tip="Keep (Enter)">
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
      </button>
      <button type="button" onClick={onCancel} disabled={busy} className="icon-btn h-9 w-9 shrink-0 touch:h-11 touch:w-11" aria-label="Leave the title as it was" data-tip="Cancel (Esc)">
        <X className="h-4 w-4" />
      </button>
    </form>
  )
}

/** The period, the sections and the last run of a report, on one line. */
function reportMeta(r: AiReportSummary): string {
  const bits = [reportPeriodLabel(r) ?? 'Period as asked', `${r.sectionCount} ${r.sectionCount === 1 ? 'section' : 'sections'}`]
  bits.push(r.lastRunAt ? `ran ${when(r.lastRunAt)}` : `saved ${when(r.createdAt)}`)
  return bits.join(' · ')
}

export function AiReportList({ onOpen }: { onOpen: (report: AiReportSummary) => void }) {
  const qc = useQueryClient()
  const { toast } = useApp()
  const { enabled } = useAi()
  const [term, setTerm] = useState('')
  // The server searches every report, not only the pages loaded; asked once typing pauses.
  const search = useDebounced(term.trim(), 300)
  const { data, isLoading, isError, isFetching, isPlaceholderData, refetch, hasNextPage, fetchNextPage, isFetchingNextPage } = useAiReports(search, enabled)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [removing, setRemoving] = useState<AiReportSummary | null>(null)
  const [busy, setBusy] = useState(false)

  const all = useMemo(() => mergeAiReportPages(data?.pages), [data])
  // While the last search's reports stand in for this one's, they are narrowed to what is typed at once.
  const searching = isPlaceholderData || term.trim() !== search
  const list = useMemo(() => (searching ? filterAiReports(all, term) : all), [all, searching, term])

  const loadMore = async () => {
    if (isFetchingNextPage) return
    const res = await fetchNextPage()
    if (res.isFetchNextPageError) toast(res.error instanceof Error ? res.error.message : 'Older reports could not be loaded.', 'error')
  }

  // Each change fetches the pages on screen again (see aiReportListOptions): the list follows it in place.
  const rename = async (id: string, title: string): Promise<boolean> => {
    try {
      await renameAiReport(qc, id, title)
      setRenaming(null)
      toast('Report renamed.', 'success')
      return true
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not rename the report.', 'error')
      return false
    }
  }

  const remove = async () => {
    if (!removing) return
    setBusy(true)
    try {
      await deleteAiReport(qc, removing.id)
      toast('Report deleted.', 'success')
      setRemoving(null)
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not delete the report.', 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="px-3 pb-2 pt-3">
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
          <Input
            value={term}
            onChange={(e) => setTerm(e.target.value)}
            maxLength={AI_REPORT_SEARCH_MAX}
            placeholder="Search your reports"
            className="rounded-full pl-9 pr-9"
            aria-label="Search your reports"
            dir="auto"
          />
          {searching && isFetching && <Loader2 aria-hidden className="absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-muted" />}
        </div>
      </div>

      <ul className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 pb-3">
        {isLoading && (
          <li className="flex items-center justify-center gap-2 py-10 text-sm text-muted">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading…
          </li>
        )}
        {isError && !data && (
          <li className="px-3 py-8 text-center text-sm text-muted">
            Your reports could not be loaded.{' '}
            <button type="button" onClick={() => void refetch()} className="font-semibold text-brand-700 hover:underline dark:text-brand-300">
              Try again
            </button>
          </li>
        )}
        {list.map((r) => (
          <li key={r.id} className="group flex items-center gap-1 rounded-2xl pe-1 transition-colors hover:bg-slate-100 dark:hover:bg-slate-800">
            {renaming === r.id ? (
              <div className="flex min-w-0 flex-1 items-center gap-2 px-2.5 py-2">
                <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-brand-100 text-brand-700 dark:bg-brand-500/20 dark:text-brand-200">
                  <FileChartColumn className="h-4 w-4" />
                </span>
                <ReportTitleEditor initial={r.title} onSave={(title) => rename(r.id, title)} onCancel={() => setRenaming(null)} />
              </div>
            ) : (
              <>
                <button type="button" onClick={() => onOpen(r)} className="flex min-w-0 flex-1 items-center gap-3 rounded-2xl px-2.5 py-2.5 text-left">
                  <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-brand-100 text-brand-700 dark:bg-brand-500/20 dark:text-brand-200">
                    <FileChartColumn className="h-4 w-4" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span dir="auto" className="block truncate text-sm font-semibold">
                      {r.title}
                    </span>
                    <span className="block truncate text-[11px] tabular-nums text-muted" data-tip={r.lastRunAt ? `Last run ${formatFullTimestamp(r.lastRunAt)}` : undefined}>
                      {reportMeta(r)}
                    </span>
                  </span>
                </button>
                <button type="button" onClick={() => setRenaming(r.id)} aria-label={`Rename the report "${r.title}"`} data-tip="Rename" className={ROW_BTN}>
                  <Pencil className="h-4 w-4" />
                </button>
                <button type="button" onClick={() => setRemoving(r)} aria-label={`Delete the report "${r.title}"`} data-tip="Delete" className={cn(ROW_BTN, 'hover:text-rose-600')}>
                  <Trash2 className="h-4 w-4" />
                </button>
              </>
            )}
          </li>
        ))}
        {!isLoading && !isError && list.length === 0 && (
          <li className="px-4 py-10 text-center text-sm text-muted">
            {searching ? (
              'Searching…'
            ) : search ? (
              'No report matches.'
            ) : (
              <>
                <FileChartColumn aria-hidden className="mx-auto mb-2 h-8 w-8 text-slate-300 dark:text-slate-600" />
                No reports yet. Under an answer that ran a query, <b className="font-semibold text-slate-700 dark:text-slate-200">Save as report</b> keeps it here, to run again any day.
              </>
            )}
          </li>
        )}
        {hasNextPage && !searching && (
          <li className="flex justify-center pt-2">
            <button type="button" onClick={() => void loadMore()} disabled={isFetchingNextPage} className="rounded-full bg-white px-3 py-1.5 text-xs font-semibold text-muted shadow ring-1 ring-slate-200 hover:text-slate-700 dark:bg-slate-800 dark:ring-slate-700 dark:hover:text-slate-200 touch:min-h-[44px]">
              {isFetchingNextPage ? 'Loading…' : search ? 'Older matches' : 'Older reports'}
            </button>
          </li>
        )}
      </ul>

      {removing && <DeleteReportModal report={removing} busy={busy} onCancel={() => setRemoving(null)} onConfirm={() => void remove()} />}
    </div>
  )
}

export function DeleteReportModal({ report, busy, onCancel, onConfirm }: { report: Pick<AiReportSummary, 'title'>; busy: boolean; onCancel: () => void; onConfirm: () => void }) {
  return (
    <Modal
      open
      onClose={() => !busy && onCancel()}
      size="sm"
      title="Delete this report?"
      footer={
        <>
          <Button onClick={onCancel} disabled={busy}>
            Keep it
          </Button>
          <Button variant="danger" onClick={onConfirm} disabled={busy}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />} Delete
          </Button>
        </>
      }
    >
      <p className="text-sm text-slate-600 dark:text-slate-300">
        <b dir="auto">{report.title}</b>
        <br />
        It leaves My reports. The conversation it was saved from stays, and its answer can be saved again.
      </p>
    </Modal>
  )
}
