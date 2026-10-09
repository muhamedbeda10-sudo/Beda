// ============================================================================
// §20 — a table in an answer, the model's markdown table or a query's rows:
// compact, striped, its header fixed while it scrolls inside its own frame
// (never the page), figures aligned to the end in left-to-right digits as
// they were written, and under it how many rows, Copy table (tab-separated,
// for pasting into Excel or a mail) and Export Excel. A table of Arabic reads
// right to left; each cell keeps its own words' direction.
// ============================================================================

import { useMemo, type ReactNode } from 'react'
import { ClipboardCopy, FileSpreadsheet, Loader2 } from 'lucide-react'
import type { AiCell } from '@qc/shared/ai'
import { downloadWorkbook } from '@/lib/xlsxWrite'
import { cn } from '@/lib/utils'
import { useApp } from '@/store/AppContext'
import { aiStamp } from './exportAiResult'
import { cellText, hastTableData, tableTsv, textTableSheet, type HastNode } from './tables'

export const TABLE_CLASS = 'w-full border-separate border-spacing-0 text-[13px] leading-snug'
const TH_CLASS = 'sticky top-0 z-10 whitespace-nowrap border-b border-slate-200 bg-slate-50 px-2.5 py-1.5 text-[11px] font-bold uppercase text-muted dark:border-slate-700 dark:bg-slate-800'
const TD_CLASS = 'border-b border-slate-100 px-2.5 py-1 align-top dark:border-slate-800'
export const TR_CLASS = 'even:bg-slate-50/80 hover:bg-brand-50/60 dark:even:bg-slate-800/40 dark:hover:bg-brand-500/10'
export const TBODY_CLASS = '[&>tr:last-child>td]:border-b-0'

/**
 * Where a cell's content sits: text at the start of the table's reading
 * direction, figures at its end — the same for every cell of a column,
 * whichever language each cell is in.
 */
export function cellAlign(tableDir: 'rtl' | 'ltr', numeric: boolean): string {
  return (tableDir === 'rtl') !== numeric ? 'text-right' : 'text-left'
}

/** The classes of a header cell and a body cell. */
export const thClass = (tableDir: 'rtl' | 'ltr', numeric: boolean) => cn(TH_CLASS, cellAlign(tableDir, numeric))
export const tdClass = (tableDir: 'rtl' | 'ltr', numeric: boolean, extra?: string) => cn(TD_CLASS, cellAlign(tableDir, numeric), numeric && 'whitespace-nowrap tabular-nums', extra)

/** The frame a table scrolls in, with its line of tools underneath. */
export function TableFrame({ children, footer, className }: { children: ReactNode; footer?: ReactNode; className?: string }) {
  return (
    <div className="overflow-hidden rounded-xl bg-white ring-1 ring-slate-200 dark:bg-slate-900 dark:ring-slate-800">
      <div className={cn('max-h-80 overflow-auto overscroll-contain', className)}>{children}</div>
      {footer && <div className="flex flex-wrap items-center gap-x-1 gap-y-0.5 border-t border-slate-100 bg-slate-50/70 px-2 py-1 text-[11px] text-muted dark:border-slate-800 dark:bg-slate-800/40">{footer}</div>}
    </div>
  )
}

const TOOL_BTN =
  'inline-flex h-7 items-center gap-1 rounded-md px-1.5 font-semibold text-slate-600 transition-colors hover:bg-white hover:text-brand-700 disabled:cursor-default disabled:opacity-50 disabled:hover:bg-transparent disabled:hover:text-slate-600 dark:text-slate-300 dark:hover:bg-slate-800 dark:hover:text-white touch:h-10 touch:px-2.5'

/** A tool under a table. */
export function TableTool({ onClick, disabled, tip, icon, children }: { onClick: () => void; disabled?: boolean; tip?: string; icon: ReactNode; children: ReactNode }) {
  return (
    <button type="button" onClick={onClick} disabled={disabled} data-tip={tip} className={TOOL_BTN}>
      {icon}
      {children}
    </button>
  )
}

