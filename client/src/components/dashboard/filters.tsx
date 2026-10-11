// ============================================================================
// Pick lists for the dashboard: a floating panel that escapes the widget's
// scroll box, a multi-select menu (the machines of a widget), and Excel-like
// column filters on a table's header row: tick the values a column may show,
// search them, or show them all again.
// ============================================================================

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { Check, ChevronDown, Search, X } from 'lucide-react'
import { cn, lockBodyScroll } from '@/lib/utils'
import { isCoarsePointer, PHONE, useMediaQuery } from '@/lib/media'
import { useTableView, ViewNote, ViewTh, type TableView, type ViewColumn } from '@/components/ui/ColumnFilter'

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

/** Compares names the way a person reads them: LM2 before LM2-Ext. before LM10. */
export const byName = (a: string, b: string): number => collator.compare(a, b)

const matches = (text: string, query: string): boolean => text.toLowerCase().includes(query.trim().toLowerCase())

/**
 * The panels open now, the last opened last. Escape closes the top one alone —
 * a pick list opened from another panel, or from a dialog, goes and leaves
 * what it was opened from — and goes no further: the dialog under it never
 * hears that Escape.
 */
interface OpenPanel {
  close: () => void
  element: RefObject<HTMLDivElement>
}
const openPanels: OpenPanel[] = []
function escapeTopPanel(e: KeyboardEvent) {
  if (e.key !== 'Escape' || openPanels.length === 0) return
  e.stopPropagation()
  openPanels[openPanels.length - 1].close()
}

/**
 * A panel fixed under (or above, when there is no room) its anchor, drawn on
 * the page body so a widget's own scroll box never clips it. Closes on a
 * click outside it or on Escape. On a phone it is a bottom sheet instead,
 * titled with `label`, over a dimmed page: the width of the screen, its
 * buttons in reach of a thumb, and a tap on the dimmed page closes it alone.
 *
 * Its element carries `data-floating-panel`, so a Modal or Drawer it opened
 * in can tell that a tap outside the panel was meant for the panel, not for
 * the dialog's own backdrop.
 */
