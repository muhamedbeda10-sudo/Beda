// ============================================================================
// §20 — one saved report, run now. Opening it runs every section's SQL
// through the server's read-only runner (no model, no cost) and shows each
// as the answer showed it: what it looks for, its rows in a preview, a large
// table with Excel's filters, the SQL. A report that kept its question's
// period ("last 30 days") runs over that period as of today; other days can
// be chosen for a run (not saved), and reset. Export Excel takes every
// section in full, a sheet each, after a sheet on the report itself.
// ============================================================================

import { memo, useCallback, useMemo, useReducer, useState, type Dispatch } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import {
  ArrowLeft,
  CalendarRange,
  CheckCircle2,
  ChevronDown,
  FileSpreadsheet,
  Loader2,
  MessageSquareText,
  OctagonX,
  Pencil,
  RefreshCw,
  Table2,
  Trash2,
  Undo2,
} from 'lucide-react'
import {
  AI_EXPORT_MAX_ROWS,
  AI_PREVIEW_ROWS,
  describeAiPeriod,
  type AiQueryPart,
  type AiReport,
  type AiReportPeriod,
  type AiReportRunResponse,
  type AiReportSummary,
} from '@qc/shared/ai'
import { Badge, Button } from '@/components/ui'
import { ApiError } from '@/lib/api'
import { downloadWorkbook } from '@/lib/xlsxWrite'
import { cn, formatDate, formatFullTimestamp, formatTime } from '@/lib/utils'
import { deleteAiReport, renameAiReport } from '@/services/mutations'
import { keys, loadAiReportExport, newerAiReport, useAiReport, useAiReportRun } from '@/services/queries'
import { useApp } from '@/store/AppContext'
import { useAi } from './AiAssistantProvider'
import { AiCode } from './AiCode'
import { Notice } from './AiNotice'
import { DeleteReportModal, ReportTitleEditor } from './AiReportList'
import { AiChart } from './AiChart'
import { AiResultModal, PreviewTable } from './AiResultTable'
import { queryChart } from './chartData'
import { aiReportExportMessage, aiReportFilename, aiReportSheets } from './exportAiReport'
import {
  REPORT_PERIOD_SAVED,
  daysInRange,
  hasAdjustablePeriod,
  reportPeriodDraft,
  reportPeriodReducer,
  runFailures,
  runPeriodText,
  sectionAsQuery,
  type ReportPeriodAction,
  type ReportPeriodState,
} from './reports'

const SMALL_BTN = 'btn-secondary h-8 min-h-0 gap-1.5 px-2.5 py-0 text-xs touch:h-11 touch:px-3'
const EXPORT_LABEL = 'Export report'
const EXPORT_TIP = 'Runs every section again now, in full, and saves them as a workbook: a sheet each, after a sheet on the report'

/** Today's time, or the day and the time. */
const when = (iso: string) => (new Date(iso).toDateString() === new Date().toDateString() ? formatTime(iso) : `${formatDate(iso)}, ${formatTime(iso)}`)

