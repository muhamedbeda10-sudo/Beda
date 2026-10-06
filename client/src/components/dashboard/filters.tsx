// ============================================================================
// Pick lists for the dashboard: a floating panel that escapes the widget's
// scroll box, a multi-select menu (the machines of a widget), and Excel-like
// column filters on a table's header row: tick the values a column may show,
// search them, or show them all again.
// ============================================================================

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { Check, ChevronDown, Filter, Search } from 'lucide-react'
import { cn } from '@/lib/utils'

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

/** Compares names the way a person reads them: LM2 before LM2-Ext. before LM10. */
export const byName = (a: string, b: string): number => collator.compare(a, b)

const matches = (text: string, query: string): boolean => text.toLowerCase().includes(query.trim().toLowerCase())

/**
 * A panel fixed under (or above, when there is no room) its anchor, drawn on
 * the page body so a widget's own scroll box never clips it. Closes on a
 * click outside it or on Escape.
 */
function FloatingPanel({ anchor, open, onClose, width = 260, label, children }: { anchor: RefObject<HTMLElement>; open: boolean; onClose: () => void; width?: number; label: string; children: ReactNode }) {
  const panel = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)
  useLayoutEffect(() => {
    if (!open) return
    const place = () => {
      const a = anchor.current
      if (!a) return
      const r = a.getBoundingClientRect()
      const h = panel.current?.offsetHeight ?? 320
      const left = Math.max(8, Math.min(r.left, window.innerWidth - width - 8))
      const below = r.bottom + 4
      const top = below + h > window.innerHeight - 8 && r.top - h - 4 > 8 ? r.top - h - 4 : below
      setPos({ top, left })
    }
    place()
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => {
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
    }
  }, [open, anchor, width])
  useEffect(() => {
    if (!open) return
    const outside = (e: MouseEvent | TouchEvent) => {
      const target = e.target as Node
      if (panel.current?.contains(target) || anchor.current?.contains(target)) return
      onClose()
    }
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('mousedown', outside)
    document.addEventListener('touchstart', outside)
    document.addEventListener('keydown', key)
    return () => {
      document.removeEventListener('mousedown', outside)
      document.removeEventListener('touchstart', outside)
      document.removeEventListener('keydown', key)
    }
  }, [open, onClose, anchor])
  if (!open) return null
  return createPortal(
    <div
      ref={panel}
      role="dialog"
      aria-label={label}
      style={{ position: 'fixed', top: pos?.top ?? -9999, left: pos?.left ?? -9999, width }}
      className="z-[60] rounded-xl bg-white p-2 text-sm normal-case tracking-normal text-slate-700 shadow-xl ring-1 ring-slate-200 dark:bg-slate-900 dark:text-slate-200 dark:ring-slate-700"
    >
      {children}
    </div>,
    document.body,
  )
}

function CheckRow({ on, onClick, children, count }: { on: boolean; onClick: () => void; children: ReactNode; count?: number }) {
  return (
    <button type="button" role="menuitemcheckbox" aria-checked={on} onClick={onClick} className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-slate-50 dark:hover:bg-slate-800">
      <span className={cn('grid h-4 w-4 shrink-0 place-items-center rounded border', on ? 'border-brand-600 bg-brand-600 text-white' : 'border-slate-300 dark:border-slate-600')}>{on && <Check className="h-3 w-3" />}</span>
      <span className="min-w-0 flex-1 truncate" dir="auto">{children}</span>
      {count !== undefined && <span className="shrink-0 text-xs tabular-nums text-muted">{count}</span>}
    </button>
  )
}

function SearchBox({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder: string }) {
  return (
    <label className="mb-1 flex items-center gap-1.5 rounded-lg bg-slate-50 px-2 ring-1 ring-slate-200 dark:bg-slate-800 dark:ring-slate-700">
      <Search className="h-3.5 w-3.5 shrink-0 text-muted" />
      <input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} aria-label={placeholder} className="min-h-[34px] w-full bg-transparent text-sm outline-none" dir="auto" autoFocus />
    </label>
  )
}

