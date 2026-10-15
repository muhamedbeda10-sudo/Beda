// ============================================================================
// §20 — the parts of a report the assistant built that an answer's cards do
// not have: the form a run asks for (orders, a week, the orders to leave
// out…), a section's headline figures as cards, and a section's rows as a
// tree that opens level by level (a main item, its parts, each machine).
// ============================================================================

import { useMemo, useState } from 'react'
import { ChevronRight, Play } from 'lucide-react'
import type { AiCell, AiReportSectionRun, AiReportTree } from '@qc/shared/ai'
import type { AiReportInput } from '@qc/shared/aiReportInputs'
import { Button } from '@/components/ui'
import { cn } from '@/lib/utils'
import { ResultCell, TABLE_CLASS, TBODY_CLASS, TR_CLASS, TableFrame, thClass } from './AiTable'
import { sectionFigures, treeRows } from './reportInputs'
import { cellText, numericColumns, queryTextRows, tableDirection } from './tables'

const FIELD = 'input h-9 w-full px-2.5 py-0 text-13 touch:h-11'

/**
 * How a section that ran shows its rows: as figures or a tree when it was
 * built so and its rows allow it (one that failed shows its error; a tree
 * whose key or parent column is not in the result, its table), else a table.
 */
export function sectionDisplay(s: Pick<AiReportSectionRun, 'ok' | 'display' | 'tree' | 'columns'>): 'table' | 'figures' | 'tree' {
  if (!s.ok) return 'table'
  if (s.display === 'figures') return 'figures'
  if (s.display === 'tree' && s.tree && s.columns.includes(s.tree.key) && s.columns.includes(s.tree.parent)) return 'tree'
  return 'table'
}

/**
 * What a run asks for, as the report's maker declared it: a field each, its
 * hint under it, Run to run with what is typed. The values are checked here
 * as the server checks them, and the problems shown by the fields' names.
 */
export function ReportInputsForm({
  inputs,
  drafts,
  onChange,
  onRun,
  problems,
  running,
}: {
  inputs: readonly AiReportInput[]
  drafts: Record<string, string>
  onChange: (name: string, value: string) => void
  onRun: () => void
  problems: readonly string[]
  running: boolean
}) {
  return (
    <form
      className="space-y-2 rounded-xl bg-slate-50 p-2.5 ring-1 ring-slate-200/70 dark:bg-slate-800/50 dark:ring-slate-800"
      onSubmit={(e) => {
        e.preventDefault()
        onRun()
      }}
    >
      <ReportInputFields inputs={inputs} drafts={drafts} onChange={onChange} className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4" />
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" variant="primary" disabled={running} className="h-9 min-h-0 gap-1.5 px-3 py-0 text-xs touch:h-11">
          <Play className="h-3.5 w-3.5" /> Run
        </Button>
        {problems.length > 0 && (
          <ul role="alert" className="min-w-0 flex-1 space-y-0.5 text-[11px] font-semibold text-rose-600 dark:text-rose-400">
            {problems.map((p) => (
              <li key={p} dir="auto">
                {p}
              </li>
            ))}
          </ul>
        )}
      </div>
    </form>
  )
}

/**
 * A field for each of a report's inputs, its hint under it: the report's own
 * form, and the values a schedule sends it with. `optional`: every field may
 * be left empty, each then taking its default on the day (a schedule's).
 */