export function AiReportView({
  id,
  known,
  onBack,
  onOpenConversation,
  wide = false,
}: {
  id: string
  /** What the list knew of it: drawn until the report itself arrives. */
  known?: AiReportSummary
  onBack: () => void
  onOpenConversation: (conversationId: string) => void
  /** The full page: the report is a centred column of at most 1100 px. */
  wide?: boolean
}) {
  const qc = useQueryClient()
  const { toast } = useApp()
  const { enabled } = useAi()
  // The period control and the days of the run (override: days chosen; null runs the saved period, as of today), one state.
  const [period, setPeriod] = useReducer(reportPeriodReducer, REPORT_PERIOD_SAVED)
  const override = period.override
  const detail = useAiReport(id, enabled)
  const run = useAiReportRun(id, override, enabled)
  const [renaming, setRenaming] = useState(false)
  const [removing, setRemoving] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [exporting, setExporting] = useState(false)

  const report: AiReport | AiReportSummary | undefined = detail.data ?? run.data?.report ?? known
  const full: AiReport | undefined = detail.data ?? run.data?.report
  const shown = run.data
  // The tables on screen belong to other days than those asked for: the next run is on its way.
  const stale = run.isPlaceholderData
  const gone = detail.error instanceof ApiError && detail.error.status === 404

  const rename = async (title: string): Promise<boolean> => {
    try {
      await renameAiReport(qc, id, title)
      setRenaming(false)
      toast('Report renamed.', 'success')
      return true
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not rename the report.', 'error')
      return false
    }
  }

  const remove = async () => {
    setDeleting(true)
    try {
      await deleteAiReport(qc, id)
      toast('Report deleted.', 'success')
      onBack()
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not delete the report.', 'error')
      setDeleting(false)
    }
  }

  // Over the days on screen: the saved period as of now, or the days chosen.
  const exportExcel = useCallback(async () => {
    setExporting(true)
    try {
      const res = await loadAiReportExport(id, override)
      // A rename made while it ran is newer than the copy the export carries: the file takes the title on screen.
      const report = newerAiReport(qc.getQueryData<AiReport>(keys.aiReport(id)), res.report)
      const data = report === res.report ? res : { ...res, report }
      downloadWorkbook(aiReportFilename(data.report.title, data.ranAt), aiReportSheets(data))
      toast(aiReportExportMessage(data), 'success')
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not export the report.', 'error')
    } finally {
      setExporting(false)
    }
  }, [id, override, qc, toast])
  const onExport = useCallback(() => void exportExcel(), [exportExcel])

  // Each section in the shape the answer's cards take, built once per run so the cards keep their state.
  const parts = useMemo(() => shown?.sections.map((s, i) => sectionAsQuery(s, shown.report.sections[i]?.sql ?? '', i)) ?? null, [shown])
  const sectionCount = full?.sections.length ?? known?.sectionCount ?? 2
  const failures = shown && !stale ? runFailures(shown.sections) : null

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className={cn('flex shrink-0 items-center gap-1 border-b border-slate-100 px-2 py-2 dark:border-slate-800', wide && 'sm:px-4 lg:px-6')}>
        <button type="button" onClick={onBack} className="icon-btn h-9 w-9 shrink-0 touch:h-11 touch:w-11" aria-label="Back to My reports" data-tip="My reports">
          <ArrowLeft className="h-5 w-5 rtl:rotate-180" />
        </button>
        {renaming && report ? (
          <ReportTitleEditor initial={report.title} onSave={rename} onCancel={() => setRenaming(false)} />
        ) : (
          <>
            {/* Two lines, then cut: one line cut short splits a figure in an Arabic title ("آخر 30 يوم" read as "آخر 0…"). */}
            <h3 dir="auto" className="line-clamp-2 min-w-0 flex-1 break-words px-1 text-start text-sm font-bold leading-snug" data-tip={report?.title}>
              {report?.title ?? 'Report'}
            </h3>
            {report && !gone && (
              <>
                <button type="button" onClick={() => setRenaming(true)} className="icon-btn h-9 w-9 shrink-0 touch:h-11 touch:w-11" aria-label="Rename the report" data-tip="Rename">
                  <Pencil className="h-4 w-4" />
                </button>
                <button type="button" onClick={() => setRemoving(true)} className="icon-btn h-9 w-9 shrink-0 hover:text-rose-600 touch:h-11 touch:w-11" aria-label="Delete the report" data-tip="Delete">
                  <Trash2 className="h-4 w-4" />
                </button>
              </>
            )}
          </>
        )}
      </div>

      <div className={cn('min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 py-3 sm:px-4', wide && 'sm:px-6 lg:px-8 lg:py-5')}>
        <div className={cn('space-y-3', wide && 'mx-auto w-full max-w-[1100px]')}>
          {gone ? (
            <Notice
              tone="red"
              action={
                <Button className="h-8 min-h-0 px-3 py-0 text-xs touch:h-11" onClick={onBack}>
                  <ArrowLeft className="h-3.5 w-3.5 rtl:rotate-180" /> My reports
                </Button>
              }
            >
              This report could not be found. It may have been deleted.
            </Notice>
          ) : (
            <>
              {report && (
                <div className="space-y-1">
                  <p dir="auto" className="whitespace-pre-wrap break-words text-13 text-muted">
                    {report.question}
                  </p>
                  {full?.conversationId && (
                    <button
                      type="button"
                      onClick={() => onOpenConversation(full.conversationId!)}
                      className="inline-flex items-center gap-1 text-xs font-semibold text-brand-700 hover:underline dark:text-brand-300 touch:min-h-[44px]"
                    >
                      <MessageSquareText className="h-3.5 w-3.5" /> Open the conversation
                    </button>
                  )}
                </div>
              )}

              {report && hasAdjustablePeriod(report) && (
                <ReportPeriod saved={report.period!} ran={shown?.period ?? null} state={period} dispatch={setPeriod} />
              )}

              <div className="flex flex-wrap items-center gap-2">
                <button type="button" onClick={() => void run.refetch()} disabled={run.isFetching} className={SMALL_BTN} data-tip="Runs every section again now">
                  <RefreshCw className={cn('h-3.5 w-3.5', run.isFetching && 'animate-spin')} /> {run.isFetching ? 'Running…' : 'Run again'}
                </button>
                <button type="button" onClick={onExport} disabled={exporting || !report} className={SMALL_BTN} data-tip={EXPORT_TIP}>
                  {exporting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FileSpreadsheet className="h-3.5 w-3.5" />} {exporting ? 'Exporting…' : 'Export Excel'}
                </button>
                {shown && <RunLine run={shown} running={run.isFetching ? (stale ? 'Running over the days chosen…' : 'Running again…') : null} />}
              </div>

              {/* Heard when a run ends, not while the tables are drawn. */}
              <p role="status" aria-live="polite" className="sr-only">
                {run.isFetching ? 'Running the report…' : shown ? 'Report ready.' : ''}
              </p>

              {run.isError && (
                <Notice
                  tone="red"
                  action={
                    <>
                      <Button className="h-8 min-h-0 px-3 py-0 text-xs touch:h-11" onClick={() => void run.refetch()} disabled={run.isFetching}>
                        Try again
                      </Button>
                      {override && (
                        <Button className="h-8 min-h-0 px-3 py-0 text-xs touch:h-11" onClick={() => setPeriod({ type: 'reset' })}>
                          <Undo2 className="h-3.5 w-3.5" /> Reset to the saved period
                        </Button>
                      )}
                    </>
                  }
                >
                  {run.error instanceof Error ? run.error.message : 'The report could not be run.'}
                </Notice>
              )}

              {failures && <Notice tone="amber">{failures} Each says why below.</Notice>}

              {/* Other days' tables are dimmed and still while the asked-for ones come; the same days', only dimmed. */}
              <div className={cn('space-y-2 transition-opacity', stale ? 'pointer-events-none opacity-50' : run.isFetching && shown && 'opacity-70')} aria-busy={run.isFetching}>
                {parts && shown
                  ? parts.map((part, i) => <ReportSection key={i} part={part} templated={shown.report.adjustable} onExport={onExport} exporting={exporting} />)
                  : run.isPending && Array.from({ length: Math.max(1, sectionCount) }, (_, i) => <SectionSkeleton key={i} title={full?.sections[i]?.title} />)}
              </div>
            </>
          )}
        </div>
      </div>

      {removing && report && <DeleteReportModal report={report} busy={deleting} onCancel={() => setRemoving(false)} onConfirm={() => void remove()} />}
    </div>
  )
}

