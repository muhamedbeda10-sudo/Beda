// ============================================================================
// §20 — a table in an answer, the model's markdown table or a query's rows:
// compact, striped, its header fixed while it scrolls inside its own frame
// (never the page), figures aligned to the end in left-to-right digits as
// they were written, and under it how many rows, Copy table (tab-separated,
// for pasting into Excel or a mail) and Export Excel. A table of Arabic reads
// right to left; each cell keeps its own words' direction.
//
// In a narrow frame — a phone, the panel — the table makes the most of it:
// text wraps instead of being cut (its whole was in a tooltip a finger never
// sees), a last column of figures stays in view while the rest scrolls under
// it, a shadow says which way there is more, and the tools share one row
// under the row count. The frame is a CSS container, so it is the frame's
// width that decides, wherever the table is drawn.
// ============================================================================

import { createContext, useContext, useMemo, useRef, type ReactNode } from 'react'
import { ClipboardCopy, FileSpreadsheet, Loader2 } from 'lucide-react'
import type { AiCell } from '@qc/shared/ai'
import { EdgeShadows, useScrollEdges } from '@/components/ui/ScrollX'
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

/** Marks a cell of figures, for the frame to know a table's last column is one (no style of its own). */
const NUMERIC_MARK = 'ai-num'

/**
 * A last column of figures, while the table is wider than its frame (TableFrame's `data-overflow`): it stays at the
 * frame's end edge, on the frame's colour, a hairline on its inner side, and a soft shadow while rows run under it
 * (`data-overflow-end`). Left to right it holds the right edge; right to left, the left one. Written out whole, as
 * Tailwind finds classes by reading the source. The header cell keeps its own colour and stays above the rows.
 */
const STICKY_END = {
  ltr: '[[data-overflow]_&]:last:sticky [[data-overflow]_&]:last:right-0 [[data-overflow]:not([data-overflow-end])_&]:last:shadow-[inset_1px_0_0_theme(colors.slate.200)] [[data-overflow-end]_&]:last:shadow-[inset_1px_0_0_theme(colors.slate.200),-8px_0_10px_-8px_rgb(15_23_42/0.18)] dark:[[data-overflow]:not([data-overflow-end])_&]:last:shadow-[inset_1px_0_0_theme(colors.slate.800)] dark:[[data-overflow-end]_&]:last:shadow-[inset_1px_0_0_theme(colors.slate.800),-8px_0_10px_-8px_rgb(0_0_0/0.5)]',
  rtl: '[[data-overflow]_&]:last:sticky [[data-overflow]_&]:last:left-0 [[data-overflow]:not([data-overflow-end])_&]:last:shadow-[inset_-1px_0_0_theme(colors.slate.200)] [[data-overflow-end]_&]:last:shadow-[inset_-1px_0_0_theme(colors.slate.200),8px_0_10px_-8px_rgb(15_23_42/0.18)] dark:[[data-overflow]:not([data-overflow-end])_&]:last:shadow-[inset_-1px_0_0_theme(colors.slate.800)] dark:[[data-overflow-end]_&]:last:shadow-[inset_-1px_0_0_theme(colors.slate.800),8px_0_10px_-8px_rgb(0_0_0/0.5)]',
} as const
const STICKY_END_TD = '[[data-overflow]_&]:last:z-[1] [[data-overflow]_&]:last:bg-white dark:[[data-overflow]_&]:last:bg-slate-900'

/** A text cell in a narrow frame does not shrink to a word a line: the table scrolls instead. */
const TEXT_NARROW = '[@container(max-width:36rem)]:min-w-[5rem]'

/**
 * Where a cell's content sits: text at the start of the table's reading
 * direction, figures at its end — the same for every cell of a column,
 * whichever language each cell is in.
 */
export function cellAlign(tableDir: 'rtl' | 'ltr', numeric: boolean): string {
  return (tableDir === 'rtl') !== numeric ? 'text-right' : 'text-left'
}

/** The classes of a header cell and a body cell. */
export const thClass = (tableDir: 'rtl' | 'ltr', numeric: boolean) => cn(TH_CLASS, cellAlign(tableDir, numeric), numeric && cn(NUMERIC_MARK, STICKY_END[tableDir]))
export const tdClass = (tableDir: 'rtl' | 'ltr', numeric: boolean, extra?: string) =>
  cn(TD_CLASS, cellAlign(tableDir, numeric), numeric ? cn(NUMERIC_MARK, 'whitespace-nowrap tabular-nums', STICKY_END[tableDir], STICKY_END_TD) : TEXT_NARROW, extra)