export function FloatingPanel({ anchor, open, onClose, width = 260, label, children }: { anchor: RefObject<HTMLElement>; open: boolean; onClose: () => void; width?: number; label: string; children: ReactNode }) {
  const panel = useRef<HTMLDivElement>(null)
  const sheet = useMediaQuery(PHONE)
  const [pos, setPos] = useState<{ top: number; left: number; maxHeight: number } | null>(null)
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  const self = useRef<OpenPanel>({ close: () => closeRef.current(), element: panel }).current
  useLayoutEffect(() => {
    if (!open || sheet) return
    const place = () => {
      const a = anchor.current
      if (!a) return
      const r = a.getBoundingClientRect()
      // The panel's own height, not the height it was squeezed to last time.
      const h = panel.current?.scrollHeight ?? 320
      const left = Math.max(8, Math.min(r.left, window.innerWidth - width - 8))
      const below = window.innerHeight - r.bottom - 12
      const above = r.top - 12
      // Under the anchor when it fits, over it when only that fits; otherwise on
      // the roomier side, as tall as there is room, its content scrolling.
      if (h <= below || below >= above) setPos({ top: r.bottom + 4, left, maxHeight: Math.max(160, below) })
      else setPos({ top: Math.max(8, r.top - 4 - Math.min(h, above)), left, maxHeight: Math.max(160, above) })
    }
    // The page or a box around the anchor scrolling moves it; the panel's own list scrolling does not. Placed again
    // then, it would be measured at its full height — longer once its values have loaded — and jump to the other side
    // of the anchor under the finger scrolling it.
    const scrolled = (e: Event) => {
      if (e.target instanceof Node && panel.current?.contains(e.target)) return
      place()
    }
    place()
    window.addEventListener('resize', place)
    window.addEventListener('scroll', scrolled, true)
    return () => {
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', scrolled, true)
    }
  }, [open, anchor, width, sheet])
  useEffect(() => {
    if (!open) return
    openPanels.push(self)
    // Captured on the window, before anything below the panel can act on the key.
    if (openPanels.length === 1) window.addEventListener('keydown', escapeTopPanel, true)
    return () => {
      const at = openPanels.indexOf(self)
      if (at >= 0) openPanels.splice(at, 1)
      if (openPanels.length === 0) window.removeEventListener('keydown', escapeTopPanel, true)
    }
  }, [open, self])
  useEffect(() => {
    // The sheet's own backdrop takes a tap outside it: the tap closes the sheet and reaches nothing under it.
    if (!open || sheet) return
    const outside = (e: MouseEvent | TouchEvent) => {
      const target = e.target as Node
      if (panel.current?.contains(target) || anchor.current?.contains(target)) return
      // Inside a pick list opened from this panel (drawn apart, on the body) is not outside it.
      if (openPanels.slice(openPanels.indexOf(self) + 1).some((p) => p.element.current?.contains(target))) return
      onClose()
    }
    document.addEventListener('mousedown', outside)
    document.addEventListener('touchstart', outside)
    return () => {
      document.removeEventListener('mousedown', outside)
      document.removeEventListener('touchstart', outside)
    }
  }, [open, onClose, anchor, sheet, self])
  useEffect(() => {
    if (!open || !sheet) return
    return lockBodyScroll()
  }, [open, sheet])
  if (!open) return null
  if (sheet)
    return createPortal(
      <div data-floating-panel="" className="fixed inset-0 z-[60] flex flex-col justify-end">
        <div
          aria-hidden
          className="absolute inset-0 touch-none bg-slate-900/40 animate-fade-in"
          onClick={(e) => {
            // Only the sheet closes: the click goes no further up, in the page or in a dialog behind it.
            e.stopPropagation()
            onClose()
          }}
        />
        <div
          ref={panel}
          role="dialog"
          aria-label={label}
          className="relative max-h-[70vh] overflow-y-auto overscroll-contain rounded-t-3xl bg-white px-2 pb-2 text-sm normal-case tracking-normal text-slate-700 shadow-lift ring-1 ring-slate-200 animate-slide-up safe-bottom supports-[height:1dvh]:max-h-[70dvh] dark:bg-slate-900 dark:text-slate-200 dark:ring-slate-700"
        >
          <div className="sticky top-0 z-10 -mx-2 mb-1 flex items-center gap-2 bg-white py-1 pl-4 pr-3 dark:bg-slate-900">
            <p dir="auto" className="min-w-0 flex-1 truncate text-start text-sm font-bold text-slate-900 dark:text-slate-100">
              {label}
            </p>
            <button type="button" onClick={onClose} aria-label="Close" className="icon-btn shrink-0">
              <X className="h-5 w-5" />
            </button>
          </div>
          {children}
        </div>
      </div>,
      document.body,
    )
  return createPortal(
    <div
      ref={panel}
      data-floating-panel=""
      role="dialog"
      aria-label={label}
      style={{ position: 'fixed', top: pos?.top ?? -9999, left: pos?.left ?? -9999, width, maxHeight: pos?.maxHeight }}
      className="z-[60] overflow-y-auto overscroll-contain rounded-xl bg-white p-2 text-sm normal-case tracking-normal text-slate-700 shadow-xl ring-1 ring-slate-200 dark:bg-slate-900 dark:text-slate-200 dark:ring-slate-700"
    >
      {children}
    </div>,
    document.body,
  )
}

function CheckRow({ on, onClick, children, count }: { on: boolean; onClick: () => void; children: ReactNode; count?: number }) {
  return (
    <button type="button" role="menuitemcheckbox" aria-checked={on} onClick={onClick} className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-slate-50 dark:hover:bg-slate-800 touch:min-h-[44px]">
      <span className={cn('grid h-4 w-4 shrink-0 place-items-center rounded border', on ? 'border-brand-600 bg-brand-600 text-white' : 'border-slate-300 dark:border-slate-600')}>{on && <Check className="h-3 w-3" />}</span>
      {/* One line with a mouse; under a finger (the menu is a sheet there) a long machine name wraps to two instead of being cut. */}
      <span className="min-w-0 flex-1 truncate touch:line-clamp-2 touch:whitespace-normal touch:break-words touch:leading-snug" dir="auto">{children}</span>
      {count !== undefined && <span className="shrink-0 text-xs tabular-nums text-muted">{count}</span>}
    </button>
  )
}

