// ============================================================================
// Reports: the saved reports their owners shared with this person — whether
// or not they have the AI assistant (shared/reportShares.ts). In the menu for
// whoever has one shared with them; the bell's alert of a new one opens it
// here (/reports/<id>).
//
// The list: each report's title, what it shows, who shared it and when it
// last changed, searchable. A report opened reads as its owner's report view
// reads (ReportRunBody): the values it asks for and its period, when its
// period can change; Run; each section's figures, chart, tree, photos or
// rows; Print in its style; Export Excel for whoever may export records.
// Nothing else: no SQL, no changing it, no styles, forms or assistant. It
// runs over the data its owner may read now; once its owner no longer has the
// assistant it runs for no one, and says so. Unshared or deleted while open,
// the next run says it is gone.
// ============================================================================

import '@/components/ai/fonts'
import { useCallback, useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { ArrowLeft, ChevronRight, FileChartColumn, Info, Loader2, Search } from 'lucide-react'
import type { SharedReport } from '@qc/shared/reportShares'
import { Badge, Button, Card, EmptyState, Input } from '@/components/ui'
import { Notice } from '@/components/ai/AiNotice'
import { ReportRunBody, useReportRunState } from '@/components/ai/ReportRunBody'
import { aiReportFilename } from '@/components/ai/exportAiReport'
import { SHARED_REPORT_GONE, mergeSharedPages, sharedReportGone, sharedReportLine } from '@/components/reports/sharedReports'
import { cn, formatDate, formatFullTimestamp, saveBlob } from '@/lib/utils'
import { useDebounced } from '@/services/queries'
import { loadSharedReportWorkbook, useSharedReport, useSharedReportRun, useSharedReports } from '@/services/reportShares'
import { useApp } from '@/store/AppContext'

export function ReportsPage() {
  const { id } = useParams()
  return <div className="ai-type mx-auto w-full max-w-5xl space-y-4">{id ? <SharedReportView key={id} id={id} /> : <SharedReportList />}</div>
}

/** The longest search the server takes. */
const SEARCH_MAX = 200

function SharedReportList() {
  const { toast } = useApp()
  const [term, setTerm] = useState('')
  // The server searches every report shared with the person, not only the pages loaded; asked once typing pauses.
  const search = useDebounced(term.trim(), 300)
  const { data, isLoading, isError, isFetching, refetch, hasNextPage, fetchNextPage, isFetchingNextPage } = useSharedReports(search)
  const reports = useMemo(() => mergeSharedPages(data?.pages), [data])

  const loadMore = async () => {
    if (isFetchingNextPage) return
    const res = await fetchNextPage()
    if (res.isFetchNextPageError) toast(res.error instanceof Error ? res.error.message : 'More reports could not be loaded.', 'error')
  }

  return (
    <>
      <header className="flex flex-wrap items-center gap-3">
        <span className="grid h-10 w-10 place-items-center rounded-xl bg-brand-50 text-brand-700 dark:bg-brand-500/15 dark:text-brand-300">
          <FileChartColumn className="h-5 w-5" />
        </span>
        <div className="min-w-0 flex-1">
          <h1 className="text-2xl font-extrabold tracking-tight">Reports</h1>
          <p className="text-13 text-muted">Reports shared with you: open one, fill in what it asks for and run it.</p>
        </div>
      </header>

      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
        <Input
          value={term}
          onChange={(e) => setTerm(e.target.value)}
          maxLength={SEARCH_MAX}
          placeholder="Search the reports shared with you"
          className="min-h-[44px] rounded-full pl-9 pr-9"
          aria-label="Search the reports shared with you"
          dir="auto"
        />
        {isFetching && term.trim() !== '' && <Loader2 aria-hidden className="absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-muted" />}
      </div>

      {isLoading ? (
        <Card className="flex items-center justify-center gap-2 p-10 text-sm text-muted">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading…
        </Card>
      ) : isError && !data ? (
        <Notice tone="red" action={<Button className="h-8 min-h-0 px-3 py-0 text-xs touch:h-11" onClick={() => void refetch()}>Try again</Button>}>
          The reports could not be loaded.
        </Notice>
      ) : reports.length === 0 ? (
        <EmptyState
          icon={<FileChartColumn className="h-10 w-10" />}
          title={search ? 'No report matches' : 'Nothing shared with you'}
          hint={search ? 'Try other words of its title.' : 'When someone shares a report with you, the bell tells you and it shows here.'}
        />
      ) : (
        <ul className="space-y-2">
          {reports.map((r) => (
            <li key={r.id}>
              <Link
                to={`/reports/${encodeURIComponent(r.id)}`}
                className="group flex items-center gap-3 rounded-2xl bg-white px-3 py-3 shadow-sm ring-1 ring-slate-200 transition-colors hover:ring-brand-300 dark:bg-slate-900 dark:ring-slate-800 dark:hover:ring-brand-500/40"
              >
                <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-brand-100 text-brand-700 dark:bg-brand-500/20 dark:text-brand-200">
                  <FileChartColumn className="h-5 w-5" />
                </span>
                <span className="min-w-0 flex-1">
                  <span dir="auto" className="block break-words font-semibold text-slate-900 dark:text-white">
                    {r.title}
                  </span>
                  {r.description && (
                    <span dir="auto" className="mt-0.5 line-clamp-2 text-13 text-muted">
                      {r.description}
                    </span>
                  )}
                  <span className="mt-0.5 block text-xs text-muted">
                    {sharedReportLine(r)} ·{' '}
                    <time dateTime={r.updatedAt} data-tip={`Changed ${formatFullTimestamp(r.updatedAt)}`}>
                      changed {formatDate(r.updatedAt)}
                    </time>
                  </span>
                </span>
                <ChevronRight className="h-4 w-4 shrink-0 text-slate-300 transition-transform group-hover:translate-x-0.5 group-hover:text-brand-500 rtl:rotate-180" />
              </Link>
            </li>
          ))}
        </ul>
      )}

      {hasNextPage && (
        <div className="flex justify-center">
          <Button onClick={() => void loadMore()} disabled={isFetchingNextPage} className="min-h-[44px]">
            {isFetchingNextPage && <Loader2 className="h-4 w-4 animate-spin" />} Load more
          </Button>
        </div>
      )}
    </>
  )
}

/** A report shared with the person, opened: run as its owner's report view runs one, without its SQL or its owner's tools. */
function SharedReportView({ id }: { id: string }) {
  const { toast } = useApp()
  const detail = useSharedReport(id)
  const loaded: SharedReport | undefined = detail.data
  const state = useReportRunState(loaded?.inputs, undefined)
  const available = loaded?.available ?? false
  const run = useSharedReportRun(id, state.override, state.inputsJson, available && state.canRun)
  const [about, setAbout] = useState(false)
  const [exporting, setExporting] = useState(false)
  const report = run.data?.report ?? loaded
  const gone = sharedReportGone(detail.error) || sharedReportGone(run.error)
  // Its owner lost the assistant while it was open: the run says so, as the report does once read again.
  const unavailable = report && !report.available ? report.unavailable : null

  const { override, inputsJson } = state
  const exportExcel = useCallback(async () => {
    setExporting(true)
    try {
      const file = await loadSharedReportWorkbook(id, override, inputsJson)
      saveBlob(aiReportFilename(report?.title ?? 'Report', new Date().toISOString()), file)
      toast('Exported the report to Excel, in its style.', 'success')
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not export the report.', 'error')
    } finally {
      setExporting(false)
    }
  }, [id, override, inputsJson, report?.title, toast])
  const onExport = useCallback(() => void exportExcel(), [exportExcel])

  const back = (
    <Link to="/reports" className="inline-flex min-h-[40px] items-center gap-1 text-13 font-semibold text-brand-700 hover:underline dark:text-brand-300 touch:min-h-[44px]">
      <ArrowLeft className="h-4 w-4 rtl:rotate-180" /> Reports
    </Link>
  )

  if (gone) {
    return (
      <>
        {back}
        <Notice tone="red">{SHARED_REPORT_GONE}</Notice>
      </>
    )
  }
  if (!report) {
    return (
      <>
        {back}
        {detail.isError ? (
          <Notice tone="red" action={<Button className="h-8 min-h-0 px-3 py-0 text-xs touch:h-11" onClick={() => void detail.refetch()}>Try again</Button>}>
            The report could not be loaded.
          </Notice>
        ) : (
          <Card className="flex items-center justify-center gap-2 p-10 text-sm text-muted">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading the report…
          </Card>
        )}
      </>
    )
  }

  return (
    <>
      <header className="space-y-2">
        {back}
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1 space-y-1">
            <h1 dir="auto" className="break-words text-2xl font-extrabold tracking-tight">
              {report.title}
            </h1>
            <p className="flex flex-wrap items-center gap-1.5 text-xs text-muted">
              <Badge tone="blue">Shared with you</Badge>
              <span dir="auto">by {report.ownerName}</span>
              <span aria-hidden>·</span>
              <time dateTime={report.updatedAt} data-tip={`Changed ${formatFullTimestamp(report.updatedAt)}`}>
                changed {formatDate(report.updatedAt)}
              </time>
            </p>
          </div>
          {report.description && (
            <button
              type="button"
              onClick={() => setAbout((a) => !a)}
              aria-expanded={about}
              className={cn('icon-btn h-10 w-10 shrink-0 touch:h-11 touch:w-11', about && 'bg-brand-50 text-brand-700 dark:bg-brand-500/15 dark:text-brand-300')}
              aria-label="About this report"
              data-tip="About this report"
            >
              <Info className="h-4 w-4" />
            </button>
          )}
        </div>
        {about && report.description && (
          <p dir="auto" className="whitespace-pre-wrap break-words rounded-xl bg-slate-50 px-3 py-2.5 text-13 text-slate-700 ring-1 ring-slate-200/70 dark:bg-slate-800/50 dark:text-slate-200 dark:ring-slate-800">
            {report.description}
          </p>
        )}
      </header>

      {unavailable ? (
        <Notice tone="amber">{unavailable}</Notice>
      ) : (
        <div className="space-y-4">
          <ReportRunBody
            state={state}
            run={run}
            inputs={report.inputs}
            report={report}
            sectionCount={report.sections.length}
            sectionTitles={report.sections.map((s) => s.title)}
            excel={report.excel ? { onExport, exporting } : null}
            wide
          />
        </div>
      )}
    </>
  )
}