export interface PickOption {
  value: string
  label: string
  sub?: string
}

/**
 * A button that opens a list of ticks: none ticked means all of them. It
 * reads "All machines", the one ticked, or "3 machines".
 */
export function MultiSelectMenu({ options, selected, onChange, allLabel, noun, ariaLabel, className }: { options: PickOption[]; selected: string[]; onChange: (next: string[]) => void; allLabel: string; noun: string; ariaLabel: string; className?: string }) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const anchor = useRef<HTMLButtonElement>(null)
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
  const isOn = (v: string) => selected.some((s) => same(s, v))
  // A ticked value the list no longer offers stays listed, so it can be unticked.
  const all: PickOption[] = [...options, ...selected.filter((s) => !options.some((o) => same(o.value, s))).map((s) => ({ value: s, label: s }))]
  const text = selected.length === 0 ? allLabel : selected.length === 1 ? (all.find((o) => same(o.value, selected[0]))?.label ?? selected[0]) : `${selected.length} ${noun}`
  const shown = all.filter((o) => matches(`${o.label} ${o.sub ?? ''}`, query))
  const toggle = (v: string) => onChange(isOn(v) ? selected.filter((s) => !same(s, v)) : [...selected, v])
  return (
    <>
      <button
        ref={anchor}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={ariaLabel}
        onClick={() => setOpen((o) => !o)}
        className={cn('print-hidden inline-flex min-h-[36px] max-w-[16rem] items-center gap-1.5 rounded-lg bg-white px-2.5 text-xs font-semibold ring-1 ring-slate-200 hover:bg-slate-50 dark:bg-slate-900 dark:ring-slate-700 dark:hover:bg-slate-800', selected.length > 0 && 'text-brand-700 ring-brand-300 dark:text-brand-300 dark:ring-brand-500/50', className)}
      >
        <span className="truncate">{text}</span>
        <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted" />
      </button>
      <FloatingPanel anchor={anchor} open={open} onClose={() => setOpen(false)} label={ariaLabel}>
        {all.length > 6 && <SearchBox value={query} onChange={setQuery} placeholder={`Search ${noun}`} />}
        <CheckRow on={selected.length === 0} onClick={() => onChange([])}>{allLabel}</CheckRow>
        <div className="my-1 border-t border-slate-100 dark:border-slate-800" />
        <div className="max-h-64 overflow-auto">
          {shown.map((o) => (
            <CheckRow key={o.value} on={isOn(o.value)} onClick={() => toggle(o.value)}>
              {o.label}
              {o.sub && <span className="ml-1 text-xs text-muted">{o.sub}</span>}
            </CheckRow>
          ))}
          {shown.length === 0 && <p className="px-2 py-3 text-center text-xs text-muted">Nothing matches.</p>}
        </div>
      </FloatingPanel>
    </>
  )
}

/**
 * A dropdown with a search box, for one choice out of many: the button reads
 * the choice or `placeholder`; the list is what `options` holds for the words
 * typed (the caller fetches them), with a first row that clears the choice.
 */