/** The search at the top of a pick list. Ready to type under a mouse; on a touch screen it waits for a tap, so the keyboard does not cover the list. */
function SearchBox({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder: string }) {
  return (
    <label className="mb-1 flex items-center gap-1.5 rounded-lg bg-slate-50 px-2 ring-1 ring-slate-200 dark:bg-slate-800 dark:ring-slate-700">
      <Search className="h-3.5 w-3.5 shrink-0 text-muted" />
      <input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} aria-label={placeholder} className="min-h-[34px] w-full bg-transparent text-sm outline-none touch:min-h-[44px]" dir="auto" autoFocus={!isCoarsePointer()} />
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
        className={cn('print-hidden inline-flex min-h-[36px] max-w-[16rem] items-center gap-1.5 rounded-lg bg-white px-2.5 text-xs font-semibold ring-1 touch:min-h-[44px] ring-slate-200 hover:bg-slate-50 dark:bg-slate-900 dark:ring-slate-700 dark:hover:bg-slate-800', selected.length > 0 && 'text-brand-700 ring-brand-300 dark:text-brand-300 dark:ring-brand-500/50', className)}
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
        <button type="button" onClick={() => pick(null)} className={cn('w-full rounded-lg px-2 py-2 text-left text-sm hover:bg-slate-50 dark:hover:bg-slate-800 touch:min-h-[44px]', !value && 'font-semibold text-brand-700 dark:text-brand-300')}>
          {clearLabel}
        </button>
        <div className="my-1 border-t border-slate-100 dark:border-slate-800" />
        <div className="max-h-72 overflow-auto" role="listbox" aria-label={`${ariaLabel} options`}>
          {options.map((o) => {
            const on = value?.value === o.value
            return (
              <button key={o.value} type="button" role="option" aria-selected={on} onClick={() => pick(o)} className={cn('flex w-full items-start gap-2 rounded-lg px-2 py-2 text-left text-sm hover:bg-slate-50 dark:hover:bg-slate-800 touch:min-h-[44px]', on && 'bg-brand-50 dark:bg-brand-500/10')}>
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
// The dashboard's tables use the application's one column menu: sort, Text
// contains, and the values to tick (components/ui/ColumnFilter).

export interface FilterColumn<T> {
  key: string
  /** The text the column shows for a row: what the filter lists and matches. */
  value: (r: T) => string
  /** List and sort the values as numbers, smallest first. */
  numeric?: boolean
}

export type ColumnFilters<T> = TableView<T>

export function useColumnFilters<T>(rows: T[], columns: FilterColumn<T>[]): ColumnFilters<T> {
  // Built each render: a column's text may read figures of this render (a share of a total).
  const view = columns.map<ViewColumn<T>>((c) => ({
    key: c.key,
    value: c.value,
    numeric: c.numeric,
    sortValue: c.numeric
      ? (r) => {
          const text = String(c.value(r)).trim()
          const cleaned = text.replace(/[^0-9.+-]/g, '')
          const n = Number(cleaned)
          return cleaned !== '' && Number.isFinite(n) ? n : null
        }
      : undefined,
  }))
  return useTableView(rows, view)
}

/** A header cell with its label and its menu. */
export function FilterTh<T>({ filters, column, label, className }: { filters: ColumnFilters<T>; column: string; label: string; className?: string }) {
  return <ViewTh view={filters} column={column} label={label} className={cn('px-2 py-1.5 font-semibold', className)} />
}

/** Under a filtered table: how many rows show, and a way to show them all. */
export function FilterNote<T>({ filters, total }: { filters: ColumnFilters<T>; total: number }) {
  return <ViewNote view={filters} total={total} className="mt-2" />
}
