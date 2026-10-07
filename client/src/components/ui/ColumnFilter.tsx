// ============================================================================
// Excel's filter, on the header of every table. A column's menu sorts the
// table by it (A→Z, Z→A), keeps the rows whose cell contains a piece of text,
// and ticks the values it may show — searched, with (Select all) and how many
// rows carry each. Nothing changes until OK.
//
// The menu does not care where the values come from: a table that holds all
// its rows lists them itself (useTableView); a table read page by page from
// the server asks the server for them (loadValues), so the list, the filter
// and the count cover the whole record, not the page on screen.
// ============================================================================

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { ArrowDownAZ, ArrowDownWideNarrow, ArrowUpAZ, ArrowUpNarrowWide, Check, ChevronDown, Filter, FilterX, Search, X } from 'lucide-react'
import type { ColumnFilter, ColumnFilters, ColumnSort, ColumnValuesResponse } from '@qc/shared/api'
import { FloatingPanel } from '@/components/dashboard/filters'
import { cn } from '@/lib/utils'

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })
const byText = (a: string, b: string) => collator.compare(a, b)
const lower = (s: string) => s.trim().toLowerCase()

/** Whether a cell's text passes a column's filter. */
export function passesFilter(text: string, f: ColumnFilter | undefined): boolean {
  if (!f) return true
  if (f.values && !f.values.includes(text)) return false
  if (f.except?.includes(text)) return false
  if (f.contains && !lower(text).includes(lower(f.contains))) return false
  return true
}

/** A filter that filters nothing is no filter. */
export function isActive(f: ColumnFilter | undefined): boolean {
  return !!f && (f.values !== undefined || (f.except?.length ?? 0) > 0 || !!f.contains?.trim())
}

/** The filter in words, for a chip or a tooltip: "Machine: 2 values", "Item contains "beam"". */
export function describeFilter(label: string, f: ColumnFilter): string {
  const parts: string[] = []
  if (f.values) parts.push(f.values.length === 1 ? (f.values[0] || '(Blanks)') : `${f.values.length} values`)
  if (f.except?.length) parts.push(f.except.length === 1 ? `all but ${f.except[0] || '(Blanks)'}` : `all but ${f.except.length} values`)
  if (f.contains?.trim()) parts.push(`contains "${f.contains.trim()}"`)
  return `${label}: ${parts.join(', ')}`
}

type Values = { value: string; count: number }[]

export interface ColumnMenuProps {
  label: string
  filter: ColumnFilter | undefined
  sort: 'asc' | 'desc' | null
  /** Sort words for numbers and dates: smallest first, not A→Z. */
  numeric?: boolean
  onApply: (filter: ColumnFilter | undefined) => void
  onSort: (dir: 'asc' | 'desc' | null) => void
  /** The values, for a table that holds every row: worked out when the menu opens. */
  values?: () => Values
  /** The values from the server, for a table read page by page; `search` narrows them there. */
  loadValues?: (search: string) => Promise<ColumnValuesResponse>
  /** A column with no list of values (a long free text): sort and Contains only. */
  noValues?: boolean
  align?: 'left' | 'right'
  /** How a value reads in the list when it is stored otherwise (a day kept as 2026-10-06 reads Oct 6). */
  formatValue?: (value: string) => string
}