export function ReportInputFields({
  inputs,
  drafts,
  onChange,
  className,
  optional = false,
  idPrefix = 'report-input',
}: {
  inputs: readonly AiReportInput[]
  drafts: Record<string, string>
  onChange: (name: string, value: string) => void
  className?: string
  optional?: boolean
  idPrefix?: string
}) {
  return (
    <div className={className}>
      {inputs.map((input) => {
        const id = `${idPrefix}-${input.name}`
        const value = drafts[input.name] ?? ''
        const required = input.required && !(optional && (input.dynamicDefault || input.default !== undefined))
        const empty = optional && !input.required ? 'Empty: any' : optional ? 'Empty: its default on the day' : undefined
        return (
          <div key={input.name} className="min-w-0 space-y-1">
            <label htmlFor={id} dir="auto" className="block text-[11px] font-bold text-slate-600 dark:text-slate-300">
              {input.label}
              {required && (
                <span className="text-rose-600 dark:text-rose-400" aria-hidden>
                  {' '}
                  *
                </span>
              )}
            </label>
            {input.kind === 'choice' ? (
              <select id={id} value={value} onChange={(e) => onChange(input.name, e.target.value)} required={required} className={FIELD}>
                {(!required || !value) && <option value="">{required ? 'Choose…' : optional && input.required ? 'Its default on the day' : 'Any'}</option>}
                {(input.choices ?? []).map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            ) : (
              <input
                id={id}
                type={input.kind === 'date' ? 'date' : 'text'}
                inputMode={input.kind === 'number' ? 'decimal' : undefined}
                dir="auto"
                value={value}
                onChange={(e) => onChange(input.name, e.target.value)}
                placeholder={empty ?? (input.kind === 'list' ? 'Several, apart by commas or spaces' : undefined)}
                aria-describedby={input.help ? `${id}-help` : undefined}
                className={cn(FIELD, input.kind === 'number' && 'tabular-nums')}
              />
            )}
            {input.help && (
              <p id={`${id}-help`} dir="auto" className="text-[11px] leading-snug text-muted">
                {input.help}
              </p>
            )}
          </div>
        )
      })}
    </div>
  )
}

/**
 * A figures section: the first row's columns, each figure under its name. The
 * facts that are words or dates (the customer, the latest due date) read as a
 * line of their own on top; the numbers as cards of one size, large.
 */
export function SectionFigures({ columns, rows }: { columns: readonly string[]; rows: readonly AiCell[][] }) {
  const figures = sectionFigures(columns, rows).map((f) => {
    const text = figureText(f.value)
    return { ...f, text, numeric: typeof f.value === 'number' || /^-?[\d,]+(\.\d+)?%?$/.test(text) }
  })
  if (figures.length === 0) return <p className="rounded-xl bg-slate-50 px-3 py-2 text-13 text-muted dark:bg-slate-800/60">No rows matched.</p>
  const facts = figures.filter((f) => !f.numeric)
  const numbers = figures.filter((f) => f.numeric)
  return (
    <div className="space-y-3">
      {facts.length > 0 && (
        <dl className="grid grid-cols-1 gap-x-6 gap-y-2.5 sm:grid-cols-[repeat(auto-fit,minmax(14rem,1fr))]" data-testid="report-facts">
          {facts.map((f, i) => (
            <div key={i} className="min-w-0 border-s-2 border-brand-500/70 ps-3 dark:border-brand-400/70">
              <dt dir="auto" className="text-[11px] font-semibold uppercase tracking-wide text-muted">
                {f.label}
              </dt>
              <dd dir="auto" data-tip={f.text.length > 120 ? f.text.slice(0, 600) : undefined} className="mt-0.5 line-clamp-3 break-words text-left text-sm font-semibold text-slate-800 dark:text-slate-100">
                {f.text}
              </dd>
            </div>
          ))}
        </dl>
      )}
      {numbers.length > 0 && (
        <dl className="grid grid-cols-2 gap-2.5 sm:grid-cols-[repeat(auto-fill,minmax(10rem,1fr))]" data-testid="report-numbers">
          {numbers.map((f, i) => (
            <div key={i} className="flex min-w-0 flex-col justify-between gap-2 rounded-xl bg-slate-50 px-3.5 py-3 ring-1 ring-slate-200/80 dark:bg-slate-800/50 dark:ring-slate-700/60">
              <dt dir="auto" className="line-clamp-2 text-[11px] font-semibold uppercase leading-tight tracking-wide text-muted" data-tip={f.label}>
                {f.label}
              </dt>
              <dd dir="ltr" className="text-start text-2xl font-extrabold leading-none tracking-tight tabular-nums text-slate-900 dark:text-white">
                {f.text}
              </dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  )
}

/** A figure as read: a number with its thousands marked, nothing as —. */
function figureText(v: AiCell): string {
  if (v === null || v === '') return '—'
  if (typeof v === 'number') return v.toLocaleString('en-US', { maximumFractionDigits: 2 })
  const n = typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v.trim()) ? Number(v) : NaN
  return Number.isFinite(n) ? n.toLocaleString('en-US', { maximumFractionDigits: 2 }) : cellText(v)
}

/**
 * A tree section: the rows at the top, each opening on the rows under it.
 * Open all and Close all for the whole tree; the key and parent columns are
 * not shown. Falls back to nothing (null) when the tree's columns are not in
 * the result — the caller shows the table then.
 */
export function SectionTree({ columns, rows, tree, truncated }: { columns: readonly string[]; rows: readonly AiCell[][]; tree: AiReportTree; truncated: boolean }) {
  const laid = useMemo(() => treeRows(columns, rows, tree), [columns, rows, tree])
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set())
  const shownColumns = useMemo(() => laid?.shown.map((c) => columns[c]) ?? [], [laid, columns])
  const shownRows = useMemo(() => (laid ? laid.rows.map((r) => laid.shown.map((c) => rows[r.index][c] ?? null)) : []), [laid, rows])
  const numeric = useMemo(() => numericColumns(shownColumns, shownRows), [shownColumns, shownRows])
  const dir = useMemo(() => tableDirection(shownColumns, queryTextRows(shownRows.slice(0, 20), shownColumns.length)), [shownColumns, shownRows])
  if (!laid) return null
  if (laid.rows.length === 0) return <p className="rounded-xl bg-slate-50 px-3 py-2 text-13 text-muted dark:bg-slate-800/60">No rows matched.</p>

  const parents = laid.rows.filter((r) => r.childCount > 0).map((r) => r.key)
  const visible = laid.rows.map((r, i) => ({ r, i })).filter(({ r }) => r.path.every((k) => open.has(k)))
  const toggle = (key: string) =>
    setOpen((s) => {
      const next = new Set(s)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })

  return (
    <div className="space-y-1.5">
      {parents.length > 0 && (
        <div className="flex flex-wrap gap-3 text-xs">
          <button type="button" onClick={() => setOpen(new Set(parents))} className="font-semibold text-brand-700 hover:underline dark:text-brand-300 touch:min-h-[44px]">
            Open all
          </button>
          <button type="button" onClick={() => setOpen(new Set())} className="font-semibold text-brand-700 hover:underline dark:text-brand-300 touch:min-h-[44px]">
            Close all
          </button>
        </div>
      )}
      <TableFrame
        dir={dir}
        footer={
          <span className="text-[11px] tabular-nums text-muted">
            {visible.length.toLocaleString()} of {laid.rows.length.toLocaleString()}
            {truncated ? '+' : ''} rows shown
          </span>
        }
      >
        <table dir={dir} className={cn(TABLE_CLASS, 'text-xs')}>
          <thead>
            <tr>
              {shownColumns.map((name, c) => (
                <th key={c} scope="col" dir="auto" className={thClass(dir, numeric[c])}>
                  {name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className={TBODY_CLASS}>
            {visible.map(({ r, i }) => {
              const isOpen = open.has(r.key)
              return (
                <tr key={r.index} className={cn(TR_CLASS, r.depth === 0 && 'font-semibold')}>
                  {shownRows[i].map((v, c) =>
                    c === 0 ? (
                      <td key={c} className="whitespace-nowrap border-b border-slate-100 px-2 py-1.5 align-top dark:border-slate-800">
                        <span className="inline-flex items-center gap-1" style={{ paddingInlineStart: `${r.depth * 1.25}rem` }}>
                          {r.childCount > 0 ? (
                            <button
                              type="button"
                              onClick={() => toggle(r.key)}
                              aria-expanded={isOpen}
                              aria-label={isOpen ? 'Close' : `Open: ${r.childCount} under it`}
                              className="icon-btn h-6 w-6 shrink-0 touch:h-9 touch:w-9"
                            >
                              <ChevronRight className={cn('h-3.5 w-3.5 transition-transform rtl:rotate-180', isOpen && 'rotate-90 rtl:rotate-90')} />
                            </button>
                          ) : (
                            <span className="inline-block w-6 shrink-0 touch:w-9" aria-hidden />
                          )}
                          <span dir="auto">{v === null ? '—' : cellText(v)}</span>
                        </span>
                      </td>
                    ) : (
                      // Names in full, over as many lines as they take: a report is read, not scanned.
                      <ResultCell key={c} value={v} numeric={numeric[c]} dir={dir} wrap />
                    ),
                  )}
                </tr>
              )
            })}
          </tbody>
        </table>
      </TableFrame>
    </div>
  )
}