/** How many rows, at the start of a table's tools. */
export function RowCount({ count, more = false }: { count: number; more?: boolean }) {
  return (
    <span className="me-auto px-1 tabular-nums">
      {count.toLocaleString('en-US')}
      {more ? '+' : ''} {count === 1 && !more ? 'row' : 'rows'}
    </span>
  )
}

/** Copy table: the table as tab-separated text, which Excel and Word paste as a table. */
export function CopyTableTool({ tsv }: { tsv: () => string }) {
  const { toast } = useApp()
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(tsv())
      toast('Table copied — paste it into Excel or a document.', 'success')
    } catch {
      toast('Could not copy — select the table and copy it by hand.', 'error')
    }
  }
  return (
    <TableTool onClick={() => void copy()} tip="Copies the rows as tab-separated text, ready to paste into Excel" icon={<ClipboardCopy className="h-3.5 w-3.5" />}>
      Copy table
    </TableTool>
  )
}

/** Export Excel; `exporting` shows it at work, `wait` says why it cannot run yet. */
export function ExportTool({ onExport, exporting = false, wait, tip }: { onExport: () => void; exporting?: boolean; wait?: string; tip?: string }) {
  return (
    <TableTool onClick={onExport} disabled={exporting || !!wait} tip={wait ?? tip} icon={exporting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FileSpreadsheet className="h-3.5 w-3.5" />}>
      {exporting ? 'Exporting…' : 'Export Excel'}
    </TableTool>
  )
}

/** QC-AI-table-2026-10-09-1405.xlsx. */
export const aiTableFilename = (at: Date = new Date()) => `QC-AI-table-${aiStamp(at.toISOString()).replace(' ', '-').replace(':', '')}.xlsx`

/**
 * A markdown table of the answer's text. The rendered rows come as children
 * (their cells already aligned by the rehype step in ./tables); the table's
 * own syntax tree gives its words for Copy and Export.
 */
export function AiMarkdownTable({ node, dir, children }: { node: HastNode | undefined; dir?: string; children: ReactNode }) {
  const { toast } = useApp()
  const data = useMemo(() => (node ? hastTableData(node) : { header: [], rows: [] }), [node])
  const exportExcel = () => {
    try {
      downloadWorkbook(aiTableFilename(), [textTableSheet('Table', data.header, data.rows)])
      toast(`Exported ${data.rows.length.toLocaleString('en-US')} ${data.rows.length === 1 ? 'row' : 'rows'}.`, 'success')
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not export the table.', 'error')
    }
  }
  return (
    <div className="my-3">
      <TableFrame
        footer={
          <>
            <RowCount count={data.rows.length} />
            <CopyTableTool tsv={() => tableTsv(data.header, data.rows)} />
            <ExportTool onExport={exportExcel} tip="Saves this table as a workbook" />
          </>
        }
      >
        <table dir={dir === 'rtl' ? 'rtl' : 'ltr'} className={TABLE_CLASS}>
          {children}
        </table>
      </TableFrame>
    </div>
  )
}

/** One cell of a query's rows: NULL as a faint dash, a long text cut with its whole in the tooltip (or wrapped, in the large table). */
export function ResultCell({ value, numeric, dir, wrap = false }: { value: AiCell; numeric: boolean; dir: 'rtl' | 'ltr'; wrap?: boolean }) {
  if (value === null || value === undefined) {
    return (
      <td className={tdClass(dir, numeric, 'text-muted')} aria-label="Empty">
        —
      </td>
    )
  }
  const text = cellText(value)
  const long = text.length > 60
  return (
    <td
      dir={numeric ? 'ltr' : 'auto'}
      data-tip={long && !wrap ? text.slice(0, 600) : undefined}
      className={tdClass(dir, numeric, numeric ? undefined : wrap ? 'min-w-[8rem] max-w-[28rem] whitespace-pre-wrap break-words' : 'max-w-[16rem] truncate whitespace-nowrap')}
    >
      {text}
    </td>
  )
}
