// ============================================================================
// A report laid out for paper (printed by ./usePrint), to be handed to
// management: the company's letterhead (its logo, the department, what kind
// of report it is), the report's name and the lines that place it (the
// period, when its data was read), its headline figures, its text, and its
// sections, numbered — a chart drawn alone, rows as a ruled table whose
// header repeats on every page, photos at one size — and at the end who
// printed it and when. Every page's foot carries the company, the report's
// name and the page's number (usePrint). No buttons, no scrolling, no
// question as typed, no suggestions: what is on the paper is the report.
// ============================================================================

import '@/components/ai/fonts'
import { useMemo, type ReactNode } from 'react'
import { AI_PREVIEW_ROWS, type AiKpi, type AiQueryPart, type AiReportSectionDisplay } from '@qc/shared/ai'
import { AiChart } from '@/components/ai/AiChart'
import { PrintPhotos } from '@/components/ai/AiPhotoGallery'
import { SectionFigures } from '@/components/ai/AiReportLayouts'
import { queryChart } from '@/components/ai/chartData'
import { queryPhotos } from '@/components/ai/photos'
import { cellText } from '@/components/ai/tables'
import { cn } from '@/lib/utils'
import { useAuth } from '@/store/AuthContext'

/** Rows a section prints at most: past them, the paper says how many more there were. */
export const PRINT_MAX_ROWS = AI_PREVIEW_ROWS

const WHEN = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })

/** A moment as a report writes it: "13 Oct 2026, 08:30", on this device's clock. */
export function paperWhen(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : WHEN.format(d)
}

/** "Printed 13 Oct 2026, 08:30 by Mohamed Beda". */
export function printedLine(at: Date, by: string | null | undefined): string {
  const when = paperWhen(at.toISOString())
  return by ? `Printed ${when} by ${by}` : `Printed ${when}`
}

/** What a section's rows come to on paper: all of them, or the first PRINT_MAX_ROWS and how many more matched. */
export function printedRows(part: Pick<AiQueryPart, 'rows' | 'rowCount' | 'truncated'>): { rows: AiQueryPart['rows']; note: string | null } {
  const rows = part.rows.slice(0, PRINT_MAX_ROWS)
  const more = part.truncated || part.rowCount > rows.length
  if (!more) return { rows, note: null }
  const total = part.truncated ? `${part.rowCount.toLocaleString('en-US')}+` : part.rowCount.toLocaleString('en-US')
  return { rows, note: `The first ${rows.length.toLocaleString('en-US')} of ${total} rows. Excel holds them all.` }
}

/** The company's logo as the official one is drawn (client/public/brand/logo.svg): LINK in its blue, MISR in its red, the line beneath. */
export function PrintLogo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 640 200" role="img" aria-label="LinkMisr — Advanced Storage Solutions" className={className}>
      <text x="0" y="120" fontFamily="Inter, 'Segoe UI', Arial, sans-serif" fontWeight={800} fontSize={118} letterSpacing={-2}>
        <tspan fill="#1e46a8">LINK</tspan>
        <tspan fill="#e3202a">MISR</tspan>
      </text>
      <text x="2" y="172" fontFamily="Inter, 'Segoe UI', Arial, sans-serif" fontWeight={600} fontSize={26} letterSpacing={6} fill="#1e46a8">
        ADVANCED STORAGE SOLUTIONS
      </text>
    </svg>
  )
}

/**
 * The sheet. `kind`: what report it is ("AI assistant report", "Scheduled report"); `title`: its name; `lines`: what
 * places it (when, the period, the values it ran with), each a line of its own under the name.
 */
