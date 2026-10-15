// ============================================================================
// §20 — a query's rows on screen. The card (and a chart's figure) shows the
// preview as it came — the first AI_PREVIEW_ROWS rows, what the model read —
// in the answer's table style (./AiTable); "Open table" shows the same rows
// larger, with Excel's filter and sort on every column.
// ============================================================================

import { useMemo, type ReactNode } from 'react'
import { FileSpreadsheet, Loader2, Table2 } from 'lucide-react'
import type { AiCell, AiQueryPart } from '@qc/shared/ai'
import { Button, Modal } from '@/components/ui'
import { useTableView, ViewNote, ViewTh, type ViewColumn } from '@/components/ui/ColumnFilter'
import { cn } from '@/lib/utils'
import { CopyTableTool, ResultCell, RowCount, TABLE_CLASS, TBODY_CLASS, TR_CLASS, TableFrame, thClass } from './AiTable'
import { cellNumber, cellText, numericColumns, queryTextRows, tableDirection, tableTsv } from './tables'

/** Which way a query's table reads: by its column names, else its first words. */
export function queryDirection(part: Pick<AiQueryPart, 'columns' | 'rows'>): 'rtl' | 'ltr' {
  return tableDirection(part.columns, queryTextRows(part.rows.slice(0, 20), part.columns.length))
}

/**
 * The rows the model read, as the answer shows them: compact and striped, the
 * header fixed while they scroll, and under them how many there are, Copy
 * table and whatever else the caller offers (`tools`: Open table, Export
 * Excel).
 */
/** `wrap`: long text over several lines instead of cut (a saved report, read rather than scanned). */
export function PreviewTable({ part, tools, wrap = false }: { part: AiQueryPart; tools?: ReactNode; wrap?: boolean }) {
  const numeric = useMemo(() => numericColumns(part.columns, part.rows), [part.columns, part.rows])
  const dir = useMemo(() => queryDirection(part), [part])
  if (part.rows.length === 0) return <p className="rounded-xl bg-slate-50 px-3 py-2 text-13 text-muted dark:bg-slate-800/60">No rows matched.</p>
  return (
    <TableFrame
      dir={dir}
      footer={
        <>
          <RowCount count={part.rows.length} more={part.truncated} />
          <CopyTableTool tsv={() => tableTsv(part.columns, queryTextRows(part.rows, part.columns.length))} />
          {tools}
        </>
      }
    >
      <table dir={dir} className={cn(TABLE_CLASS, 'text-xs')}>
        <thead>
          <tr>
            {part.columns.map((name, c) => (
              <th key={c} scope="col" dir="auto" className={thClass(dir, numeric[c])}>
                {name}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className={TBODY_CLASS}>
          {part.rows.map((row, i) => (
            <tr key={i} className={TR_CLASS}>
              {part.columns.map((_, c) => (
                <ResultCell key={c} value={row[c] ?? null} numeric={numeric[c]} dir={dir} wrap={wrap} />
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </TableFrame>
  )
}

interface Row {
  i: number
  cells: AiCell[]
}

/**
 * "Open table": the preview, large, with Excel's filter and sort. `exportWait`: why Export Excel cannot run yet.
 * `exportLabel`/`exportTip`: what the export button takes, when it is more than this query (a whole report).
 */
export function AiResultModal({
  part,
  onClose,
  onExport,
  exporting,
  exportWait,
  exportLabel = 'Export Excel',
  exportTip,
}: {
  part: AiQueryPart
  onClose: () => void
  /** Export Excel; left out for someone not allowed Excel. */
  onExport?: () => void
  exporting: boolean
  exportWait?: string
  exportLabel?: string
  exportTip?: string
}) {
  const numeric = useMemo(() => numericColumns(part.columns, part.rows), [part.columns, part.rows])
  const dir = useMemo(() => queryDirection(part), [part])
  const rows = useMemo<Row[]>(() => part.rows.map((cells, i) => ({ i, cells })), [part.rows])
  // useTableView keys its columns by identity: built once per result.
  const columns = useMemo<ViewColumn<Row>[]>(
    () =>
      part.columns.map((_, c) => ({
        key: `c${c}`,
        value: (r: Row) => cellText(r.cells[c]),
        sortValue: numeric[c] ? (r: Row) => cellNumber(r.cells[c]) : undefined,
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
      title={
        <span dir="auto" className="ai-type">
          {part.purpose}
        </span>
      }
      footer={
        <>
          {onExport && (
            <Button onClick={onExport} disabled={exporting || !!exportWait} data-tip={exportWait ?? exportTip} className="sm:mr-auto">
              {exporting ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileSpreadsheet className="h-4 w-4" />} {exporting ? 'Exporting…' : exportLabel}
            </Button>
          )}
          <Button variant="primary" onClick={onClose}>
            Close
          </Button>
        </>
      }
    >
      {/* Drawn over the page, outside the assistant's own frame: its typeface (Arabic too) comes along. */}
      <div className="ai-type">
        <p className="mb-2 text-xs text-muted">
          {part.rows.length.toLocaleString()} {part.rows.length === 1 ? 'row' : 'rows'}
          {part.truncated ? ` — more matched. ${exportLabel} runs the query again for all of them.` : '.'}
        </p>
        <ViewNote view={view} total={rows.length} />
        {rows.length === 0 ? (
          <p className="rounded-xl bg-slate-50 px-3 py-6 text-center text-sm text-muted dark:bg-slate-800/60">No rows matched.</p>
        ) : (
          // The scroller reads as its table does: a wide table of Arabic opens at its first column, on the right.
          <div dir={dir} className="max-h-[55vh] overflow-auto overscroll-contain rounded-xl ring-1 ring-slate-200 dark:ring-slate-800">
            <table dir={dir} className={TABLE_CLASS}>
              <thead>
                <tr>
                  {part.columns.map((name, c) => (
                    <ViewTh key={c} view={view} column={`c${c}`} label={name} className={cn(thClass(dir, numeric[c]), 'py-2')} />
                  ))}
                </tr>
              </thead>
              <tbody className={TBODY_CLASS}>
                {view.rows.map((r) => (
                  <tr key={r.i} className={cn('data-row', TR_CLASS)}>
                    {part.columns.map((_, c) => (
                      <ResultCell key={c} value={r.cells[c] ?? null} numeric={numeric[c]} dir={dir} wrap />
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
            {view.rows.length === 0 && <p className="px-3 py-6 text-center text-sm text-muted">No row passes the filters.</p>}
          </div>
        )}
      </div>
    </Modal>
  )
}