/**
 * The frame a table scrolls in, both ways, with its line of tools underneath.
 * How tall it may grow is the surface's to say (.ai-table-scroll in
 * index.css): a few rows in the panel, more on the full page, fewer under a
 * chart. `dir`: the table's direction, which the scrolling takes too — a
 * table of Arabic wider than its frame opens at its first column, on the
 * right, and scrolls on to the left. The tools are this app's words, left
 * to right under any table.
 *
 * The scroller says which ends hide columns (`data-overflow-start`/`-end`,
 * and `data-overflow` for either), for the sticky last column of figures; a
 * shadow over each such end says so too — except over that column, which
 * casts its own. The scroller is isolated, so the header row's stacking stays
 * inside it and the shadows lie over all of it.
 */
export function TableFrame({ children, footer, dir }: { children: ReactNode; footer?: ReactNode; dir: 'rtl' | 'ltr' }) {
  const scroller = useRef<HTMLDivElement>(null)
  const edges = useScrollEdges(scroller)
  return (
    <div className="group/frame overflow-hidden rounded-xl bg-white ring-1 ring-slate-200 [container-type:inline-size] dark:bg-slate-900 dark:ring-slate-800">
      <div className="relative">
        <div
          ref={scroller}
          dir={dir}
          data-overflow={edges.start || edges.end || undefined}
          data-overflow-start={edges.start || undefined}
          data-overflow-end={edges.end || undefined}
          className="ai-table-scroll relative isolate overflow-auto overscroll-contain"
        >
          {children}
        </div>
        <EdgeShadows rtl={edges.rtl} start={edges.start} end={false} />
        <EdgeShadows rtl={edges.rtl} start={false} end={edges.end} className="group-has-[th.ai-num:last-child]/frame:hidden" />
      </div>
      {footer && (
        <div dir="ltr" className="flex flex-wrap items-center gap-x-1 gap-y-0.5 border-t border-slate-100 bg-slate-50/70 px-2 py-1 text-[11px] text-muted dark:border-slate-800 dark:bg-slate-800/40">
          {footer}
        </div>
      )}
    </div>
  )
}

// Narrower than 28rem (a phone), the tools share their row in equal parts, under the row count.
const TOOL_BTN =
  'inline-flex h-7 items-center gap-1 rounded-md px-1.5 font-semibold text-slate-600 transition-colors hover:bg-white hover:text-brand-700 disabled:cursor-default disabled:opacity-50 disabled:hover:bg-transparent disabled:hover:text-slate-600 dark:text-slate-300 dark:hover:bg-slate-800 dark:hover:text-white touch:h-10 touch:px-2.5 [@container(max-width:28rem)]:flex-1 [@container(max-width:28rem)]:justify-center'
/** Words of a tool's name a narrow frame leaves out ("Copy table" reads "Copy" there). */
const WIDE_ONLY = '[@container(max-width:28rem)]:hidden'

/** A tool under a table. */
export function TableTool({ onClick, disabled, tip, icon, children }: { onClick: () => void; disabled?: boolean; tip?: string; icon: ReactNode; children: ReactNode }) {
  return (
    <button type="button" onClick={onClick} disabled={disabled} data-tip={tip} className={TOOL_BTN}>
      {icon}
      {children}
    </button>
  )
}

const ICON_TOOL_BTN =
  'inline-grid h-7 w-7 place-items-center rounded-md text-slate-600 [&>svg]:h-4 [&>svg]:w-4 transition-colors hover:bg-slate-100 hover:text-brand-700 disabled:cursor-default disabled:opacity-50 disabled:hover:bg-transparent disabled:hover:text-slate-600 dark:text-slate-300 dark:hover:bg-slate-800 dark:hover:text-white touch:h-10 touch:w-10'

/** A tool shown as its icon alone: its name is what a screen reader says and what its tooltip (or a long press) reads. */
export function IconTool({ onClick, disabled, label, tip, icon }: { onClick: () => void; disabled?: boolean; label: string; tip?: string; icon: ReactNode }) {
  return (
    <button type="button" onClick={onClick} disabled={disabled} aria-label={label} data-tip={tip ? `${label} — ${tip}` : label} className={ICON_TOOL_BTN}>
      {icon}
    </button>
  )
}