/** The small button in a header cell and the menu it opens. */
export function ColumnMenu({ label, filter, sort, numeric = false, onApply, onSort, values, loadValues, noValues = false, align = 'left', formatValue }: ColumnMenuProps) {
  const anchor = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const active = isActive(filter)
  return (
    <>
      <button
        ref={anchor}
        type="button"
        aria-label={`Sort and filter ${label}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={(e) => {
          e.stopPropagation()
          setOpen((o) => !o)
        }}
        data-tip={active ? describeFilter(label, filter!) : sort ? `Sorted ${sort === 'asc' ? (numeric ? 'smallest first' : 'A → Z') : numeric ? 'largest first' : 'Z → A'}` : `Sort and filter ${label}`}
        className={cn(
          'print-hidden inline-grid h-5 w-5 shrink-0 place-items-center rounded align-middle transition-colors touch:h-7 touch:w-7',
          active || sort ? 'bg-brand-100 text-brand-700 dark:bg-brand-500/20 dark:text-brand-300' : 'text-slate-400 hover:bg-slate-200/70 hover:text-slate-700 dark:text-slate-500 dark:hover:bg-slate-700 dark:hover:text-slate-200',
        )}
      >
        {active ? <Filter className="h-3 w-3" /> : sort === 'asc' ? <ArrowUpNarrowWide className="h-3 w-3" /> : sort === 'desc' ? <ArrowDownWideNarrow className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
      </button>
      {open && (
        <FloatingPanel anchor={anchor} open onClose={() => setOpen(false)} label={`Sort and filter ${label}`} width={290}>
          <MenuBody
            label={label}
            filter={filter}
            sort={sort}
            numeric={numeric}
            values={values}
            loadValues={loadValues}
            noValues={noValues}
            align={align}
            formatValue={formatValue}
            onSort={(d) => {
              onSort(d)
              setOpen(false)
            }}
            onApply={(f) => {
              onApply(f)
              setOpen(false)
            }}
            onCancel={() => setOpen(false)}
          />
        </FloatingPanel>
      )}
    </>
  )
}

function MenuBody({
  label,
  filter,
  sort,
  numeric,
  values,
  loadValues,
  noValues,
  formatValue,
  onSort,
  onApply,
  onCancel,
}: Omit<ColumnMenuProps, 'onApply' | 'onSort'> & { onSort: (d: 'asc' | 'desc' | null) => void; onApply: (f: ColumnFilter | undefined) => void; onCancel: () => void }) {
  // A draft: nothing reaches the table until OK. `only` the values in `set`, or every value `except` them.
  const [draft, setDraft] = useState<{ mode: 'only' | 'except'; set: string[] }>(() =>
    filter?.values ? { mode: 'only', set: filter.values } : { mode: 'except', set: filter?.except ?? [] },
  )
  const [contains, setContains] = useState(filter?.contains ?? '')
  const [search, setSearch] = useState('')
  const [remote, setRemote] = useState<{ values: Values; truncated: boolean } | null>(null)
  const [loading, setLoading] = useState(false)
  const [failed, setFailed] = useState(false)

  // The server's list, asked when the menu opens and again as the search settles —
  // not each time the page draws a new loader.
  const loader = useRef(loadValues)
  loader.current = loadValues
  const remoteList = !!loadValues
  useEffect(() => {
    if (!remoteList || noValues || !loader.current) return
    const load = loader.current
    let live = true
    setLoading(true)
    const t = window.setTimeout(() => {
      load(search.trim())
        .then((r) => live && (setRemote(r), setFailed(false)))
        .catch(() => live && setFailed(true))
        .finally(() => live && setLoading(false))
    }, search ? 250 : 0)
    return () => {
      live = false
      window.clearTimeout(t)
    }
  }, [remoteList, search, noValues])

  // A local list is worked out once, when the menu opens.
  const [local] = useState<Values>(() => (values ? values() : []))
  const list: Values = useMemo(() => {
    const base = loadValues ? (remote?.values ?? []) : local
    const shown = loadValues ? base : base.filter((v) => lower(v.value ? (formatValue ? formatValue(v.value) : v.value) : '(blanks)').includes(lower(search)))
    // A value the filter names that the list no longer carries stays, so it can be ticked or unticked again.
    const extra = draft.set.filter((t) => !shown.some((v) => v.value === t) && (!search || lower(t).includes(lower(search)))).map((value) => ({ value, count: 0 }))
    return [...shown, ...extra]
  }, [loadValues, remote, local, search, draft.set, formatValue])

  const isOn = (v: string) => (draft.mode === 'only' ? draft.set.includes(v) : !draft.set.includes(v))
  const allOn = list.length > 0 && list.every((v) => isOn(v.value))
  const toggle = (v: string) => setDraft((d) => ({ ...d, set: d.set.includes(v) ? d.set.filter((x) => x !== v) : [...d.set, v] }))
  const toggleAll = () => {
    if (search) {
      // Searching: (Select all) means every value found, as Excel's "Select all search results".
      const found = list.map((v) => v.value)
      const add = (d: string[]) => Array.from(new Set([...d, ...found]))
      const drop = (d: string[]) => d.filter((x) => !found.includes(x))
      // Ticking adds to `only` and takes out of `except`; unticking the other way round.
      setDraft((d) => ({ ...d, set: allOn === (d.mode === 'only') ? drop(d.set) : add(d.set) }))
    } else setDraft(allOn ? { mode: 'only', set: [] } : { mode: 'except', set: [] })
  }
  const apply = () => {
    const f: ColumnFilter = {}
    // With nothing searched and the whole list in hand, the shorter of "these" and "all but those" is sent.
    const whole = !search && !remote?.truncated && list.length > 0
    if (search && list.length > 0 && !loading) {
      // OK on a search keeps what the search found and is ticked, as Excel does.
      f.values = list.filter((v) => isOn(v.value)).map((v) => v.value)
    } else if (draft.mode === 'except') {
      if (draft.set.length) f.except = draft.set
    } else if (whole) {
      const unticked = list.map((v) => v.value).filter((v) => !draft.set.includes(v))
      if (unticked.length === 0) {
        // Every value ticked is no value filter.
      } else if (unticked.length < draft.set.length) f.except = unticked
      else f.values = draft.set
    } else f.values = draft.set
    if (contains.trim()) f.contains = contains.trim()
    onApply(isActive(f) ? f : undefined)
  }

  const AZ = numeric ? ['Smallest to largest', 'Largest to smallest'] : ['Sort A → Z', 'Sort Z → A']
  return (
    <div className="space-y-1 text-sm">
      <MenuRow on={sort === 'asc'} onClick={() => onSort(sort === 'asc' ? null : 'asc')} icon={<ArrowDownAZ className="h-4 w-4" />}>
        {AZ[0]}
      </MenuRow>
      <MenuRow on={sort === 'desc'} onClick={() => onSort(sort === 'desc' ? null : 'desc')} icon={<ArrowUpAZ className="h-4 w-4" />}>
        {AZ[1]}
      </MenuRow>
      <MenuRow on={false} disabled={!isActive(filter)} onClick={() => onApply(undefined)} icon={<FilterX className="h-4 w-4" />}>
        Clear filter from “{label}”
      </MenuRow>
      <div className="my-1 border-t border-slate-100 dark:border-slate-800" />
      <label className="block px-1">
        <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-muted">Text contains</span>
        <span className="flex items-center gap-1.5 rounded-lg bg-slate-50 px-2 ring-1 ring-slate-200 focus-within:ring-brand-400 dark:bg-slate-800 dark:ring-slate-700">
          <input value={contains} onChange={(e) => setContains(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && apply()} placeholder="Any part of the text" className="min-h-[34px] w-full bg-transparent text-sm outline-none" dir="auto" />
          {contains && (
            <button type="button" onClick={() => setContains('')} aria-label="Clear the text" className="text-muted hover:text-slate-700 dark:hover:text-slate-200">
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </span>
      </label>
      {!noValues && (
        <>
          <div className="my-1 border-t border-slate-100 dark:border-slate-800" />
          <label className="flex items-center gap-1.5 rounded-lg bg-slate-50 px-2 ring-1 ring-slate-200 focus-within:ring-brand-400 dark:bg-slate-800 dark:ring-slate-700">
            <Search className="h-3.5 w-3.5 shrink-0 text-muted" />
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search the values" aria-label={`Search the values of ${label}`} className="min-h-[34px] w-full bg-transparent text-sm outline-none" dir="auto" autoFocus />
          </label>
          <div className="max-h-60 overflow-auto rounded-lg ring-1 ring-slate-100 dark:ring-slate-800">
            {list.length > 0 && (
              <CheckRow on={allOn} onClick={toggleAll}>
                {search ? '(Select all search results)' : '(Select all)'}
              </CheckRow>
            )}
            {list.map((v) => (
              <CheckRow key={v.value} on={isOn(v.value)} onClick={() => toggle(v.value)} count={v.count}>
                {v.value ? (formatValue ? formatValue(v.value) : v.value) : <span className="text-muted">(Blanks)</span>}
              </CheckRow>
            ))}
            {list.length === 0 && <p className="px-2 py-3 text-center text-xs text-muted">{loading ? 'Loading the values…' : failed ? 'The values could not be loaded.' : 'Nothing matches.'}</p>}
          </div>
          {remote?.truncated && <p className="px-1 text-[11px] text-muted">Showing the first {remote.values.length.toLocaleString()} values — search to find the rest.</p>}
        </>
      )}
      <div className="flex justify-end gap-2 pt-1">
        <button type="button" onClick={onCancel} className="btn-secondary h-8 min-h-0 px-3 py-0 text-13 touch:h-11">
          Cancel
        </button>
        <button type="button" onClick={apply} className="btn-primary h-8 min-h-0 px-4 py-0 text-13 touch:h-11">
          OK
        </button>
      </div>
    </div>
  )
}

function MenuRow({ on, disabled, onClick, icon, children }: { on: boolean; disabled?: boolean; onClick: () => void; icon: ReactNode; children: ReactNode }) {
  return (
    <button type="button" disabled={disabled} onClick={onClick} className={cn('flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-slate-50 disabled:opacity-40 disabled:hover:bg-transparent dark:hover:bg-slate-800 touch:min-h-[44px]', on && 'font-semibold text-brand-700 dark:text-brand-300')}>
      <span className="text-muted">{icon}</span>
      <span className="min-w-0 flex-1">{children}</span>
      {on && <Check className="h-4 w-4" />}
    </button>
  )
}

function CheckRow({ on, onClick, children, count }: { on: boolean; onClick: () => void; children: ReactNode; count?: number }) {
  return (
    <button type="button" role="menuitemcheckbox" aria-checked={on} onClick={onClick} className="flex w-full items-center gap-2 px-2 py-1.5 text-left hover:bg-slate-50 dark:hover:bg-slate-800 touch:min-h-[40px]">
      <span className={cn('grid h-4 w-4 shrink-0 place-items-center rounded border', on ? 'border-brand-600 bg-brand-600 text-white' : 'border-slate-300 dark:border-slate-600')}>{on && <Check className="h-3 w-3" />}</span>
      <span className="min-w-0 flex-1 truncate" dir="auto">
        {children}
      </span>
      {count !== undefined && <span className="shrink-0 text-xs tabular-nums text-muted">{count.toLocaleString()}</span>}
    </button>
  )
}

// ---- A table that holds every row --------------------------------------------

export interface ViewColumn<T> {
  key: string
  /** The text the cell shows: what the menu lists, ticks and searches. */
  value: (r: T) => string
  /** The value it sorts by when it is not the text (a number, a date); null sorts last. */
  sortValue?: (r: T) => number | string | null
  /** Sort words for numbers and dates. */
  numeric?: boolean
  /** A long free text: sort and Contains, no list of values. */
  noValues?: boolean
}

export interface TableView<T> {
  /** The rows every filter lets through, in the sort chosen. */
  rows: T[]
  /** How many columns are filtered. */
  active: number
  filters: ColumnFilters
  sort: ColumnSort | null
  clear: () => void
  /** The header's menu button for a column. */
  button: (key: string, label: string, align?: 'left' | 'right') => ReactNode
}

/**
 * Excel's filter and sort over rows held in hand. A column lists the values
 * of the rows the other columns let through, with how many carry each.
 */
export function useTableView<T>(rows: T[], columns: ViewColumn<T>[]): TableView<T> {
  const [filters, setFilters] = useState<ColumnFilters>({})
  const [sort, setSort] = useState<ColumnSort | null>(null)
  const byKey = useMemo(() => new Map(columns.map((c) => [c.key, c])), [columns])
  const passes = (r: T, except?: string) => Object.entries(filters).every(([k, f]) => k === except || passesFilter(byKey.get(k)?.value(r) ?? '', f))

  const view = useMemo(() => {
    const kept = rows.filter((r) => passes(r))
    if (!sort) return kept
    const col = byKey.get(sort.key)
    if (!col) return kept
    const sign = sort.dir === 'asc' ? 1 : -1
    const keyOf = (r: T) => (col.sortValue ? col.sortValue(r) : col.value(r))
    return [...kept].sort((a, b) => {
      const x = keyOf(a)
      const y = keyOf(b)
      // Blanks last, whichever way.
      const xe = x === null || x === ''
      const ye = y === null || y === ''
      if (xe || ye) return xe === ye ? 0 : xe ? 1 : -1
      return sign * (typeof x === 'number' && typeof y === 'number' ? x - y : byText(String(x), String(y)))
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, filters, sort, byKey])

  const valuesOf = (key: string): Values => {
    const col = byKey.get(key)
    if (!col) return []
    const counts = new Map<string, { count: number; sortKey: number | string | null }>()
    for (const r of rows) {
      if (!passes(r, key)) continue
      const v = col.value(r)
      const seen = counts.get(v)
      if (seen) seen.count++
      else counts.set(v, { count: 1, sortKey: col.sortValue ? col.sortValue(r) : v })
    }
    return Array.from(counts, ([value, c]) => ({ value, count: c.count, k: c.sortKey }))
      .sort((a, b) => (typeof a.k === 'number' && typeof b.k === 'number' ? a.k - b.k : byText(String(a.k ?? ''), String(b.k ?? ''))))
      .map(({ value, count }) => ({ value, count }))
  }

  return {
    rows: view,
    active: Object.keys(filters).length,
    filters,
    sort,
    clear: () => setFilters({}),
    button: (key, label, align) => {
      const col = byKey.get(key)
      return (
        <ColumnMenu
          label={label}
          align={align}
          filter={filters[key]}
          sort={sort?.key === key ? sort.dir : null}
          numeric={col?.numeric}
          noValues={col?.noValues}
          values={() => valuesOf(key)}
          onApply={(f) =>
            setFilters((prev) => {
              const next = { ...prev }
              if (f) next[key] = f
              else delete next[key]
              return next
            })
          }
          onSort={(dir) => setSort(dir ? { key, dir } : null)}
        />
      )
    },
  }
}

/** A plain header cell with its label and its menu. */
export function ViewTh<T>({ view, column, label, className }: { view: TableView<T>; column: string; label: string; className?: string }) {
  const right = className?.includes('text-right')
  return (
    <th className={cn('whitespace-nowrap', className)}>
      <span className={cn('inline-flex items-center gap-1', right && 'flex-row-reverse')}>
        {label}
        {view.button(column, label, right ? 'right' : 'left')}
      </span>
    </th>
  )
}

/** Under a filtered table: how many rows show, and a way to show them all. */
export function ViewNote<T>({ view, total, className }: { view: TableView<T>; total: number; className?: string }) {
  if (view.active === 0) return null
  return (
    <p className={cn('print-hidden flex items-center justify-between gap-2 px-2 py-1.5 text-xs text-muted', className)}>
      <span>
        {view.rows.length.toLocaleString()} of {total.toLocaleString()} rows · {view.active} {view.active === 1 ? 'column' : 'columns'} filtered
      </span>
      <button type="button" onClick={view.clear} className="font-semibold text-brand-700 hover:underline dark:text-brand-300">
        Clear filters
      </button>
    </p>
  )
}

// ---- A table read page by page from the server ---------------------------------

export interface ServerColumnOptions {
  numeric?: boolean
  align?: 'left' | 'right'
  formatValue?: (value: string) => string
}

export interface ServerColumns {
  filters: ColumnFilters
  sort: ColumnSort | null
  /** For the request: the filters as JSON and the sort as "key:dir"; absent when unset. */
  cf: string | undefined
  sortParam: string | undefined
  active: boolean
  clear: () => void
  /** A chip per filtered column, to remove it from the filter row. */
  chips: (labelOf: (key: string) => string) => { key: string; label: string; onRemove: () => void }[]
  /** A column's menu; its values come from `load`. */
  menu: (key: string, label: string, load: (search: string) => Promise<ColumnValuesResponse>, options?: ServerColumnOptions) => ReactNode
}

/**
 * Excel's filter and sort for a list the server pages: the state and the
 * menus. The page sends `cf` and `sortParam` with its other filters, and asks
 * the server for a column's values with the same filters (the server leaves
 * the column's own filter out).
 */
export function useServerColumns(): ServerColumns {
  const [filters, setFilters] = useState<ColumnFilters>({})
  const [sort, setSort] = useState<ColumnSort | null>(null)
  const setFilter = (key: string, f: ColumnFilter | undefined) =>
    setFilters((prev) => {
      const next = { ...prev }
      if (f) next[key] = f
      else delete next[key]
      return next
    })
  const keys = Object.keys(filters)
  return {
    filters,
    sort,
    cf: keys.length ? JSON.stringify(filters) : undefined,
    sortParam: sort ? `${sort.key}:${sort.dir}` : undefined,
    active: keys.length > 0 || sort !== null,
    clear: () => {
      setFilters({})
      setSort(null)
    },
    chips: (labelOf) => [
      ...keys.map((k) => ({ key: `cf:${k}`, label: describeFilter(labelOf(k), filters[k]), onRemove: () => setFilter(k, undefined) })),
      ...(sort ? [{ key: 'sort', label: `Sorted by ${labelOf(sort.key)} ${sort.dir === 'asc' ? '↑' : '↓'}`, onRemove: () => setSort(null) }] : []),
    ],
    menu: (key, label, load, options) => (
      <ColumnMenu
        label={label}
        filter={filters[key]}
        sort={sort?.key === key ? sort.dir : null}
        numeric={options?.numeric}
        align={options?.align}
        formatValue={options?.formatValue}
        loadValues={load}
        onApply={(f) => setFilter(key, f)}
        onSort={(dir) => setSort(dir ? { key, dir } : null)}
      />
    ),
  }
}

