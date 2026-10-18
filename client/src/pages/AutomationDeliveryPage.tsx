// ============================================================================
// §21 — a scheduled report as it was delivered: what its bell alert and its
// chat message open. Its summary (the assistant's words, drawn as the
// assistant draws an answer, though only links to the app's own pages are
// followed: it goes to whole roles), the days it covered, and each section's rows
// as they ran — in the assistant's tables, opening large with Excel's
// filters — with Export Excel for the whole of it (in its style, made by the
// server) and its saved report's Excel forms, filled. It shows what was sent,
// never runs again; the people it went to may open it (whether or not they
// use the assistant), as may its creator and the assistant's owner. To
// anyone else it does not exist.
// ============================================================================

import '@/components/ai/fonts'
import { memo, useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { ArrowRight, CheckCircle2, FileChartColumn, FileSpreadsheet, Loader2, OctagonX, Printer, Sparkles, Table2 } from 'lucide-react'
import { AI_PREVIEW_ROWS, type AiQueryPart, type AiReportSectionRun } from '@qc/shared/ai'
import type { AutomationDelivery } from '@qc/shared/automation'
import { Badge, Button, Card } from '@/components/ui'
import { AiMarkdown } from '@/components/ai/AiMarkdown'
import { Notice } from '@/components/ai/AiNotice'
import { AiChart } from '@/components/ai/AiChart'
import { ChartTableSwitch, type FigureView } from '@/components/dashboard/figureView'
import { AiResultModal, PreviewTable } from '@/components/ai/AiResultTable'
import { queryChart } from '@/components/ai/chartData'
import { ChartImageTool } from '@/components/ai/chartImage'
import { useAi } from '@/components/ai/AiAssistantProvider'
import { sectionAsQuery } from '@/components/ai/reports'
import { SectionFigures, SectionTree, sectionDisplay } from '@/components/ai/AiReportLayouts'
import { localDay, treeAsTable } from '@/components/ai/reportInputs'
import { AiPhotoGallery } from '@/components/ai/AiPhotoGallery'
import { queryPhotos } from '@/components/ai/photos'
import { periodText } from '@/components/automations/parts'
import { deliveryFilename } from '@/components/automations/exportDelivery'
import { factoryMoment, factoryTimestamp } from '@/components/automations/wording'
import { ApiError } from '@/lib/api'
import type { PrintPart } from '@/components/print/PrintSheet'
import { ReportPrint } from '@/components/print/reportPrints'
import { usePrint } from '@/components/print/usePrint'
import { cn, saveBlob } from '@/lib/utils'
import { loadDeliveryWorkbook, loadFilledDeliveryForm } from '@/services/reportStyles'
import { useAutomationDelivery } from '@/services/automations'
import { mayOpenAutomation } from '@/components/followUps/wording'
import { useOwnAutomationIds } from '@/services/followUps'
import { useApp } from '@/store/AppContext'
import { useAuth } from '@/store/AuthContext'

const SMALL_BTN = 'btn-secondary h-8 min-h-0 gap-1.5 px-2.5 py-0 text-xs touch:h-11 touch:px-3'

export function AutomationDeliveryPage() {
  const { id = '' } = useParams()
  const { data, isLoading, isError, error, refetch } = useAutomationDelivery(id || null)
  const gone = error instanceof ApiError && error.status === 404

  return (
    <div className="ai-type mx-auto w-full max-w-5xl space-y-4">
      {isLoading ? (
        <Card className="flex items-center justify-center gap-2 p-10 text-sm text-muted">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading the report…
        </Card>
      ) : gone ? (
        <Notice tone="red">This report could not be found. Only the people it was sent to can open it.</Notice>
      ) : isError && !data ? (
        <Notice tone="red" action={<Button className="h-8 min-h-0 px-3 py-0 text-xs touch:h-11" onClick={() => void refetch()}>Try again</Button>}>
          The report could not be loaded.
        </Notice>
      ) : data ? (
        <Delivery d={data} />
      ) : null}
    </div>
  )
}

function Delivery({ d }: { d: AutomationDelivery }) {
  const { toast } = useApp()
  const { factoryTimeZone } = useAuth()
  const ai = useAi()
  // Its automation's page opens for its creator and the assistant's owner alone: a recipient who may create automations of their own is not shown a way to one that is not theirs.
  const ownAutomations = useOwnAutomationIds(ai.automations && !ai.owner)
  const canOpenAutomation = mayOpenAutomation(d.automationId, { owner: ai.owner, automations: ai.automations, own: ownAutomations })
  const parts = useMemo(() => d.sections.map((s, i) => sectionAsQuery(s, '', i)), [d.sections])
  // As print shows them: headline figures as figures, a tree as its rows in order, stepped in, without its key and
  // parent columns.
  const printParts = useMemo(
    () =>
      parts.map((part, i): PrintPart => {
        const s = d.sections[i]
        const display = sectionDisplay(s)
        const flat = display === 'tree' ? treeAsTable(s.columns, s.rows, s.tree!) : null
        if (flat) return { part: { ...part, columns: flat.columns, rows: flat.rows } }
        return { part, display: display === 'figures' ? 'figures' : 'table' }
      }),
    [parts, d.sections],
  )
  const failed = d.sections.filter((s) => !s.ok).length
  const days = periodText(d.period)
  const values = (d.inputs ?? []).map((i) => `${i.label}: ${i.value}`).join(' · ')
  const printer = usePrint()
  const print = () =>
    printer.print(
      <ReportPrint
        kind="Scheduled report"
        title={d.automationName}
        lines={[`Delivered ${factoryTimestamp(d.ranAt, factoryTimeZone)}`, values, days ? `Covers ${days}` : ''].filter(Boolean)}
        summary={d.summary}
        sections={printParts}
        style={d.style}
      />,
      // Its file is named with the days it covers (a daily report's files tell apart), else the day it went out.
      { title: d.automationName, day: d.period ? (d.period.from === d.period.to ? d.period.from : `${d.period.from} to ${d.period.to}`) : localDay(new Date(d.ranAt)), style: d.style },
    )

  // Drawn by the server in its style, from what was delivered; its saved report's forms filled the same way.
  const [making, setMaking] = useState<string | null>(null)
  const saveFile = async (key: string, name: string, load: () => Promise<Blob>, done: string) => {
    if (making) return
    setMaking(key)
    try {
      saveBlob(name, await load())
      toast(done, 'success')
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not make the file.', 'error')
    } finally {
      setMaking(null)
    }
  }
  const exportExcel = () => void saveFile('workbook', deliveryFilename(d), () => loadDeliveryWorkbook(d.id), 'Exported the report to Excel, in its style.')

  return (
    <>
      {printer.node}
      <header className="space-y-2">
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge tone="violet">Scheduled report</Badge>
          <span className="text-xs text-muted">
            Delivered{' '}
            <time dateTime={d.ranAt} data-tip={factoryTimestamp(d.ranAt, factoryTimeZone)}>
              {factoryMoment(d.ranAt, factoryTimeZone)}
            </time>
            {days && <> · covers {days}</>}
          </span>
        </div>
        <h1 dir="auto" className="break-words text-2xl font-extrabold tracking-tight">
          {d.automationName}
        </h1>
        {(d.report || values) && (
          <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-13 text-muted">
            {d.report &&
              (d.report.open ? (
                <Link to={`/ai/reports/${encodeURIComponent(d.report.id)}`} dir="auto" className="inline-flex items-center gap-1 font-semibold text-brand-700 hover:underline dark:text-brand-300" data-tip="Open it in My reports, to run it with other values">
                  <FileChartColumn className="h-3.5 w-3.5" /> {d.report.title}
                </Link>
              ) : (
                <span dir="auto" className="inline-flex items-center gap-1 font-semibold">
                  <FileChartColumn className="h-3.5 w-3.5" /> {d.report.title}
                </span>
              ))}
            {values && <span dir="auto">{values}</span>}
          </p>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <Button className="h-10 min-h-0 gap-1.5 px-3 py-0 text-13 touch:h-11" onClick={exportExcel} disabled={making !== null} data-tip="The whole report as it was delivered, in its style: a sheet on the report, then a sheet per section">
            {making === 'workbook' ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileSpreadsheet className="h-4 w-4" />} Export Excel
          </Button>
          {(d.forms ?? []).map((f) => (
            <Button
              key={f.id}
              className="h-10 min-h-0 gap-1.5 px-3 py-0 text-13 touch:h-11"
              onClick={() => void saveFile(f.id, deliveryFilename({ automationName: f.name, ranAt: d.ranAt }), () => loadFilledDeliveryForm(d.id, f.id), `Filled the form “${f.name}”.`)}
              disabled={making !== null}
              data-tip="The company's form, filled with what was delivered"
            >
              {making === f.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileSpreadsheet className="h-4 w-4" />} <span dir="auto">{f.name}</span>
            </Button>
          ))}
          <Button className="h-10 min-h-0 gap-1.5 px-3 py-0 text-13 touch:h-11" onClick={print} data-tip="Print the report as it was delivered, or save it as a PDF from the print window">
            <Printer className="h-4 w-4" /> Print
          </Button>
          {canOpenAutomation && (
            <Link to={`/automations/${encodeURIComponent(d.automationId)}`} className="inline-flex min-h-[40px] items-center gap-1 text-13 font-semibold text-brand-700 hover:underline dark:text-brand-300">
              Open the automation <ArrowRight className="h-3.5 w-3.5 rtl:rotate-180" />
            </Link>
          )}
        </div>
      </header>

      {d.summary ? (
        <Card className="space-y-2 p-4">
          <h2 className="flex items-center gap-2 text-[11px] font-bold uppercase tracking-wide text-muted">
            <Sparkles className="h-3.5 w-3.5" /> Summary by the assistant
          </h2>
          <div dir="auto" className="text-sm">
            {/* Sent to whole roles, people without the assistant among them: a web address in it stays words, never a link. */}
            <AiMarkdown text={d.summary} links="app" />
          </div>
        </Card>
      ) : (
        d.summaryNote && <Notice tone="neutral">{d.summaryNote}</Notice>
      )}

      {failed > 0 && <Notice tone="amber">{failed === d.sections.length ? (failed === 1 ? 'Its query failed.' : 'Every query failed.') : `${failed} of ${d.sections.length} queries failed.`} Each says why below.</Notice>}

      <div className="space-y-3">
        {parts.map((part, i) => (
          <DeliveredSection key={i} part={part} section={d.sections[i]} onExport={exportExcel} />
        ))}
      </div>
    </>
  )
}

/** One section as delivered: its rows in the assistant's table (a preview when long), the whole of them in Open table. */
const DeliveredSection = memo(function DeliveredSection({ part, section, onExport }: { part: AiQueryPart; section: AiReportSectionRun; onExport: () => void }) {
  const [table, setTable] = useState(false)
  const preview = useMemo(() => (part.rows.length > AI_PREVIEW_ROWS ? { ...part, rows: part.rows.slice(0, AI_PREVIEW_ROWS), truncated: true } : part), [part])
  // A saved report's section shows its rows as it was built to: headline figures, or a tree.
  const display = sectionDisplay(section)
  // The chart the section was given, drawn from every row it delivered; the switch shows it or the rows themselves.
  // A section of photos is shown as the photos, whatever else it was built as.
  const photos = useMemo(() => queryPhotos(part), [part])
  const chart = useMemo(() => (display === 'table' && !photos ? queryChart(part) : null), [part, display, photos])
  const [view, setView] = useState<FigureView>('chart')
  const meta = part.ok ? `${part.rowCount.toLocaleString('en-US')}${part.truncated ? '+' : ''} ${part.rowCount === 1 && !part.truncated ? 'row' : 'rows'}` : 'Failed'
  return (
    <section className={cn('overflow-hidden rounded-xl bg-white ring-1 dark:bg-slate-900', part.ok ? 'ring-slate-200 dark:ring-slate-800' : 'ring-rose-200 dark:ring-rose-500/30')}>
      <header className="flex items-start gap-2.5 px-3 py-2">
        <span className="mt-0.5 shrink-0">{part.ok ? <CheckCircle2 className="h-4 w-4 text-emerald-600 dark:text-emerald-400" /> : <OctagonX className="h-4 w-4 text-rose-600 dark:text-rose-400" />}</span>
        <div className="min-w-0 flex-1">
          <h2 dir="auto" className="line-clamp-2 text-13 font-semibold text-slate-800 dark:text-slate-100">
            {part.purpose}
          </h2>
          <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px] tabular-nums text-muted">
            <span>{meta}</span>
            {part.truncated && (
              <Badge tone="amber" tip="More rows matched than a delivered report keeps; these are the first of them">
                Truncated
              </Badge>
            )}
          </p>
        </div>
        {chart && part.ok && <ChartTableSwitch value={view} onChange={setView} className="mt-0.5" />}
      </header>
      <div className="space-y-2 border-t border-slate-100 px-3 pb-3 pt-2 dark:border-slate-800">
        {section.note && (
          <p dir="auto" className="text-[11px] leading-snug text-muted">
            {section.note}
          </p>
        )}
        {photos ? (
          <AiPhotoGallery photos={photos} />
        ) : display === 'figures' ? (
          <SectionFigures columns={part.columns} rows={part.rows} />
        ) : display === 'tree' ? (
          <SectionTree columns={part.columns} rows={part.rows} tree={section.tree!} truncated={part.truncated} />
        ) : chart && view === 'chart' ? (
          <AiChart model={chart} />
        ) : part.ok ? (
          <PreviewTable part={preview} />
        ) : (
          <p dir="auto" className="whitespace-pre-wrap break-words rounded-lg bg-rose-50 px-2.5 py-2 text-xs text-rose-700 dark:bg-rose-500/10 dark:text-rose-300">
            {part.error || 'The query failed.'}
          </p>
        )}
        {part.ok && (
          <div className="flex flex-wrap items-center gap-1.5">
            <button type="button" onClick={() => setTable(true)} className={SMALL_BTN} disabled={part.rows.length === 0}>
              <Table2 className="h-3.5 w-3.5" /> Open table{part.rows.length > preview.rows.length ? ` (all ${part.rows.length.toLocaleString('en-US')} rows)` : ''}
            </button>
            {chart && view === 'chart' && <ChartImageTool model={chart} title={chart.title ?? part.purpose} className="text-xs text-muted" />}
          </div>
        )}
      </div>
      {/* Its words on "more matched" are a query's: a delivered section is what it is, so the large table holds it as such. */}
      {table && part.ok && <AiResultModal part={{ ...part, truncated: false }} onClose={() => setTable(false)} onExport={onExport} exporting={false} exportLabel="Export report" exportTip="The whole report as it was delivered" />}
    </section>
  )
})
