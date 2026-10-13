// ============================================================================
// A report laid out for paper (printed by ./usePrint): a header that says
// what it is, its title and the lines that place it (the period, when its
// data was read), its headline figures, its text, and its sections — each
// with its chart and its rows as a plain table whose header repeats on every
// page — and at the foot who printed it and when. No buttons, no scrolling:
// what is on the paper is all there is.
// ============================================================================

import '@/components/ai/fonts'
import { useMemo, type ReactNode } from 'react'
import { AI_PREVIEW_ROWS, type AiKpi, type AiQueryPart } from '@qc/shared/ai'
import { AiChart } from '@/components/ai/AiChart'
import { queryChart } from '@/components/ai/chartData'
import { cellText } from '@/components/ai/tables'
import { cn, formatFullTimestamp } from '@/lib/utils'
import { useAuth } from '@/store/AuthContext'

/** Rows a section prints at most: past them, the paper says how many more there were. */
export const PRINT_MAX_ROWS = AI_PREVIEW_ROWS

/** "Printed 13 Oct 2026, 08:30 by Mohamed Beda". */
export function printedLine(at: Date, by: string | null | undefined): string {
  const when = formatFullTimestamp(at.toISOString())
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

export function PrintSheet({ kind, title, lines, children }: { kind: string; title: string; lines: readonly string[]; children: ReactNode }) {
  const { profile } = useAuth()
  return (
    <article className="print-sheet ai-type text-[12px] leading-snug text-slate-900">
      <header className="mb-4 border-b-2 border-slate-800 pb-2">
        <p className="text-[10px] font-bold uppercase tracking-widest text-slate-500">LinkMisr · Quality Control · {kind}</p>
        <h1 dir="auto" className="mt-1 text-xl font-extrabold">
          {title}
        </h1>
        {lines.map((line, i) => (
          <p key={i} dir="auto" className="mt-0.5 text-[11px] text-slate-600">
            {line}
          </p>
        ))}
      </header>
      <div className="space-y-4">{children}</div>
      <footer className="mt-6 border-t border-slate-300 pt-1 text-[9px] text-slate-500">{printedLine(new Date(), profile?.name)}</footer>
    </article>
  )
}

/** The headline figures, as a row of boxes. */
export function PrintKpis({ kpis }: { kpis: readonly AiKpi[] }) {
  if (kpis.length === 0) return null
  return (
    <div className="print-keep flex flex-wrap gap-2">
      {kpis.map((k, i) => (
        <div key={i} className="min-w-[8rem] rounded border border-slate-300 px-2.5 py-1.5">
          <p dir="auto" className="text-[10px] text-slate-600">
            {k.label}
          </p>
          <p dir="auto" className="text-base font-bold tabular-nums">
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

/** Rows as a plain table, as wide as its contents: its header repeats on every page; numbers line up at the end. */
export function PrintTable({ columns, rows }: { columns: readonly string[]; rows: AiQueryPart['rows'] }) {
  const numeric = numericColumns(columns, rows)
  return (
    <table className="print-table w-auto max-w-full border-collapse text-[10px]">
      <thead>
        <tr>
          {columns.map((c, i) => (
            <th key={i} dir="auto" className={cn('border-b border-slate-500 px-2 py-1 font-semibold', numeric[i] ? 'text-end' : 'text-start')}>
              {c}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row, r) => (
          <tr key={r} className="border-b border-slate-200">
            {columns.map((_, i) => {
              const v = row[i] ?? null
              return (
                <td key={i} dir="auto" className={typeof v === 'number' ? 'px-2 py-0.5 text-end tabular-nums' : 'px-2 py-0.5 align-top'}>
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

/** A section: its title, its chart when it has one, and its rows; or why it failed. */
export function PrintSection({ part }: { part: AiQueryPart }) {
  const chart = useMemo(() => queryChart(part), [part])
  const { rows, note } = printedRows(part)
  return (
    <section className="space-y-1.5">
      <h2 dir="auto" className="print-keep-with-next text-[13px] font-bold">
        {part.purpose}
      </h2>
      {!part.ok ? (
        <p dir="auto" className="text-[11px] text-rose-700">
          {part.error || 'The query failed.'}
        </p>
      ) : (
        <>
          {chart && (
            <div className="print-keep">
              <AiChart model={chart} />
            </div>
          )}
          {rows.length > 0 ? <PrintTable columns={part.columns} rows={rows} /> : <p className="text-[11px] text-slate-600">No rows.</p>}
          {note && <p className="text-[10px] text-slate-500">{note}</p>}
        </>
      )}
    </section>
  )
}
