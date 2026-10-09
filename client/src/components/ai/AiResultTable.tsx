// ============================================================================
// §20 — a query's rows on screen. The card shows the preview as it came (the
// first AI_PREVIEW_ROWS rows, what the model read); "Open table" shows the
// same rows larger, with Excel's filter and sort on every column.
// ============================================================================

import { useMemo } from 'react'
import { FileSpreadsheet, Loader2, Table2 } from 'lucide-react'
import type { AiCell, AiQueryPart } from '@qc/shared/ai'
import { Button, Modal } from '@/components/ui'
import { useTableView, ViewNote, ViewTh, type ViewColumn } from '@/components/ui/ColumnFilter'
import { cn } from '@/lib/utils'

/** A cell as text: blank for NULL, JSON for a structured value (a json column arrives parsed). */
export function cellText(v: AiCell | unknown): string {
  if (v === null || v === undefined) return ''
  if (typeof v === 'string') return v
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  return JSON.stringify(v)
}

/** Per column: whether it holds numbers (its first value that is not NULL is one), so it aligns right and sorts by size. */
export function numericColumns(columns: string[], rows: AiCell[][]): boolean[] {
  return columns.map((_, c) => {
    for (const r of rows) {
      const v = r[c]
      if (v !== null && v !== undefined) return typeof v === 'number'
    }
    return false
  })
}

/** One cell: NULL shown as a faint dash, a long text cut with its whole in the tooltip. */
export function ResultCell({ value, numeric, wrap = false }: { value: AiCell; numeric: boolean; wrap?: boolean }) {
  if (value === null || value === undefined) {
    return (
      <td className={cn('px-2.5 text-muted', numeric && 'text-right')} aria-label="Empty">
        —
      </td>
    )
  }
  const text = cellText(value)
  const long = text.length > 60
  return (
    <td
      dir={numeric ? undefined : 'auto'}
      data-tip={long && !wrap ? text.slice(0, 600) : undefined}
      className={cn('px-2.5', numeric ? 'whitespace-nowrap text-right tabular-nums' : wrap ? 'min-w-[8rem] max-w-[28rem] whitespace-pre-wrap break-words' : 'max-w-[16rem] truncate whitespace-nowrap')}
    >
      {text}
    </td>
  )
}

/** The preview inside a query's card: plain, compact, its header fixed while it scrolls. */
export function PreviewTable({ part }: { part: AiQueryPart }) {
  const numeric = useMemo(() => numericColumns(part.columns, part.rows), [part.columns, part.rows])
  if (part.rows.length === 0) return <p className="rounded-xl bg-slate-50 px-3 py-2 text-13 text-muted dark:bg-slate-800/60">No rows matched.</p>
  return (
    <div className="max-h-72 overflow-auto overscroll-contain rounded-xl ring-1 ring-slate-200 dark:ring-slate-800">
      <table className="w-full text-xs">
        <thead>
          <tr>
            {part.columns.map((name, c) => (
              <th key={c} className={cn('sticky top-0 z-10 whitespace-nowrap bg-slate-50 px-2.5 py-1.5 text-[11px] font-bold uppercase tracking-wide text-muted dark:bg-slate-800', numeric[c] ? 'text-right' : 'text-left')}>
                {name}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
          {part.rows.map((row, i) => (
            <tr key={i} className="h-7 hover:bg-slate-50/70 dark:hover:bg-slate-800/40">
              {part.columns.map((_, c) => (
                <ResultCell key={c} value={row[c] ?? null} numeric={numeric[c]} />
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

interface Row {
  i: number
  cells: AiCell[]
}

/** "Open table": the preview, large, with Excel's filter and sort. */
export function AiResultModal({ part, onClose, onExport, exporting }: { part: AiQueryPart; onClose: () => void; onExport: () => void; exporting: boolean }) {
  const numeric = useMemo(() => numericColumns(part.columns, part.rows), [part.columns, part.rows])
  const rows = useMemo<Row[]>(() => part.rows.map((cells, i) => ({ i, cells })), [part.rows])
  // useTableView keys its columns by identity: built once per result.
  const columns = useMemo<ViewColumn<Row>[]>(
    () =>
      part.columns.map((_, c) => ({
        key: `c${c}`,
        value: (r: Row) => cellText(r.cells[c]),
        sortValue: numeric[c] ? (r: Row) => (typeof r.cells[c] === 'number' ? (r.cells[c] as number) : null) : undefined,
        numeric: numeric[c],
        // A column of long free text gets sort and Contains, not a list of every value.
        noValues: part.rows.some((r) => cellText(r[c]).length > 120),
      })),
    [part.columns, part.rows, numeric],
  )
  const view = useTableView(rows, columns)

  return (
    <Modal
      open
      onClose={onClose}
      size="xl"
      icon={<Table2 className="h-5 w-5" />}
      title={<span dir="auto">{part.purpose}</span>}
      footer={
        <>
          <Button onClick={onExport} disabled={exporting} className="sm:mr-auto">
            {exporting ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileSpreadsheet className="h-4 w-4" />} {exporting ? 'Exporting…' : 'Export Excel'}
          </Button>
          <Button variant="primary" onClick={onClose}>
            Close
          </Button>
        </>
      }
    >
      <p className="mb-2 text-xs text-muted">
        {part.rows.length.toLocaleString()} {part.rows.length === 1 ? 'row' : 'rows'}
        {part.truncated ? ' — more matched. Export Excel runs the query again for all of them.' : '.'}
      </p>
      <ViewNote view={view} total={rows.length} />
      {rows.length === 0 ? (
        <p className="rounded-xl bg-slate-50 px-3 py-6 text-center text-sm text-muted dark:bg-slate-800/60">No rows matched.</p>
      ) : (
        <div className="max-h-[55vh] overflow-auto overscroll-contain rounded-xl ring-1 ring-slate-200 dark:ring-slate-800">
          <table className="w-full text-[13px]">
            <thead className="text-left text-xs uppercase tracking-wide text-muted">
              <tr>
                {part.columns.map((name, c) => (
                  <ViewTh key={c} view={view} column={`c${c}`} label={name} className={cn('sticky top-0 z-10 bg-slate-50 px-2.5 py-2 font-bold dark:bg-slate-800', numeric[c] && 'text-right')} />
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {view.rows.map((r) => (
                <tr key={r.i} className="data-row hover:bg-slate-50/70 dark:hover:bg-slate-800/40">
                  {part.columns.map((_, c) => (
                    <ResultCell key={c} value={r.cells[c] ?? null} numeric={numeric[c]} wrap />
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          {view.rows.length === 0 && <p className="px-3 py-6 text-center text-sm text-muted">No row passes the filters.</p>}
        </div>
      )}
    </Modal>
  )
}