/** The days the tables on screen cover, and when they were run; while a run is on its way, that it is. */
function RunLine({ run, running }: { run: AiReportRunResponse; running: string | null }) {
  const days = runPeriodText(run.period)
  return (
    <p className="min-w-0 flex-1 basis-full text-[11px] tabular-nums text-muted sm:basis-auto sm:text-end">
      {running ? (
        <span className="inline-flex items-center gap-1">
          <Loader2 className="h-3 w-3 animate-spin" /> {running}
        </span>
      ) : (
        <>
          {days && (
            <>
              <span dir="auto" className={cn(run.period?.overridden && 'font-semibold text-brand-700 dark:text-brand-300')}>
                {days}
              </span>
              <span aria-hidden> · </span>
            </>
          )}
          <time dateTime={run.ranAt} data-tip={`Run ${formatFullTimestamp(run.ranAt)}`}>
            ran {when(run.ranAt)}
          </time>
        </>
      )}
    </p>
  )
}

/**
 * The period a report runs over: as saved (its question's period, as of
 * today), or days chosen for this run. Choosing starts from the days the
 * tables on screen cover; Apply runs them; Reset goes back to the saved one.
 * Its state is the report view's (see ReportPeriodState).
 */
function ReportPeriod({
  saved,
  ran,
  state,
  dispatch,
}: {
  saved: AiReportPeriod
  ran: AiReportRunResponse['period']
  state: ReportPeriodState
  dispatch: Dispatch<ReportPeriodAction>
}) {
  const { override, choosing, from, to } = state
  const { problem, ready, applied } = reportPeriodDraft(state)
  const choose = () => dispatch({ type: 'choose', ran })
  const reset = () => dispatch({ type: 'reset' })
  const apply = () => dispatch({ type: 'apply' })

  const option = (on: boolean) =>
    cn(
      'inline-flex h-8 min-w-0 items-center gap-1.5 rounded-md px-2.5 text-xs font-semibold transition-colors touch:h-10',
      on ? 'bg-white text-brand-700 shadow-sm dark:bg-slate-900 dark:text-brand-300' : 'text-muted hover:text-slate-700 dark:hover:text-slate-200',
    )

  return (
    <div className="space-y-2 rounded-xl bg-slate-50 p-2.5 ring-1 ring-slate-200/70 dark:bg-slate-800/50 dark:ring-slate-800">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[11px] font-bold uppercase tracking-wide text-muted">Period</span>
        <div role="group" aria-label="Period" className="inline-flex max-w-full items-center rounded-lg bg-slate-200/70 p-0.5 dark:bg-slate-800">
          <button type="button" aria-pressed={!choosing} onClick={reset} className={option(!choosing)}>
            <span className="truncate">As saved: {describeAiPeriod(saved)}</span>
          </button>
          <button type="button" aria-pressed={choosing} onClick={choose} className={option(choosing)}>
            <CalendarRange className="h-3.5 w-3.5 shrink-0" /> Choose days
          </button>
        </div>
        {override && (
          <button type="button" onClick={reset} className="inline-flex items-center gap-1 text-xs font-semibold text-brand-700 hover:underline dark:text-brand-300 touch:min-h-[44px]">
            <Undo2 className="h-3.5 w-3.5" /> Reset to the saved period
          </button>
        )}
      </div>
      {choosing && (
        <form
          className="flex flex-wrap items-center gap-1.5"
          onSubmit={(e) => {
            e.preventDefault()
            apply()
          }}
        >
          <input type="date" aria-label="First day" value={from} max={to || undefined} onChange={(e) => dispatch({ type: 'from', value: e.target.value })} className="input h-9 w-[9.25rem] px-2 py-0 text-13 tabular-nums touch:h-11" />
          <span className="text-muted" aria-hidden>
            –
          </span>
          <input type="date" aria-label="Last day" value={to} min={from || undefined} onChange={(e) => dispatch({ type: 'to', value: e.target.value })} className="input h-9 w-[9.25rem] px-2 py-0 text-13 tabular-nums touch:h-11" />
          <Button type="submit" variant="primary" disabled={!ready || applied} className="h-9 min-h-0 px-3 py-0 text-xs touch:h-11">
            Apply
          </Button>
          <span className={cn('basis-full text-[11px] tabular-nums', problem ? 'font-semibold text-rose-600 dark:text-rose-400' : 'text-muted')} aria-live="polite">
            {problem ?? (ready ? `${daysInRange({ from, to }).toLocaleString('en-US')} ${daysInRange({ from, to }) === 1 ? 'day' : 'days'}, both counted — for this run only; the report keeps its saved period.` : '')}
          </span>
        </form>
      )}
    </div>
  )
}

