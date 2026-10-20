// ============================================================================
// §20 — a saved report run on screen, as both of its views draw it: its
// maker's in My reports (AiReportView, inside the assistant's popup) and that
// of someone it is shared with on the Reports page (SharedReportView), whether
// or not they have the assistant. Nothing here needs the assistant's
// providers: each view brings its own run (useAiReportRun or
// useSharedReportRun) and its own Excel, and the same form, period, buttons,
// notices and sections follow, so the two read alike.
//
// Opening a report runs it (no model, no cost). A report that kept its
// question's period ("last 30 days") runs over that period as of today; other
// days can be chosen for a run (not saved), and reset. A report may ask for
// inputs (orders, a week…): a form over its sections, run with Run, each field
// starting from its default; one that cannot run before something is typed
// waits for it. Its sections may be headline figures or a tree as well as
// tables, and a section of photos shows the photos. Print draws the run on
// screen in the report's style.
// ============================================================================

import { memo, useMemo, useReducer, useState, type Dispatch, type ReactNode } from 'react'
import { CalendarRange, FileSpreadsheet, Info, Loader2, OctagonX, Printer, RefreshCw, Table2, Undo2 } from 'lucide-react'
import {
  AI_EXPORT_MAX_ROWS,
  AI_PREVIEW_ROWS,
  describeAiPeriod,
  type AiQueryPart,
  type AiReportPeriod,
  type AiReportSectionRun,
} from '@qc/shared/ai'
import type { AiReportInput, AiReportInputValues } from '@qc/shared/aiReportInputs'
import type { ReportRunView } from '@qc/shared/reportShares'
import { Badge, Button } from '@/components/ui'
import { cn, formatDate, formatFullTimestamp, formatTime } from '@/lib/utils'
import { paperWhen, type PrintPart } from '@/components/print/PrintSheet'
import { ReportPrint } from '@/components/print/reportPrints'
import { usePrint } from '@/components/print/usePrint'
import { useAuth } from '@/store/AuthContext'
import { Notice } from './AiNotice'
import { AiChart } from './AiChart'
import { AiPhotoGallery } from './AiPhotoGallery'
import { AiResultModal, PreviewTable } from './AiResultTable'
import { queryChart } from './chartData'
import { ChartImageTool } from './chartImage'
import { queryPhotos } from './photos'
import { ReportInputsForm, SectionFigures, SectionTree } from './AiReportLayouts'
import { inputDrafts, inputsKey, inputsLine, localDay, readDrafts, reportToday, runsOnOpen, treeAsTable } from './reportInputs'
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

export const SMALL_BTN = 'btn-secondary h-8 min-h-0 gap-1.5 px-2.5 py-0 text-xs touch:h-11 touch:px-3'
export const EXPORT_LABEL = 'Export report'
export const EXPORT_TIP = 'Runs every section again now, in full, and saves them as a workbook in the report’s style: a sheet each, after a sheet on the report'

/** Today's time, or the day and the time. */
const when = (iso: string) => (new Date(iso).toDateString() === new Date().toDateString() ? formatTime(iso) : `${formatDate(iso)}, ${formatTime(iso)}`)

/**
 * What a report view asks of a run before it runs: the period control and the days of the run (override: days
 * chosen; null runs the saved period, as of today), the inputs' values a run is asked for (null runs each with its
 * default, the server's, as of the factory's today), what the fields hold once typed in, and whether it can run yet.
 * `inputs`: the report's, once its definition is here; `inputCount`: what the list knew of them before.
 */
export function useReportRunState(inputs: readonly AiReportInput[] | undefined, inputCount: number | undefined) {
  const { factoryTimeZone } = useAuth()
  const [period, setPeriod] = useReducer(reportPeriodReducer, REPORT_PERIOD_SAVED)
  const today = useMemo(() => reportToday(factoryTimeZone), [factoryTimeZone])
  const [applied, setApplied] = useState<AiReportInputValues | null>(null)
  const [drafts, setDrafts] = useState<Record<string, string> | null>(null)
  const [problems, setProblems] = useState<string[]>([])
  const inputsJson = inputsKey(applied)
  const count = inputs ? inputs.length : inputCount
  // A report with inputs waits for its definition; one whose required inputs have no default waits for them to be typed.
  const canRun = count === 0 || (inputs !== undefined && (applied !== null || runsOnOpen([...inputs], today)))
  return { period, setPeriod, override: period.override, today, applied, setApplied, drafts, setDrafts, problems, setProblems, inputsJson, canRun }
}

export type ReportRunState = ReturnType<typeof useReportRunState>

