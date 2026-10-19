// ============================================================================
// §21 — the pieces an automation is drawn with, wherever it shows: the card
// in the assistant's answer, the Automations page, an automation's own page.
// Its kind and state as badges; who it tells as chips (one no longer valid
// marked, not hidden); what it does as a short list of facts; the cases a
// run found as the assistant's own tables; what a notification will say.
// Words written by people or the model keep their own direction (dir=auto).
// ============================================================================

import { useMemo, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { AlertTriangle, Bell, CalendarRange, CheckCircle2, ChevronDown, Clock, FileChartColumn, ListChecks, OctagonX, Sparkles, Table2, Users } from 'lucide-react'
import { AI_PREVIEW_ROWS, describeAiDays, describeAiPeriod, type AiCell, type AiDayRange, type AiQueryPart, type AiReportSectionRun } from '@qc/shared/ai'
import type { Automation, AutomationAssigneeView, AutomationKind, AutomationLinkedReport, AutomationRecipientView } from '@qc/shared/automation'
import { Badge } from '@/components/ui'
import { ApiError } from '@/lib/api'
import { cn } from '@/lib/utils'
import { downloadWorkbook, sheetName } from '@/lib/xlsxWrite'
import { useApp } from '@/store/AppContext'
import { AiChart } from '@/components/ai/AiChart'
import { AiResultModal, PreviewTable } from '@/components/ai/AiResultTable'
import { queryChart, type ChartModel } from '@/components/ai/chartData'
import { AiPhotoGallery } from '@/components/ai/AiPhotoGallery'
import { queryPhotos } from '@/components/ai/photos'
import { sectionAsQuery } from '@/components/ai/reports'
import { SectionFigures, SectionTree, sectionDisplay } from '@/components/ai/AiReportLayouts'
import { IconTool, TableTool, aiTableFilename } from '@/components/ai/AiTable'
import { aiCellValue } from '@/components/ai/exportAiResult'
import {
  KIND_LABEL,
  KIND_TIP,
  KIND_TONE,
  NEEDS_REVIEW_TEXT,
  assigneePhrase,
  automationStatus,
  channelsText,
  followUpText,
  linkedValuesLines,
  needsReview,
  periodPhrase,
  whenText,
  type EditableDefinition,
} from './wording'

// ---- Badges and chips ----------------------------------------------------------------------

export function KindBadge({ kind }: { kind: AutomationKind }) {
  return (
    <Badge tone={KIND_TONE[kind]} tip={KIND_TIP[kind]}>
      {KIND_LABEL[kind]}
    </Badge>
  )
}

export function StatusBadge({ automation }: { automation: Pick<Automation, 'status' | 'blockedReason' | 'statusNote'> }) {
  const s = automationStatus(automation)
  return (
    <Badge tone={s.tone} tip={s.tip} icon={s.key === 'blocked' || s.key === 'failed' ? <AlertTriangle className="h-3 w-3" /> : undefined}>
      {s.label}
    </Badge>
  )
}

/** Who it tells: a chip each; one no longer valid (an account switched off, a column the result lost) marked, with why. */
export function RecipientChips({ recipients, empty = 'Nobody' }: { recipients: readonly AutomationRecipientView[]; empty?: string }) {
  if (recipients.length === 0) return <span className="text-muted">{empty}</span>
  return (
    <span className="flex flex-wrap gap-1">
      {recipients.map((r, i) => (
        <span
          key={`${r.kind}:${r.kind === 'user' ? r.userId : r.kind === 'role' ? r.role : r.column}:${i}`}
          dir="auto"
          data-tip={r.invalid ? (r.kind === 'column' ? 'The query no longer returns this column' : 'This account is no longer active: it is skipped') : undefined}
          className={cn(
            'inline-flex max-w-full items-center gap-1 rounded-md px-1.5 py-0.5 text-xs font-semibold ring-1 ring-inset',
            r.invalid
              ? 'bg-rose-50 text-rose-700 line-through decoration-rose-400 ring-rose-200 dark:bg-rose-500/10 dark:text-rose-300 dark:ring-rose-500/25'
              : r.kind === 'user'
                ? 'bg-white text-slate-700 ring-slate-200 dark:bg-slate-800 dark:text-slate-200 dark:ring-slate-700'
                : 'bg-slate-100 text-slate-700 ring-slate-200 dark:bg-slate-800/70 dark:text-slate-300 dark:ring-slate-700',
          )}
        >
          <span className="truncate">{r.label}</span>
          {r.invalid && <span className="sr-only"> (no longer valid)</span>}
        </span>
      ))}
    </span>
  )
}

// ---- What it does ----------------------------------------------------------------------------

/** One fact of a definition: an icon and a word, and what it says. */
function Fact({ icon, label, children }: { icon: ReactNode; label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[6.25rem_minmax(0,1fr)] items-start gap-x-2 py-1 sm:grid-cols-[7.25rem_minmax(0,1fr)]">
      <dt className="flex items-center gap-2 pt-px text-xs font-semibold uppercase tracking-wide text-muted">
        <span aria-hidden className="shrink-0">
          {icon}
        </span>
        {label}
      </dt>
      <dd className="min-w-0 text-13 text-slate-700 dark:text-slate-200">{children}</dd>
    </div>
  )
}

/**
 * When it runs, whom it tells and where, and what it does with each case —
 * the same facts on the card and on the page.
 */
export function DefinitionFacts({
  def,
  recipients,
  assignee,
  linkedReport,
}: {
  def: EditableDefinition
  recipients: readonly AutomationRecipientView[]
  assignee?: AutomationAssigneeView
  /** A report sending a saved report: which, as the server read it (its values are the definition's). */
  linkedReport?: AutomationLinkedReport
}) {
  const s = def.schedule
  const f = def.actions.followUp
  const told = def.kind === 'report' || def.actions.notify
  return (
    <dl className="divide-y divide-slate-100 dark:divide-slate-800">
      <Fact icon={<Clock className="h-4 w-4" />} label="When">
        {whenText(def)}
        <span className="text-muted">{def.kind === 'watch' ? ' · each new case once' : ' · factory time'}</span>
      </Fact>
      {s?.report && (
        <Fact icon={<FileChartColumn className="h-4 w-4" />} label="Sends">
          {linkedReport && !linkedReport.missing ? (
            <Link to={`/ai/reports/${encodeURIComponent(linkedReport.id)}`} dir="auto" className="font-semibold text-brand-700 hover:underline dark:text-brand-300">
              {linkedReport.title}
            </Link>
          ) : (
            <span className="font-semibold text-rose-700 dark:text-rose-300">{linkedReport ? `${linkedReport.title}: deleted, or no longer shared` : 'A saved report'}</span>
          )}
          <span className="text-muted"> · as it stands each time it runs</span>
          {linkedReport && linkedReport.inputs.length > 0 && (
            <ul className="mt-0.5 space-y-0.5 text-xs text-muted">
              {linkedValuesLines(linkedReport.inputs, s.report.inputs ?? {}).map((line) => (
                <li key={line} dir="auto">
                  {line}
                </li>
              ))}
            </ul>
          )}
        </Fact>
      )}
      {s && (
        <Fact icon={<CalendarRange className="h-4 w-4" />} label="Covers">
          {s.period ? describeAiPeriod(s.period) : <span className="text-muted">{s.report ? 'The days the report covers' : 'Its queries take no period'}</span>}
          {s.summary && (
            <span className="mt-0.5 flex items-center gap-1 text-xs text-muted">
              <Sparkles className="h-3.5 w-3.5" /> With a short summary by the assistant on top
            </span>
          )}
        </Fact>
      )}
      <Fact icon={<Users className="h-4 w-4" />} label="Tells">
        {told ? <RecipientChips recipients={recipients} /> : <span className="text-muted">Nobody — it opens follow-ups only</span>}
      </Fact>
      <Fact icon={<Bell className="h-4 w-4" />} label="On">
        {channelsText(def.channels)}
      </Fact>
      {def.kind === 'watch' && (
        <Fact icon={<ListChecks className="h-4 w-4" />} label="Does">
          <ul className="space-y-0.5">
            {def.actions.notify && <li>Tells them about each new case</li>}
            {f && (
              <li>
                {followUpText(f.dueHours, assignee ? assigneePhrase(assignee) : 'its assignee')}
                {assignee?.invalid && <span className="ms-1 text-xs font-semibold text-rose-700 dark:text-rose-300">(no longer valid)</span>}
              </li>
            )}
            {needsReview(def.watch, def.actions) && <li className="text-muted">{NEEDS_REVIEW_TEXT}</li>}
          </ul>
        </Fact>
      )}
    </dl>
  )
}

// ---- What a run found --------------------------------------------------------------------------

/** The shape of a UUID, as the record's ids are written. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * The columns in the order a person reads them: the ids last. A watch's
 * query often starts with the ids it matches cases by (SAMPLE_ID,
 * SESSION_ID — 36 characters each), and on a phone those alone fill the
 * frame, with what the case is about scrolled out of sight. A column is an
 * id by its name (`id`, `*_id`) or by holding nothing but UUIDs; the rest
 * keep their order, and so do the ids among themselves.
 */
export function idColumnsLast(columns: readonly string[], rows: readonly (readonly AiCell[])[]): number[] {
  const isId = (name: string, c: number) => {
    if (/(^|_)id$/i.test(name.trim())) return true
    let uuids = 0
    for (const r of rows) {
      const v = r[c]
      if (v === null || v === undefined || v === '') continue
      if (typeof v !== 'string' || !UUID.test(v.trim())) return false
      uuids++
    }
    return uuids > 0
  }
  const first: number[] = []
  const last: number[] = []
  columns.forEach((name, c) => (isId(name, c) ? last : first).push(c))
  return [...first, ...last]
}

/** A run's rows in the shape the assistant's tables take. */
export function rowsAsQuery(id: string, title: string, columns: string[], rows: AiCell[][], more = false): AiQueryPart {
  return { type: 'query', queryId: id, purpose: title, sql: '', ok: true, columns, rows, rowCount: rows.length, truncated: more, ms: 0 }
}

/**
 * Some of a run's rows, in the assistant's table, opening large with Excel's
 * filters; Export Excel saves the rows on screen (a run's rows are not run
 * again for it). The id columns come last, on screen and in the workbook
 * alike, so the two read the same. With a chart, the chart is shown instead,
 * and Open table (an icon under it) opens the same rows large.
 */
export function CasesTable({ title, columns: given, rows: givenRows, more = false, chart }: { title: string; columns: string[]; rows: AiCell[][]; more?: boolean; chart?: ChartModel | null }) {
  const { toast } = useApp()
  const [open, setOpen] = useState(false)
  const { columns, rows } = useMemo(() => {
    const order = idColumnsLast(given, givenRows)
    return { columns: order.map((c) => given[c]), rows: givenRows.map((r) => order.map((c) => r[c] ?? null)) }
  }, [given, givenRows])
  const part = useMemo(() => rowsAsQuery('cases', title, columns, rows, more), [title, columns, rows, more])
  const exportRows = () => {
    downloadWorkbook(aiTableFilename(), [{ name: sheetName(title || 'Rows', new Set()), header: columns, rows: rows.map((r) => r.map(aiCellValue)) }])
    toast(`Exported ${rows.length.toLocaleString('en-US')} ${rows.length === 1 ? 'row' : 'rows'}${more ? ' — the ones shown here' : ''}.`, 'success')
  }
  return (
    <>
      {chart ? (
        <div>
          <AiChart model={chart} />
          <div className="mt-1.5 flex justify-end">
            <IconTool onClick={() => setOpen(true)} disabled={rows.length === 0} label="Open table" tip="The chart's rows, in a large table" icon={<Table2 className="h-3.5 w-3.5" />} />
          </div>
        </div>
      ) : (
        <PreviewTable
          part={part}
          tools={
            <TableTool onClick={() => setOpen(true)} disabled={rows.length === 0} icon={<Table2 className="h-3.5 w-3.5" />}>
              Open table
            </TableTool>
          }
        />
      )}
      {/* The large table holds the same rows; its words on "more matched" are a query's, which these rows are not. */}
      {open && <AiResultModal part={{ ...part, truncated: false }} onClose={() => setOpen(false)} onExport={exportRows} exporting={false} exportTip="Saves the rows shown here as a workbook" />}
    </>
  )
}

/** What a notification of a case will say: its title and body, filled in from a case. */
export function NotificationPreview({ title, body, label = 'What a notification will say' }: { title?: string; body?: string; label?: string }) {
  if (!title && !body) return null
  return (
    <figure className="space-y-1">
      <figcaption className="text-[11px] font-bold uppercase tracking-wide text-muted">{label}</figcaption>
      <div className="flex items-start gap-2.5 rounded-xl bg-white p-2.5 shadow-sm ring-1 ring-slate-200 dark:bg-slate-900 dark:ring-slate-700">
        <span aria-hidden className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-brand-50 text-brand-700 dark:bg-brand-500/15 dark:text-brand-200">
          <Bell className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          {title && (
            <p dir="auto" className="break-words text-13 font-semibold text-slate-800 dark:text-slate-100">
              {title}
            </p>
          )}
          {body && (
            <p dir="auto" className="mt-0.5 whitespace-pre-wrap break-words text-xs text-slate-600 dark:text-slate-300">
              {body}
            </p>
          )}
        </div>
      </div>
    </figure>
  )
}

/** The days a report's run covered, as a sentence names them: "yesterday (9 Oct 2026)" (wording: periodPhrase). */
export function periodText(p: (AiDayRange & { label: string }) | null | undefined): string | null {
  if (!p) return null
  return periodPhrase(p.label, describeAiDays(p))
}

/**
 * A report's sections as a run left them: each its title, whether it worked
 * and its rows, folded until opened (the first one open) — the preview on a
 * card and a test, not the delivered report (its own page shows that).
 */
export function SectionsPreview({ sections }: { sections: readonly AiReportSectionRun[] }) {
  return (
    <div className="space-y-1.5">
      {sections.map((s, i) => (
        <SectionPreview key={i} section={s} index={i} initiallyOpen={i === 0} />
      ))}
    </div>
  )
}

function SectionPreview({ section, index, initiallyOpen }: { section: AiReportSectionRun; index: number; initiallyOpen: boolean }) {
  const [open, setOpen] = useState(initiallyOpen)
  const meta = section.ok ? `${section.rowCount.toLocaleString('en-US')}${section.truncated ? '+' : ''} ${section.rowCount === 1 && !section.truncated ? 'row' : 'rows'}` : 'Failed'
  const shown = section.rows.slice(0, AI_PREVIEW_ROWS)
  // The chart the delivered report will draw, as this run would draw it; Open table under it shows the rows themselves.
  const display = sectionDisplay(section)
  // A section of photos is shown as the photos, whatever else it was built as.
  const photos = useMemo(() => queryPhotos(section), [section])
  const chart = useMemo(() => (section.ok && display === 'table' && !photos ? queryChart(sectionAsQuery(section, '', index)) : null), [section, index, display, photos])
  return (
    <section className={cn('overflow-hidden rounded-xl bg-white ring-1 dark:bg-slate-900', section.ok ? 'ring-slate-200 dark:ring-slate-800' : 'ring-rose-200 dark:ring-rose-500/30')}>
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="flex w-full items-center gap-2 px-3 py-2 text-start hover:bg-slate-50 dark:hover:bg-slate-800/60 touch:min-h-[44px]">
        {section.ok ? <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400" /> : <OctagonX className="h-4 w-4 shrink-0 text-rose-600 dark:text-rose-400" />}
        <span dir="auto" className="min-w-0 flex-1 truncate text-13 font-semibold text-slate-800 dark:text-slate-100">
          {section.title || `Section ${index + 1}`}
        </span>
        <span className="shrink-0 text-[11px] tabular-nums text-muted">{meta}</span>
        <ChevronDown className={cn('h-4 w-4 shrink-0 text-muted transition-transform duration-200', open && 'rotate-180')} />
      </button>
      {open && (
        <div className="space-y-2 border-t border-slate-100 px-3 pb-3 pt-2 dark:border-slate-800">
          {section.note && (
            <p dir="auto" className="text-[11px] leading-snug text-muted">
              {section.note}
            </p>
          )}
          {photos ? (
            <AiPhotoGallery photos={photos.slice(0, AI_PREVIEW_ROWS)} />
          ) : display === 'figures' ? (
            <SectionFigures columns={section.columns} rows={section.rows} />
          ) : display === 'tree' && section.tree ? (
            <SectionTree columns={section.columns} rows={shown} tree={section.tree} truncated={section.truncated || section.rows.length > shown.length} />
          ) : section.ok ? (
            <CasesTable title={section.title} columns={section.columns} rows={shown} more={section.truncated || section.rows.length > shown.length} chart={chart} />
          ) : (
            <p dir="auto" className="whitespace-pre-wrap break-words rounded-lg bg-rose-50 px-2.5 py-2 text-xs text-rose-700 dark:bg-rose-500/10 dark:text-rose-300">
              {section.error || 'The query failed.'}
            </p>
          )}
        </div>
      )}
    </section>
  )
}

// ---- Errors --------------------------------------------------------------------------------------

/**
 * What a refusal says, a line each: the server's message, then every other
 * problem it listed (a draft that did not pass names them all).
 */
export function errorLines(e: unknown, fallback: string): string[] {
  if (!(e instanceof Error)) return [fallback]
  const lines = [e.message || fallback]
  if (e instanceof ApiError && Array.isArray(e.details)) {
    for (const d of e.details) {
      const message = d && typeof d === 'object' && 'message' in d ? String((d as { message: unknown }).message) : null
      if (message && !lines.includes(message)) lines.push(message)
    }
  }
  return lines
}

/** A refusal's lines, under the buttons that met it. */
export function ErrorList({ lines }: { lines: readonly string[] | null }) {
  if (!lines || lines.length === 0) return null
  const [first, ...rest] = lines
  return (
    <div role="alert" className="rounded-xl bg-rose-50 px-3 py-2 text-13 text-rose-700 ring-1 ring-inset ring-rose-200 dark:bg-rose-500/10 dark:text-rose-300 dark:ring-rose-500/25">
      <p dir="auto" className="font-semibold">
        {first}
      </p>
      {rest.length > 0 && (
        <ul className="mt-1 list-disc space-y-0.5 ps-5 text-xs">
          {rest.map((l) => (
            <li key={l} dir="auto">
              {l}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