/** How many rows, at the start of a table's tools. */
export function RowCount({ count, more = false }: { count: number; more?: boolean }) {
  return (
    <span className="me-auto px-1 tabular-nums [@container(max-width:28rem)]:basis-full [@container(max-width:28rem)]:py-0.5">
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
      Copy<span className={WIDE_ONLY}> table</span>
    </TableTool>
  )
}

/** Export Excel; `exporting` shows it at work, `wait` says why it cannot run yet. */
export function ExportTool({ onExport, exporting = false, wait, tip, iconOnly = false }: { onExport: () => void; exporting?: boolean; wait?: string; tip?: string; iconOnly?: boolean }) {
  const icon = exporting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FileSpreadsheet className="h-3.5 w-3.5" />
  if (iconOnly) return <IconTool onClick={onExport} disabled={exporting || !!wait} label={exporting ? 'Exporting…' : 'Export Excel'} tip={wait ?? tip} icon={icon} />
  return (
    <TableTool onClick={onExport} disabled={exporting || !!wait} tip={wait ?? tip} icon={icon}>
      {exporting ? (
        'Exporting…'
      ) : (
        <>
          <span className={WIDE_ONLY}>Export </span>Excel
        </>
      )}
    </TableTool>
  )
}

/**
 * Whether the tables of the text around may be exported to Excel: within an
 * answer, only for someone the assistant's owner allows Excel (§20); a
 * delivered report shows its tables to whoever it went to, as before.
 */
export const AiTableExcel = createContext(true)

/** QC-AI-table-2026-10-09-1405.xlsx. */
export const aiTableFilename = (at: Date = new Date()) => `QC-AI-table-${aiStamp(at.toISOString()).replace(' ', '-').replace(':', '')}.xlsx`

/**
 * A markdown table of the answer's text. The rendered rows come as children
 * (their cells already aligned by the rehype step in ./tables); the table's
 * own syntax tree gives its words for Copy and Export.
 */
export function AiMarkdownTable({ node, dir, children }: { node: HastNode | undefined; dir?: string; children: ReactNode }) {
  const { toast } = useApp()
  const excel = useContext(AiTableExcel)
  const data = useMemo(() => (node ? hastTableData(node) : { header: [], rows: [] }), [node])
  const exportExcel = () => {
    try {
      downloadWorkbook(aiTableFilename(), [textTableSheet('Table', data.header, data.rows)])
      toast(`Exported ${data.rows.length.toLocaleString('en-US')} ${data.rows.length === 1 ? 'row' : 'rows'}.`, 'success')
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not export the table.', 'error')
    }
  }
  const tableDir = dir === 'rtl' ? 'rtl' : 'ltr'
  return (
    <div className="my-3">
      <TableFrame
        dir={tableDir}
        footer={
          <>
            <RowCount count={data.rows.length} />
            <CopyTableTool tsv={() => tableTsv(data.header, data.rows)} />
            {excel && <ExportTool onExport={exportExcel} tip="Saves this table as a workbook" />}
          </>
        }
      >
        <table dir={tableDir} className={TABLE_CLASS}>
          {children}
        </table>
      </TableFrame>
    </div>
  )
}

/**
 * One cell of a query's rows: NULL as a faint dash, a long text cut with its whole in the tooltip — wrapped
 * instead in the large table (`wrap`), in a narrow frame, and under a finger, which has no hover to read a tooltip.
 */
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
      className={tdClass(
        dir,
        numeric,
        numeric
          ? undefined
          : wrap
            ? // Long text (a name) over several lines; short text (a code, an order number) kept whole on one.
              text.length > 24
              ? 'min-w-[10rem] max-w-[28rem] whitespace-pre-wrap break-words'
              : 'whitespace-nowrap'
            : 'max-w-[16rem] truncate whitespace-nowrap touch:whitespace-normal touch:break-words [@container(max-width:36rem)]:max-w-[10rem] [@container(max-width:36rem)]:whitespace-normal [@container(max-width:36rem)]:break-words',
      )}
    >
      {text}
    </td>
  )
}