export function SearchSelect({
  value,
  options,
  search,
  onSearch,
  onPick,
  placeholder,
  clearLabel,
  ariaLabel,
  loading = false,
  className,
}: {
  value: PickOption | null
  options: PickOption[]
  search: string
  onSearch: (term: string) => void
  onPick: (option: PickOption | null) => void
  placeholder: string
  clearLabel: string
  ariaLabel: string
  loading?: boolean
  className?: string
}) {
  const [open, setOpen] = useState(false)
  const anchor = useRef<HTMLButtonElement>(null)
  const pick = (o: PickOption | null) => {
    onPick(o)
    setOpen(false)
  }
  return (
    <>
      <button
        ref={anchor}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={ariaLabel}
        onClick={() => setOpen((o) => !o)}
        className={cn('input flex min-h-[44px] w-full items-center gap-2 text-left', className)}
      >
        <span className={cn('min-w-0 flex-1 truncate', !value && 'text-muted')} dir="auto">
          {value ? value.label : placeholder}
          {value?.sub && <span className="ml-1.5 text-xs text-muted">{value.sub}</span>}
        </span>
        <ChevronDown className="h-4 w-4 shrink-0 text-muted" />
      </button>
      <FloatingPanel anchor={anchor} open={open} onClose={() => setOpen(false)} label={ariaLabel} width={340}>
        <SearchBox value={search} onChange={onSearch} placeholder="Search…" />
        <button type="button" onClick={() => pick(null)} className={cn('w-full rounded-lg px-2 py-2 text-left text-sm hover:bg-slate-50 dark:hover:bg-slate-800', !value && 'font-semibold text-brand-700 dark:text-brand-300')}>
          {clearLabel}
        </button>
        <div className="my-1 border-t border-slate-100 dark:border-slate-800" />
        <div className="max-h-72 overflow-auto" role="listbox" aria-label={`${ariaLabel} options`}>
          {options.map((o) => {
            const on = value?.value === o.value
            return (
              <button key={o.value} type="button" role="option" aria-selected={on} onClick={() => pick(o)} className={cn('flex w-full items-start gap-2 rounded-lg px-2 py-2 text-left text-sm hover:bg-slate-50 dark:hover:bg-slate-800', on && 'bg-brand-50 dark:bg-brand-500/10')}>
                <span className="min-w-0 flex-1" dir="auto">
                  <span className="block font-medium">{o.label}</span>
                  {o.sub && <span className="block text-xs text-muted">{o.sub}</span>}
                </span>
                {on && <Check className="mt-0.5 h-4 w-4 shrink-0 text-brand-600" />}
              </button>
            )
          })}
          {options.length === 0 && <p className="px-2 py-3 text-center text-xs text-muted">{loading ? 'Searching…' : 'Nothing matches.'}</p>}
        </div>
      </FloatingPanel>
    </>
  )
}

// ---- Excel-like column filters ----------------------------------------------

export interface FilterColumn<T> {
  key: string
  /** The text the column shows for a row: what the filter lists and matches. */
  value: (r: T) => string
  /** List the values as numbers, smallest first. */
  numeric?: boolean
}

export interface ColumnFilters<T> {
  /** The rows every column's ticks let through. */
  rows: T[]
  /** How many columns are filtered. */
  active: number
  clear: () => void
  /** The header's filter button for a column. */
  button: (key: string, label: string) => ReactNode
}

/**
 * Excel's filter on a table's header row. A column with nothing picked lets
 * every row through; a column lists the values of the rows the other
 * columns' filters let through, with how many rows carry each.
 */
export function useColumnFilters<T>(rows: T[], columns: FilterColumn<T>[]): ColumnFilters<T> {
  const [picked, setPicked] = useState<Record<string, string[]>>({})
  const passes = (r: T, except?: string) => columns.every((c) => c.key === except || picked[c.key] === undefined || picked[c.key].includes(c.value(r)))
  const valuesOf = (key: string): { value: string; count: number }[] => {
    const column = columns.find((c) => c.key === key)
    if (!column) return []
    const counts = new Map<string, number>()
    for (const r of rows) if (passes(r, key)) counts.set(column.value(r), (counts.get(column.value(r)) ?? 0) + 1)
    // A picked value no other row carries now stays listed, so it can be unticked.
    for (const v of picked[key] ?? []) if (!counts.has(v)) counts.set(v, 0)
    return Array.from(counts, ([value, count]) => ({ value, count })).sort((a, b) => (column.numeric ? Number(a.value) - Number(b.value) || byName(a.value, b.value) : byName(a.value, b.value)))
  }
  const set = (key: string, values: string[] | null) =>
    setPicked((prev) => {
      const next = { ...prev }
      if (values === null) delete next[key]
      else next[key] = values
      return next
    })
  return {
    rows: rows.filter((r) => passes(r)),
    active: Object.keys(picked).length,
    clear: () => setPicked({}),
    button: (key, label) => <ColumnFilterButton label={label} values={valuesOf(key)} picked={picked[key]} onChange={(v) => set(key, v)} />,
  }
}