function SectionSkeleton({ title }: { title?: string }) {
  return (
    <div className="overflow-hidden rounded-xl bg-white ring-1 ring-slate-200 dark:bg-slate-900 dark:ring-slate-800" aria-hidden>
      <div className="flex items-center gap-2.5 px-3 py-2.5">
        <Loader2 className="h-4 w-4 shrink-0 animate-spin text-brand-600 dark:text-brand-300" />
        {title ? (
          <span dir="auto" className="min-w-0 flex-1 truncate text-13 font-semibold text-slate-800 dark:text-slate-100">
            {title}
          </span>
        ) : (
          <span className="skeleton h-4 flex-1" />
        )}
      </div>
      <div className="space-y-1.5 border-t border-slate-100 px-3 pb-3 pt-2 dark:border-slate-800">
        <div className="skeleton h-6" />
        <div className="skeleton h-6" />
        <div className="skeleton h-6 w-2/3" />
      </div>
    </div>
  )
}

/**
 * A section as run: the answer's query card turned out — its rows show at
 * once (they are what a report is for), the SQL on request. `templated`: the
 * SQL carries {{from}} and {{to}} for the period's first and last day.
 */
const ReportSection = memo(function ReportSection({ part, templated, onExport, exporting }: { part: AiQueryPart; templated: boolean; onExport: () => void; exporting: boolean }) {
  const { toast } = useApp()
  const [showSql, setShowSql] = useState(false)
  const [table, setTable] = useState(false)

  const copySql = async () => {
    try {
      await navigator.clipboard.writeText(part.sql)
      toast('SQL copied.', 'success')
    } catch {
      toast('Could not copy — select the SQL and copy it by hand.', 'error')
    }
  }

  const meta = part.ok
    ? `${part.rowCount.toLocaleString()}${part.truncated ? '+' : ''} ${part.rowCount === 1 && !part.truncated ? 'row' : 'rows'} · ${part.ms.toLocaleString()} ms`
    : `Failed · ${part.ms.toLocaleString()} ms`
  const placeholders = templated && /\{\{(from|to)\}\}/.test(part.sql)
  // Drawn as the answer drew it, from this run's rows.
  const chart = useMemo(() => queryChart(part), [part])

  return (
    <section className={cn('overflow-hidden rounded-xl bg-white ring-1 dark:bg-slate-900', part.ok ? 'ring-slate-200 dark:ring-slate-800' : 'ring-rose-200 dark:ring-rose-500/30')}>
      <header className="flex items-start gap-2.5 px-3 py-2">
        <span className="mt-0.5 shrink-0">{part.ok ? <CheckCircle2 className="h-4 w-4 text-emerald-600 dark:text-emerald-400" /> : <OctagonX className="h-4 w-4 text-rose-600 dark:text-rose-400" />}</span>
        <div className="min-w-0 flex-1">
          <h4 dir="auto" className="line-clamp-2 text-13 font-semibold text-slate-800 dark:text-slate-100">
            {part.purpose}
          </h4>
          <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px] tabular-nums text-muted">
            <span>{meta}</span>
            {part.truncated && (
              <Badge tone="amber" tip={`More rows matched than the ${AI_PREVIEW_ROWS} shown here. Export Excel runs the report again for all of them (up to ${AI_EXPORT_MAX_ROWS.toLocaleString()} a section).`}>
                Truncated
              </Badge>
            )}
          </p>
        </div>
      </header>

      <div className="space-y-2 border-t border-slate-100 px-3 pb-3 pt-2 dark:border-slate-800">
        {chart && <AiChart model={chart} />}
        {part.ok ? (
          <PreviewTable part={part} />
        ) : (
          <p dir="auto" className="whitespace-pre-wrap break-words rounded-lg bg-rose-50 px-2.5 py-2 text-xs text-rose-700 dark:bg-rose-500/10 dark:text-rose-300">
            {part.error || 'The query failed.'}
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          {part.ok && (
            <button type="button" onClick={() => setTable(true)} className={SMALL_BTN} disabled={part.rows.length === 0}>
              <Table2 className="h-3.5 w-3.5" /> Open table
            </button>
          )}
          {part.sql && (
            <button type="button" onClick={() => setShowSql((s) => !s)} aria-expanded={showSql} className={SMALL_BTN}>
              <ChevronDown className={cn('h-3.5 w-3.5 transition-transform duration-200', showSql && 'rotate-180')} /> {showSql ? 'Hide SQL' : 'SQL'}
            </button>
          )}
        </div>
        {showSql && (
          <div className="space-y-1">
            <AiCode label="SQL" onCopy={() => void copySql()} copyLabel="Copy the SQL" className="rounded-lg" codeClassName="max-h-56 p-2.5 text-[11px]">
              {part.sql}
            </AiCode>
            {placeholders && (
              <p className="text-[11px] text-muted">
                <code dir="ltr" className="font-mono">{'{{from}}'}</code> and <code dir="ltr" className="font-mono">{'{{to}}'}</code> stand for the first and last day of the period it runs over.
              </p>
            )}
          </div>
        )}
      </div>

      {table && part.ok && <AiResultModal part={part} onClose={() => setTable(false)} onExport={onExport} exporting={exporting} exportLabel={EXPORT_LABEL} exportTip={EXPORT_TIP} />}
    </section>
  )
})