/** A run as the view's query holds it: the one on screen, and where the next one is. */
export interface ReportRunQuery {
  data: ReportRunView | undefined
  isFetching: boolean
  isPending: boolean
  isError: boolean
  error: unknown
  /** The tables on screen belong to other days than those asked for: the next run is on its way. */
  isPlaceholderData: boolean
  refetch: () => unknown
}

/**
 * Everything under a report view's header: its inputs, its period, Run again / Export / Print and when it ran,
 * whatever the view adds there (`look`: the maker's style and forms), a word on what failed, and the sections.
 */
export function ReportRunBody({
  state,
  run,
  inputs,
  report,
  sectionCount,
  sectionTitles,
  sqlOf,
  excel,
  look,
  wide,
}: {
  state: ReportRunState
  run: ReportRunQuery
  /** The report's inputs, once known. */
  inputs: readonly AiReportInput[]
  /** Its period, as far as it is known. */
  report: { period: AiReportPeriod | null; adjustable: boolean } | undefined
  /** How many sections to draw while the first run is on its way, and their titles once known. */
  sectionCount: number
  sectionTitles: readonly (string | undefined)[]
  /** A section's SQL as it ran (the maker's view); a recipient never has it. */
  sqlOf?: (index: number) => string
  /** Export Excel, for someone allowed it; null otherwise. */
  excel: { onExport: () => void; exporting: boolean } | null
  look?: ReactNode
  wide: boolean
}) {
  const { period, setPeriod, override, today, drafts, setDrafts, problems, setProblems, inputsJson, canRun, setApplied } = state
  const shown = run.data
  const fields = drafts ?? inputDrafts([...inputs], shown?.inputs ?? null, today)
  const waiting = inputs.length > 0 && !canRun
  const runInputs = () => {
    const read = readDrafts([...inputs], fields, today)
    if ('problems' in read) {
      setProblems(read.problems)
      return
    }
    setProblems([])
    if (inputsKey(read.values) === inputsJson) void run.refetch()
    else setApplied(read.values)
  }
  const stale = run.isPlaceholderData
  // Printed as run on screen: these days, these rows.
  const printer = usePrint()
  // Each section in the shape the answer's cards take, built once per run so the cards keep their state.
  const parts = useMemo(() => shown?.sections.map((s, i) => sectionAsQuery(s, sqlOf?.(i) ?? '', i)) ?? null, [shown, sqlOf])
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
  const failures = shown && !stale ? runFailures(shown.sections) : null
  const onExport = excel?.onExport

  return (
    <>
      {printer.node}
      {inputs.length > 0 && (
        <ReportInputsForm inputs={[...inputs]} drafts={fields} onChange={(name, value) => setDrafts({ ...fields, [name]: value })} onRun={runInputs} problems={problems} running={run.isFetching} />
      )}

      {report && hasAdjustablePeriod(report) && <ReportPeriod saved={report.period!} ran={shown?.period ?? null} state={period} dispatch={setPeriod} />}

      <div className="flex flex-wrap items-center gap-2">
        <button type="button" onClick={() => void run.refetch()} disabled={run.isFetching || !canRun} className={SMALL_BTN} data-tip="Runs every section again now">
          <RefreshCw className={cn('h-3.5 w-3.5', run.isFetching && 'animate-spin')} /> {run.isFetching ? 'Running…' : 'Run again'}
        </button>
        {excel && (
          <button type="button" onClick={excel.onExport} disabled={excel.exporting || !report || !canRun} className={SMALL_BTN} data-tip={EXPORT_TIP}>
            {excel.exporting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FileSpreadsheet className="h-3.5 w-3.5" />} {excel.exporting ? 'Exporting…' : 'Export Excel'}
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

      {look}

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
          ? parts.map((part, i) => <ReportSection key={i} part={part} layout={shown.sections[i]} onExport={onExport} exporting={excel?.exporting ?? false} />)
          : run.isPending && !waiting && Array.from({ length: Math.max(1, sectionCount) }, (_, i) => <SectionSkeleton key={i} title={sectionTitles[i]} />)}
      </div>
    </>
  )
}

/** The days the tables on screen cover, and when they were run; while a run is on its way, that it is. */
function RunLine({ run, running }: { run: ReportRunView; running: string | null }) {
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
  ran: ReportRunView['period']
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
export const ReportSection = memo(function ReportSection({
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
          <Badge
            tone="amber"
            tip={`More rows matched than the ${AI_PREVIEW_ROWS} shown here.${onExport ? ` Export Excel runs the report again for all of them (up to ${AI_EXPORT_MAX_ROWS.toLocaleString()} a section).` : ''}`}
          >
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