export function PrintSheet({ kind, title, lines, children }: { kind: string; title: string; lines: readonly string[]; children: ReactNode }) {
  const { profile } = useAuth()
  return (
    <article className="print-sheet ai-type text-[11.5px] leading-snug text-slate-900">
      <header className="print-keep mb-5">
        <div className="flex items-end justify-between gap-6 pb-2.5">
          <PrintLogo className="h-11 w-auto shrink-0" />
          <div className="text-end leading-tight">
            <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-[#1e46a8]">Quality Control Department</p>
            <p className="mt-0.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-500">{kind}</p>
          </div>
        </div>
        <div aria-hidden className="print-rule" />
        <h1 dir="auto" className="mt-4 text-start text-[22px] font-extrabold leading-tight tracking-tight text-slate-900">
          {title}
        </h1>
        {lines.length > 0 && (
          <div className="mt-1.5 space-y-0.5">
            {lines.map((line, i) => (
              <p key={i} dir="auto" className="text-start text-[10.5px] text-slate-600">
                {line}
              </p>
            ))}
          </div>
        )}
      </header>
      <div className="space-y-5">{children}</div>
      <footer className="mt-8 flex justify-between gap-4 border-t border-slate-300 pt-1.5 text-[8.5px] text-slate-500">
        <span>LinkMisr · Quality Control</span>
        <span>{printedLine(new Date(), profile?.name)}</span>
      </footer>
    </article>
  )
}

/** The headline figures, as a row of cards. */
export function PrintKpis({ kpis }: { kpis: readonly AiKpi[] }) {
  if (kpis.length === 0) return null
  return (
    <div className="print-keep grid grid-cols-[repeat(auto-fill,minmax(8.5rem,1fr))] gap-2">
      {kpis.map((k, i) => (
        <div key={i} className="print-kpi rounded-md border border-slate-200 px-3 py-2">
          <p dir="auto" className="text-[9.5px] font-semibold tracking-wide text-slate-500">
            {k.label}
          </p>
          <p dir="auto" className="mt-1 text-[17px] font-extrabold leading-none tabular-nums text-slate-900">
            {k.value}
          </p>
        </div>
      ))}
    </div>
  )
}

/** The columns that hold numbers only (nulls aside): their heading and figures line up at the end. */
export function numericColumns(columns: readonly string[], rows: AiQueryPart['rows']): boolean[] {
  return columns.map((_, i) => {
    let seen = false
    for (const row of rows) {
      const v = row[i] ?? null
      if (v === null) continue
      if (typeof v !== 'number') return false
      seen = true
    }
    return seen
  })
}

/** Rows as a ruled table across the page: its header repeats on every page; numbers line up at the end; every other row shaded. */
export function PrintTable({ columns, rows }: { columns: readonly string[]; rows: AiQueryPart['rows'] }) {
  const numeric = numericColumns(columns, rows)
  return (
    <table className="print-table w-full border-collapse text-[9.5px]">
      <thead>
        <tr>
          {columns.map((c, i) => (
            <th key={i} dir="auto" className={cn('px-2 py-1.5 font-bold', numeric[i] ? 'text-end' : 'text-start')}>
              {c}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row, r) => (
          <tr key={r}>
            {columns.map((_, i) => {
              const v = row[i] ?? null
              return (
                <td key={i} dir="auto" className={typeof v === 'number' ? 'px-2 py-1 text-end tabular-nums' : 'px-2 py-1 align-top'}>
                  {typeof v === 'boolean' ? (v ? 'Yes' : 'No') : cellText(v)}
                </td>
              )
            })}
          </tr>
        ))}
      </tbody>
    </table>
  )
}

/** A section as printed: its rows, and how they are shown (a table unless built otherwise). */
export interface PrintPart {
  part: AiQueryPart
  display?: AiReportSectionDisplay
}

/**
 * A section, numbered: its photos, its headline figures, its chart alone (the rows behind it are in Excel), or its
 * rows; or why it failed.
 */
export function PrintSection({ part, display = 'table', number }: PrintPart & { number?: number }) {
  const photos = useMemo(() => queryPhotos(part), [part])
  const chart = useMemo(() => (photos || display !== 'table' ? null : queryChart(part)), [part, photos, display])
  const { rows, note } = printedRows(part)
  return (
    <section className="space-y-2">
      <h2 dir="auto" className="print-keep-with-next print-section-title flex items-baseline gap-2 text-start text-[13px] font-bold text-slate-900">
        {number !== undefined && <span className="print-section-number">{number}</span>}
        <span className="min-w-0 flex-1">{part.purpose}</span>
      </h2>
      {!part.ok ? (
        <p dir="auto" className="text-[10.5px] text-rose-700">
          {part.error || 'The query failed.'}
        </p>
      ) : photos ? (
        <PrintPhotos photos={photos.slice(0, PRINT_MAX_ROWS)} />
      ) : display === 'figures' ? (
        <div className="print-keep">
          <SectionFigures columns={part.columns} rows={part.rows} />
        </div>
      ) : chart ? (
        <div className="print-keep">
          <AiChart model={chart} />
        </div>
      ) : (
        <>
          {rows.length > 0 ? <PrintTable columns={part.columns} rows={rows} /> : <p className="text-[10.5px] text-slate-600">No rows.</p>}
          {note && <p className="text-[9px] text-slate-500">{note}</p>}
        </>
      )}
    </section>
  )
}