function ColumnFilterButton({ label, values, picked, onChange }: { label: string; values: { value: string; count: number }[]; picked: string[] | undefined; onChange: (next: string[] | null) => void }) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const anchor = useRef<HTMLButtonElement>(null)
  const on = (v: string) => picked === undefined || picked.includes(v)
  const shown = values.filter((v) => matches(v.value || '(blank)', query))
  const allValues = values.map((v) => v.value)
  const toggle = (v: string) => {
    const now = picked ?? allValues
    const next = now.includes(v) ? now.filter((x) => x !== v) : [...now, v]
    // Every value ticked again is no filter at all.
    onChange(allValues.every((x) => next.includes(x)) ? null : next)
  }
  return (
    <>
      <button
        ref={anchor}
        type="button"
        aria-label={`Filter ${label}`}
        aria-expanded={open}
        onClick={(e) => {
          e.stopPropagation()
          setOpen((o) => !o)
        }}
        className={cn('print-hidden inline-grid h-5 w-5 place-items-center rounded hover:bg-slate-100 dark:hover:bg-slate-800', picked !== undefined ? 'bg-brand-100 text-brand-700 dark:bg-brand-500/20 dark:text-brand-300' : 'text-slate-300 dark:text-slate-600')}
        data-tip={picked !== undefined ? `${label}: ${picked.length} of ${values.length} shown` : `Filter ${label}`}
      >
        <Filter className="h-3 w-3" />
      </button>
      <FloatingPanel anchor={anchor} open={open} onClose={() => setOpen(false)} label={`Filter ${label}`}>
        <SearchBox value={query} onChange={setQuery} placeholder={`Search ${label.toLowerCase()}`} />
        {query.trim() !== '' && shown.length > 0 && (
          <button type="button" onClick={() => onChange(shown.map((v) => v.value))} className="mb-1 w-full rounded-lg px-2 py-1.5 text-left text-xs font-semibold text-brand-700 hover:bg-brand-50 dark:text-brand-300 dark:hover:bg-brand-500/10">
            Only the {shown.length} found
          </button>
        )}
        <CheckRow on={picked === undefined} onClick={() => onChange(picked === undefined ? [] : null)}>(Select all)</CheckRow>
        <div className="my-1 border-t border-slate-100 dark:border-slate-800" />
        <div className="max-h-64 overflow-auto">
          {shown.map((v) => (
            <CheckRow key={v.value} on={on(v.value)} onClick={() => toggle(v.value)} count={v.count}>
              {v.value || <span className="text-muted">(blank)</span>}
            </CheckRow>
          ))}
          {shown.length === 0 && <p className="px-2 py-3 text-center text-xs text-muted">Nothing matches.</p>}
        </div>
      </FloatingPanel>
    </>
  )
}

/** A header cell with its label and its filter button. */
export function FilterTh<T>({ filters, column, label, className }: { filters: ColumnFilters<T>; column: string; label: string; className?: string }) {
  return (
    <th className={cn('whitespace-nowrap px-2 py-1.5 font-semibold', className)}>
      <span className={cn('inline-flex items-center gap-1', className?.includes('text-right') && 'flex-row-reverse')}>
        {label}
        {filters.button(column, label)}
      </span>
    </th>
  )
}

/** Under a filtered table: how many rows show, and a way to show them all. */
export function FilterNote<T>({ filters, total }: { filters: ColumnFilters<T>; total: number }) {
  if (filters.active === 0) return null
  return (
    <p className="print-hidden mt-2 flex items-center justify-between gap-2 px-2 text-xs text-muted">
      <span>
        {filters.rows.length} of {total} rows · {filters.active} {filters.active === 1 ? 'column' : 'columns'} filtered
      </span>
      <button type="button" onClick={filters.clear} className="font-semibold text-brand-700 hover:underline dark:text-brand-300">
        Clear filters
      </button>
    </p>
  )
}
