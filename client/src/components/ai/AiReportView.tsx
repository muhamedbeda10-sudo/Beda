// ============================================================================
// §20 — one saved report, run now. Opening it runs every section's SQL
// through the server's read-only runner (no model, no cost) and shows each
// as a report reads: its title, its figures, chart or rows in full (names
// over several lines, never cut), a large table with Excel's filters. What
// the report and each section are about sits behind an info button, out of
// the way; the SQL stays in the conversation it came from, not here. On the
// full page it takes the page's width. A report that kept its question's
// period ("last 30 days") runs over that period as of today; other days can
// be chosen for a run (not saved), and reset. A report the assistant built
// may ask for inputs (orders, a week…): a form over its sections, run with
// Run, each field starting from its default; one that cannot run before
// something is typed waits for it. Its sections may be headline figures or a
// tree as well as tables. Export Excel takes every section in full, a sheet
// each, after a sheet on the report itself, drawn in the report's style (the
// server makes it); Print draws it in that style too. Only its maker
// renames or deletes a report, chooses its style and adds its Excel forms; a
// shared one says whose it is, and anyone who opens it fills its forms.
// ============================================================================

import { memo, useCallback, useMemo, useReducer, useState, type Dispatch } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import {
  ArrowLeft,
  CalendarRange,
  FileSpreadsheet,
  Info,
  Loader2,
  MessageSquareText,
  OctagonX,
  Pencil,
  Printer,
  RefreshCw,
  Table2,
  Trash2,
  Undo2,
  Users,
} from 'lucide-react'
import {
  AI_EXPORT_MAX_ROWS,
  AI_PREVIEW_ROWS,
  describeAiPeriod,
  type AiQueryPart,
  type AiReport,
  type AiReportPeriod,
  type AiReportRunResponse,
  type AiReportSectionRun,
  type AiReportSummary,
} from '@qc/shared/ai'
import type { AiReportInputValues } from '@qc/shared/aiReportInputs'
import { Badge, Button } from '@/components/ui'
import { ApiError } from '@/lib/api'
import { cn, formatDate, formatFullTimestamp, formatTime, saveBlob } from '@/lib/utils'
import { deleteAiReport, renameAiReport } from '@/services/mutations'
import { keys, useAiExcel, useAiReport, useAiReportRun } from '@/services/queries'
import { loadReportWorkbook } from '@/services/reportStyles'
import { ReportLookPanel } from '@/components/reportStyles/ReportLookPanel'
import { paperWhen, type PrintPart } from '@/components/print/PrintSheet'
import { ReportPrint } from '@/components/print/reportPrints'
import { usePrint } from '@/components/print/usePrint'
import { useApp } from '@/store/AppContext'
import { useAi } from './AiAssistantProvider'
import { Notice } from './AiNotice'
import { DeleteReportModal, ReportTitleEditor } from './AiReportList'
import { AiChart } from './AiChart'
import { AiPhotoGallery } from './AiPhotoGallery'
import { AiResultModal, PreviewTable } from './AiResultTable'
import { queryChart } from './chartData'
import { ChartImageTool } from './chartImage'
import { queryPhotos } from './photos'
import { aiReportFilename } from './exportAiReport'
import { ReportInputsForm, SectionFigures, SectionTree } from './AiReportLayouts'
import { inputDrafts, inputsKey, inputsLine, localDay, readDrafts, runsOnOpen, treeAsTable } from './reportInputs'
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
const EXPORT_TIP = 'Runs every section again now, in full, and saves them as a workbook in the report’s style: a sheet each, after a sheet on the report'

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
  /** The full page: the report takes the page's width. */
  wide?: boolean
}) {
  const qc = useQueryClient()
  const { toast } = useApp()
  const { enabled } = useAi()
  // The period control and the days of the run (override: days chosen; null runs the saved period, as of today), one state.
  const [period, setPeriod] = useReducer(reportPeriodReducer, REPORT_PERIOD_SAVED)
  const override = period.override
  const detail = useAiReport(id, enabled)
  // The inputs' values a run is asked for: null runs each with its default (the server's, as of the factory's today).
  const today = useMemo(() => localDay(), [])
  const [applied, setApplied] = useState<AiReportInputValues | null>(null)
  // What the fields hold once the person typed in them; untouched, they show what the last run used.
  const [drafts, setDrafts] = useState<Record<string, string> | null>(null)
  const [problems, setProblems] = useState<string[]>([])
  const inputsJson = inputsKey(applied)
  const loaded: AiReport | undefined = detail.data
  const inputCount = loaded ? loaded.inputs.length : known?.inputCount
  // A report with inputs waits for its definition; one whose required inputs have no default waits for them to be typed.
  const canRun = inputCount === 0 || (loaded !== undefined && (applied !== null || runsOnOpen(loaded.inputs, today)))
  const run = useAiReportRun(id, override, inputsJson, enabled && canRun)
  const [renaming, setRenaming] = useState(false)
  const [removing, setRemoving] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [exporting, setExporting] = useState(false)
  // What the report is about (its description, or the question it came from): behind the info button.
  const [about, setAbout] = useState(false)

  const report: AiReport | AiReportSummary | undefined = detail.data ?? run.data?.report ?? known
  const full: AiReport | undefined = detail.data ?? run.data?.report
  const shown = run.data
  const inputs = full?.inputs ?? []
  const fields = drafts ?? inputDrafts(inputs, shown?.inputs ?? null, today)
  const waiting = inputs.length > 0 && !canRun
  const runInputs = () => {
    const read = readDrafts(inputs, fields, today)
    if ('problems' in read) {
      setProblems(read.problems)
      return
    }
    setProblems([])
    if (inputsKey(read.values) === inputsJson) void run.refetch()
    else setApplied(read.values)
  }
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

  // Over the days on screen: the saved period as of now, or the days chosen; drawn by the server in the report's style.
  const title = report?.title
  const exportExcel = useCallback(async () => {
    setExporting(true)
    try {
      const file = await loadReportWorkbook(id, override, inputsJson)
      saveBlob(aiReportFilename(qc.getQueryData<AiReport>(keys.aiReport(id))?.title ?? title ?? 'Report', new Date().toISOString()), file)
      // Its last run moved.
      void qc.invalidateQueries({ queryKey: keys.aiReports })
      toast('Exported the report to Excel, in its style.', 'success')
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not export the report.', 'error')
    } finally {
      setExporting(false)
    }
  }, [id, override, inputsJson, qc, toast, title])
  const onExport = useCallback(() => void exportExcel(), [exportExcel])
  // Excel is for the people the assistant's owner allows (§20).
  const excel = useAiExcel()
  // Printed as run on screen: these days, these rows.
  const printer = usePrint()

  // Each section in the shape the answer's cards take, built once per run so the cards keep their state.
  const parts = useMemo(() => shown?.sections.map((s, i) => sectionAsQuery(s, shown.report.sections[i]?.sql ?? '', i)) ?? null, [shown])
  // As print shows them: headline figures as figures, a tree as its rows in order, stepped in, without its key and
  // parent columns.
  const printParts = useMemo(
    () =>
      parts?.map((part, i): PrintPart => {
        const s = shown?.sections[i]
        const flat = s?.display === 'tree' && s.tree && part.ok ? treeAsTable(part.columns, part.rows, s.tree) : null
        if (flat) return { part: { ...part, columns: flat.columns, rows: flat.rows } }
        return { part, display: s?.display === 'figures' ? 'figures' : 'table' }
      }) ?? null,
    [parts, shown],
  )
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
            <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-0.5 px-1">
              <h3 dir="auto" className={cn('line-clamp-2 min-w-0 break-words text-start font-bold leading-snug', wide ? 'text-base' : 'text-sm')} data-tip={report?.title}>
                {report?.title ?? 'Report'}
              </h3>
              {report?.shared && (
                <Badge tone="blue" tip="Everyone given the assistant may open it; each sees the data they may read">
                  <Users className="h-3 w-3" /> Shared
                </Badge>
              )}
              {report && !report.mine && (
                <span dir="auto" className="text-[11px] text-muted">
                  by {report.ownerName}
                </span>
              )}
            </div>
            {report && !gone && (
              <button
                type="button"
                onClick={() => setAbout((a) => !a)}
                aria-expanded={about}
                className={cn('icon-btn h-9 w-9 shrink-0 touch:h-11 touch:w-11', about && 'bg-brand-50 text-brand-700 dark:bg-brand-500/15 dark:text-brand-300')}
                aria-label="About this report"
                data-tip="About this report"
              >
                <Info className="h-4 w-4" />
              </button>
            )}
            {report && !gone && report.mine && (
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

      {printer.node}
      <div className={cn('min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 py-3 sm:px-4', wide && 'ai-report sm:px-6 lg:px-8 lg:py-5')}>
        <div className={cn('w-full', wide ? 'space-y-4' : 'space-y-3')}>
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
              {report && about && (
                <div className="space-y-1.5 rounded-xl bg-slate-50 px-3 py-2.5 ring-1 ring-slate-200/70 dark:bg-slate-800/50 dark:ring-slate-800">
                  <p dir="auto" className="whitespace-pre-wrap break-words text-13 text-slate-700 dark:text-slate-200">
                    {report.description || report.question}
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

              {inputs.length > 0 && (
                <ReportInputsForm
                  inputs={inputs}
                  drafts={fields}
                  onChange={(name, value) => setDrafts({ ...fields, [name]: value })}
                  onRun={runInputs}
                  problems={problems}
                  running={run.isFetching}
                />
              )}

              {report && hasAdjustablePeriod(report) && (
                <ReportPeriod saved={report.period!} ran={shown?.period ?? null} state={period} dispatch={setPeriod} />
              )}

              <div className="flex flex-wrap items-center gap-2">
                <button type="button" onClick={() => void run.refetch()} disabled={run.isFetching || !canRun} className={SMALL_BTN} data-tip="Runs every section again now">
                  <RefreshCw className={cn('h-3.5 w-3.5', run.isFetching && 'animate-spin')} /> {run.isFetching ? 'Running…' : 'Run again'}
                </button>
                {excel && (
                  <button type="button" onClick={onExport} disabled={exporting || !report || !canRun} className={SMALL_BTN} data-tip={EXPORT_TIP}>
                    {exporting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FileSpreadsheet className="h-3.5 w-3.5" />} {exporting ? 'Exporting…' : 'Export Excel'}
                  </button>
                )}
                {shown && printParts && (
                  <button
                    type="button"
                    onClick={() =>
                      printer.print(
                        <ReportPrint
                          kind="Saved report"
                          title={shown.report.title}
                          lines={[
                            // What it shows, when the assistant said; never the question it came from.
                            shown.report.description ?? '',
                            inputsLine(shown.report.inputs, shown.inputs),
                            shown.period ? `Covers ${shown.period.label}` : '',
                            `Data read ${paperWhen(shown.ranAt)}`,
                          ].filter(Boolean)}
                          sections={printParts}
                          style={shown.style}
                        />,
                        { title: shown.report.title, day: localDay(new Date(shown.ranAt)), style: shown.style },
                      )
                    }
                    disabled={run.isFetching}
                    className={SMALL_BTN}
                    data-tip="Print the report as run here, or save it as a PDF from the print window"
                  >
                    <Printer className="h-3.5 w-3.5" /> Print
                  </button>
                )}
                {shown && <RunLine run={shown} running={run.isFetching ? (stale ? 'Running over the days chosen…' : 'Running again…') : null} />}
              </div>

              {full && <ReportLookPanel report={full} run={shown} range={override} inputs={inputsJson} excel={excel} canRun={canRun} />}

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

              {waiting && <Notice tone="neutral">Fill in {inputs.filter((i) => i.required).map((i) => i.label).join(', ') || 'the fields'} above and press Run.</Notice>}

              {/* Other days' tables are dimmed and still while the asked-for ones come; the same days', only dimmed. */}
              <div className={cn(wide ? 'space-y-4' : 'space-y-2', 'transition-opacity', stale ? 'pointer-events-none opacity-50' : run.isFetching && shown && 'opacity-70')} aria-busy={run.isFetching}>
                {parts && shown
                  ? parts.map((part, i) => (
                      <ReportSection key={i} part={part} layout={shown.sections[i]} onExport={excel ? onExport : undefined} exporting={exporting} />
                    ))
                  : run.isPending && !waiting && Array.from({ length: Math.max(1, sectionCount) }, (_, i) => <SectionSkeleton key={i} title={full?.sections[i]?.title} />)}
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
 * A section as run, as a report reads: its title, its figures, chart, tree or
 * rows (names in full), and the large table. What it means (its note) is
 * behind the info button by its title; a section that failed says why.
 */
const ReportSection = memo(function ReportSection({
  part,
  layout,
  onExport,
  exporting,
}: {
  part: AiQueryPart
  /** How the section shows its rows (a table, figures, a tree), and its note. */
  layout?: Pick<AiReportSectionRun, 'display' | 'tree' | 'note'>
  onExport?: () => void
  exporting: boolean
}) {
  const [table, setTable] = useState(false)
  const [note, setNote] = useState(false)
  const display = layout?.display ?? 'table'
  // Drawn as the answer drew it, from this run's rows; Open table shows the rows themselves.
  const chart = useMemo(() => queryChart(part), [part])
  const tree = part.ok && display === 'tree' && layout?.tree && part.columns.includes(layout.tree.key) && part.columns.includes(layout.tree.parent)
  // A section of photos is shown as the photos, whatever else it was built as.
  const photos = useMemo(() => queryPhotos(part), [part])

  return (
    <section className={cn('overflow-hidden rounded-2xl bg-white shadow-sm ring-1 dark:bg-slate-900', part.ok ? 'ring-slate-200 dark:ring-slate-800' : 'ring-rose-200 dark:ring-rose-500/30')}>
      <header className="flex flex-wrap items-center gap-2 px-4 pb-2 pt-3">
        {!part.ok && <OctagonX className="h-4 w-4 shrink-0 text-rose-600 dark:text-rose-400" aria-label="Failed" />}
        <h4 dir="auto" className="min-w-0 flex-1 basis-40 text-sm font-bold text-slate-900 dark:text-white [overflow-wrap:anywhere]">
          {part.purpose}
        </h4>
        {part.truncated && (
          <Badge tone="amber" tip={`More rows matched than the ${AI_PREVIEW_ROWS} shown here. Export Excel runs the report again for all of them (up to ${AI_EXPORT_MAX_ROWS.toLocaleString()} a section).`}>
            First {AI_PREVIEW_ROWS}
          </Badge>
        )}
        {layout?.note && (
          <button
            type="button"
            onClick={() => setNote((n) => !n)}
            aria-expanded={note}
            aria-label="What this section shows"
            data-tip={note ? undefined : layout.note.slice(0, 600)}
            className={cn('icon-btn h-8 w-8 shrink-0 touch:h-11 touch:w-11', note && 'bg-brand-50 text-brand-700 dark:bg-brand-500/15 dark:text-brand-300')}
          >
            <Info className="h-4 w-4" />
          </button>
        )}
      </header>

      <div className="space-y-2.5 px-4 pb-4">
        {note && layout?.note && (
          <p dir="auto" className="rounded-lg bg-slate-50 px-2.5 py-1.5 text-xs leading-snug text-slate-600 dark:bg-slate-800/60 dark:text-slate-300">
            {layout.note}
          </p>
        )}
        {photos ? (
          <AiPhotoGallery photos={photos} />
        ) : part.ok && display === 'figures' ? (
          <SectionFigures columns={part.columns} rows={part.rows} />
        ) : tree ? (
          <SectionTree columns={part.columns} rows={part.rows} tree={layout!.tree!} truncated={part.truncated} />
        ) : chart && display === 'table' ? (
          <AiChart model={chart} />
        ) : part.ok ? (
          <PreviewTable part={part} wrap />
        ) : (
          <p dir="auto" className="whitespace-pre-wrap break-words rounded-lg bg-rose-50 px-2.5 py-2 text-xs text-rose-700 dark:bg-rose-500/10 dark:text-rose-300">
            {part.error || 'The query failed.'}
          </p>
        )}
        {part.ok && display !== 'figures' && part.rows.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5">
            <button type="button" onClick={() => setTable(true)} className={SMALL_BTN}>
              <Table2 className="h-3.5 w-3.5" /> Open table
            </button>
            {chart && display === 'table' && !photos && <ChartImageTool model={chart} title={chart.title ?? part.purpose} className="text-xs text-muted" />}
          </div>
        )}
      </div>

      {table && part.ok && <AiResultModal part={part} onClose={() => setTable(false)} onExport={onExport} exporting={exporting} exportLabel={EXPORT_LABEL} exportTip={EXPORT_TIP} />}
    </section>
  )
})
