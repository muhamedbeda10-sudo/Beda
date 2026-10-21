// ============================================================================
// A table the person shapes like a spreadsheet: columns dragged wider on a
// desktop so a long item name can be read in the row, and columns hidden
// so the ones that matter today get the width. Both are remembered on this
// device per table. Wherever the table shows (a tablet held upright and
// wider) it keeps its fixed layout at the declared widths, so a long machine
// name is cut to its column instead of pushing the status and the figures off
// the screen; only the drag handles want a mouse and a desktop's room. A
// narrower screen starts with a lean set of columns, and anyone can choose
// which columns to show.
// ============================================================================

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactElement, type ReactNode } from 'react'
import { Check, Columns3, RotateCcw, Scaling } from 'lucide-react'
import { useMediaQuery } from '@/lib/media'
import { usePersistedState } from '@/lib/usePersistedState'
import { cn } from '@/lib/utils'
import { scrollerOf } from '@/lib/appScroll'

export interface ColumnDef {
  key: string
  /** As written in the header and in the picker. */
  label: string
  /** Starting width in pixels; the person drags from here. */
  width: number
  /** The narrowest the column may be dragged to. */
  min?: number
  /** Right-aligned numbers. */
  align?: 'left' | 'right'
  /** False for a column that must stay (the row's open chevron). */
  hideable?: boolean
  /** Off until the person ticks it: there for the full picture, not for every day. */
  defaultHidden?: boolean
  /** The flexible text column (the item): it takes the width the others leave, so the table has no gaps between columns. */
  flex?: boolean
  /**
   * In the lean set a screen narrower than 1180 px starts with — a tablet held upright, a small window: the columns a
   * glance needs, few enough that the row's status is in view without scrolling. A table with no lean column shows its
   * everyday set at every width.
   */
  lean?: boolean
}

/** What a table keeps on this device: the widths dragged, and the columns shown or hidden by choice. */
export interface Stored {
  widths: Record<string, number>
  /** Only the columns the person changed from their default: true shown, false hidden. */
  shown: Record<string, boolean>
}

const DEFAULT_MIN = 56
const MAX_WIDTH = 1200
/** Where the pages show the table rather than their phone cards (`md:`): from here it keeps its fixed layout. */
export const TABLE_QUERY = '(min-width: 768px)'
/** Dragging a column's edge wants a mouse and a desktop's room: a finger has no edge to grab, and a tablet no width to spare. */
export const HANDLES_QUERY = '(min-width: 1024px) and (pointer: fine)'
/** Narrower than an iPad Air on its side (1180 px): the table starts with its lean set. */
export const LEAN_QUERY = 'not all and (min-width: 1180px)'

/** Whether a column shows until the person says otherwise: the everyday set, or the lean set on a narrower screen. */
export function shownByDefault(c: ColumnDef, lean = false): boolean {
  if (c.hideable === false) return true
  return lean ? !!c.lean : !c.defaultHidden
}

/** The columns on screen: each as the person set it, otherwise as its default for the width. */
export function visibleWith(columns: ColumnDef[], shown: Record<string, boolean>, lean = false): ColumnDef[] {
  return columns.filter((c) => (c.hideable === false ? true : (shown[c.key] ?? shownByDefault(c, lean))))
}

/**
 * Whether a choice for a column is worth keeping: it differs from the column's default at some width. A choice is
 * kept as made, so a column ticked on a tablet held upright is still there when it turns on its side.
 */
function matters(c: ColumnDef, value: boolean, columns: ColumnDef[]): boolean {
  return value !== shownByDefault(c) || (columns.some((x) => x.lean) && value !== shownByDefault(c, true))
}

/** Whatever was saved, made safe: unknown keys dropped, widths clamped, at least one column left visible. */
export function sanitise(raw: unknown, columns: ColumnDef[], lean = false): Stored {
  const out: Stored = { widths: {}, shown: {} }
  if (!raw || typeof raw !== 'object') return out
  const r = raw as Partial<Stored> & { hidden?: unknown }
  const widths = r.widths && typeof r.widths === 'object' ? r.widths : {}
  for (const c of columns) {
    const v = (widths as Record<string, unknown>)[c.key]
    if (typeof v === 'number' && Number.isFinite(v)) out.widths[c.key] = Math.min(MAX_WIDTH, Math.max(c.min ?? DEFAULT_MIN, Math.round(v)))
  }
  const shown = r.shown && typeof r.shown === 'object' ? (r.shown as Record<string, unknown>) : {}
  for (const c of columns) {
    if (c.hideable === false) continue
    const v = shown[c.key]
    if (typeof v === 'boolean' && matters(c, v, columns)) out.shown[c.key] = v
  }
  // An earlier save kept a list of hidden keys; read it once, the same way.
  if (Array.isArray(r.hidden)) for (const k of r.hidden) if (typeof k === 'string' && columns.some((c) => c.key === k && c.hideable !== false && shownByDefault(c))) out.shown[k] = false
  if (visibleWith(columns, out.shown, lean).every((c) => c.hideable === false)) out.shown = {}
  return out
}

export interface ResizableColumns {
  /**
   * True wherever the table shows (a tablet held upright and wider, any pointer): fixed layout at the declared
   * widths, each cell cut to its column. False below, where the page shows its cards instead.
   */
  enabled: boolean
  /** True on a desktop with a mouse: the drag handles and "Fit columns to content". */
  handles: boolean
  /** The columns on screen, in order. */
  visible: ColumnDef[]
  /** Every column, for the picker. */
  columns: ColumnDef[]
  isVisible: (key: string) => boolean
  toggle: (key: string) => void
  /** Every column back to its default (the everyday set shown, the extras hidden), at its starting width. */
  resetAll: () => void
  /** Anything to undo: a hidden column or a dragged width. */
  customised: boolean
  /** Style for the table: fixed layout at the sum of the visible widths, so a wider column pushes the table rather than squeezing its neighbours. */
  tableStyle: CSSProperties | undefined
  /** The `<colgroup>` to render first inside the table. */
  colgroup: ReactElement | null
  /** The handle to render inside a `relative` header cell. */
  handle: (key: string) => ReactElement | null
  /** Which column is being dragged, for a header highlight. */
  dragging: string | null
  /** Put on the `<table>`: the fit reads the columns' natural widths from it. */
  tableRef: (el: HTMLTableElement | null) => void
  /** Size every visible column to its content, once, and remember it. */
  autoFit: () => void
  /** True for the one render in which the table lays itself out to be measured. */
  fitting: boolean
}

export function useResizableColumns(storageKey: string, columns: ColumnDef[]): ResizableColumns {
  const enabled = useMediaQuery(TABLE_QUERY)
  const handles = useMediaQuery(HANDLES_QUERY)
  const narrow = useMediaQuery(LEAN_QUERY)
  const lean = narrow && columns.some((c) => c.lean)
  const [raw, setRaw] = usePersistedState<Partial<Stored>>(storageKey, { widths: {}, shown: {} })
  const stored = useMemo(() => sanitise(raw, columns, lean), [raw, columns, lean])
  const setStored = useCallback((fn: (prev: Stored) => Stored) => setRaw((prev) => fn(sanitise(prev, columns, lean))), [setRaw, columns, lean])
  const [dragging, setDragging] = useState<string | null>(null)
  const drag = useRef<{ key: string; startX: number; startWidth: number; min: number } | null>(null)
  const table = useRef<HTMLTableElement | null>(null)
  const tableRef = useCallback((el: HTMLTableElement | null) => {
    table.current = el
  }, [])
  const [fitting, setFitting] = useState(false)

  const visible = useMemo(() => visibleWith(columns, stored.shown, lean), [columns, stored.shown, lean])
  const visibleKeys = useMemo(() => new Set(visible.map((c) => c.key)), [visible])
  const isVisible = useCallback((key: string) => visibleKeys.has(key), [visibleKeys])

  const widths = useMemo(() => {
    if (!enabled || fitting) return null
    const out: Record<string, number> = {}
    for (const c of visible) out[c.key] = stored.widths[c.key] ?? c.width
    return out
  }, [enabled, visible, stored.widths])

  const onPointerMove = useCallback(
    (e: PointerEvent) => {
      const d = drag.current
      if (!d) return
      const next = Math.min(MAX_WIDTH, Math.max(d.min, Math.round(d.startWidth + (e.clientX - d.startX))))
      setStored((prev) => (prev.widths[d.key] === next ? prev : { ...prev, widths: { ...prev.widths, [d.key]: next } }))
    },
    [setStored],
  )
  const onPointerUp = useCallback(() => {
    drag.current = null
    setDragging(null)
    document.body.style.userSelect = ''
    document.body.style.cursor = ''
    window.removeEventListener('pointermove', onPointerMove)
    window.removeEventListener('pointerup', onPointerUp)
    window.removeEventListener('pointercancel', onPointerUp)
  }, [onPointerMove])
  // A component unmounting mid-drag leaves nothing behind on the window.
  useEffect(() => () => onPointerUp(), [onPointerUp])

  const start = useCallback(
    (key: string, e: ReactPointerEvent<HTMLSpanElement>) => {
      if (!widths || !handles || e.button !== 0) return
      e.preventDefault()
      e.stopPropagation()
      const col = columns.find((c) => c.key === key)
      drag.current = { key, startX: e.clientX, startWidth: widths[key], min: col?.min ?? DEFAULT_MIN }
      setDragging(key)
      document.body.style.userSelect = 'none'
      document.body.style.cursor = 'col-resize'
      window.addEventListener('pointermove', onPointerMove)
      window.addEventListener('pointerup', onPointerUp)
      window.addEventListener('pointercancel', onPointerUp)
    },
    [widths, handles, columns, onPointerMove, onPointerUp],
  )

  /** Back to the starting width for one column. */
  const resetWidth = useCallback(
    (key: string) =>
      setStored((prev) => {
        if (!(key in prev.widths)) return prev
        const { [key]: _gone, ...rest } = prev.widths
        return { ...prev, widths: rest }
      }),
    [setStored],
  )

  const toggle = useCallback(
    (key: string) =>
      setStored((prev) => {
        const col = columns.find((c) => c.key === key)
        if (!col || col.hideable === false) return prev
        const now = visibleWith(columns, prev.shown, lean).some((c) => c.key === key)
        const shown = { ...prev.shown }
        // Kept as chosen, at every width; a choice that changes nothing at any width is not kept at all.
        if (matters(col, !now, columns)) shown[key] = !now
        else delete shown[key]
        // The last visible column stays: an empty table says nothing.
        if (visibleWith(columns, shown, lean).every((c) => c.hideable === false)) return prev
        return { ...prev, shown }
      }),
    [setStored, columns, lean],
  )
  const resetAll = useCallback(() => setStored(() => ({ widths: {}, shown: {} })), [setStored])

  // Fit: one render with the table's own layout, then every header's width is read and kept.
  const autoFit = useCallback(() => {
    if (enabled && handles) setFitting(true)
  }, [enabled, handles])
  useLayoutEffect(() => {
    if (!fitting) return
    const el = table.current
    const next: Record<string, number> = {}
    if (el) {
      for (const th of Array.from(el.querySelectorAll<HTMLTableCellElement>('thead th[data-col]'))) {
        const key = th.dataset.col!
        const col = columns.find((c) => c.key === key)
        // The fixed columns (the row's chevron) keep their width.
        if (!col || col.hideable === false) continue
        // A little air past the content, so the last letter is not against the edge.
        next[key] = Math.min(MAX_WIDTH, Math.max(col.min ?? DEFAULT_MIN, Math.ceil(th.getBoundingClientRect().width) + 8))
      }
    }
    setStored((prev) => ({ ...prev, widths: { ...prev.widths, ...next } }))
    setFitting(false)
  }, [fitting, columns, setStored])
  const customised = Object.keys(stored.shown).length > 0 || Object.keys(stored.widths).length > 0

  // Fixed layout at the sum of the widths; when the frame is wider than that,
  // the table takes the frame and the extra is shared out, so a few columns
  // fill the width rather than huddling on the left.
  const tableStyle = useMemo<CSSProperties | undefined>(() => {
    // The measuring render: the table's own layout at its natural width, so each column is as wide as its content.
    if (fitting) return { tableLayout: 'auto', width: 'auto', minWidth: 0 }
    if (!widths) return undefined
    const total = Object.values(widths).reduce((a, b) => a + b, 0)
    return { tableLayout: 'fixed', width: '100%', minWidth: total }
  }, [widths, fitting])

  // The flexible column has no set width unless the person dragged it: a fixed table gives it the room the others leave.
  const colgroup = useMemo(
    () =>
      widths ? (
        <colgroup>
          {visible.map((c) => (
            <col key={c.key} style={c.flex && stored.widths[c.key] === undefined ? undefined : { width: widths[c.key] }} />
          ))}
        </colgroup>
      ) : null,
    [widths, visible, stored.widths],
  )

  const handle = useCallback(
    (key: string) =>
      widths && handles ? (
        <span
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize column"
          data-tip="Drag to resize; double-click to reset"
          onPointerDown={(e) => start(key, e)}
          onDoubleClick={(e) => {
            e.stopPropagation()
            resetWidth(key)
          }}
          onClick={(e) => e.stopPropagation()}
          className={cn(
            'absolute inset-y-0 -right-1 z-10 w-2 cursor-col-resize select-none touch-none',
            'after:absolute after:inset-y-1.5 after:left-[3px] after:w-0.5 after:rounded-full after:bg-slate-300 after:opacity-0 after:transition-opacity hover:after:opacity-100 dark:after:bg-slate-600',
            dragging === key && 'after:bg-brand-500 after:opacity-100',
          )}
        />
      ) : null,
    [widths, handles, start, resetWidth, dragging],
  )

  return { enabled, handles, visible, columns, isVisible, toggle, resetAll, customised, tableStyle, colgroup, handle, dragging, tableRef, autoFit, fitting }
}

/** Sizes every column to its content; a desktop control, beside the picker. */
export function FitColumnsButton({ grid, className }: { grid: ResizableColumns; className?: string }) {
  if (!grid.handles) return null
  return (
    <button type="button" onClick={grid.autoFit} className={cn('btn-secondary min-h-[40px] px-3 text-xs', className)} data-tip="Size every column to what is in it">
      <Scaling className="h-4 w-4" /> Fit columns
    </button>
  )
}

/**
 * The room what follows `el` takes on the page, down to the end of <main>: at each level, from the box's own bottom
 * to the bottom of its last sibling below it (a list's footer and the gap above it), then the padding and border that
 * close the box around it — main's bottom padding and a phone's safe area among them. None of it depends on how tall
 * `el` is, so a frame can be sized to leave exactly that room under it.
 */
export function spaceAfter(el: Element): number {
  let total = 0
  let node: Element = el
  while (node.parentElement && node !== document.body) {
    const parent: Element = node.parentElement
    const from = node.getBoundingClientRect().bottom
    let to = from
    for (let sib = node.nextElementSibling; sib; sib = sib.nextElementSibling) {
      // Nothing drawn (display: none, the phone cards on a tablet), or out of the flow (a portal's anchor, a popover).
      if (sib.getClientRects().length === 0) continue
      const position = getComputedStyle(sib).position
      if (position === 'absolute' || position === 'fixed') continue
      to = Math.max(to, sib.getBoundingClientRect().bottom)
    }
    const box = getComputedStyle(parent)
    total += to - from + (parseFloat(box.paddingBottom) || 0) + (parseFloat(box.borderBottomWidth) || 0)
    if (parent.tagName === 'MAIN' || parent.hasAttribute?.('data-app-scroll')) break
    node = parent
  }
  return total
}

/**
 * The room `el` may take to fill the window: from where it starts (as the page is laid out, whatever it is scrolled
 * to now) down to the bottom of the box the page scrolls in — the shell's <main> (lib/appScroll), or the window where
 * there is none — less what follows it on the page (spaceAfter).
 */
export function roomBelow(el: HTMLElement): number {
  const top = el.getBoundingClientRect().top
  const scroller = scrollerOf(el)
  if (scroller) {
    const box = scroller.getBoundingClientRect()
    return scroller.clientHeight - (top - box.top - scroller.clientTop + scroller.scrollTop) - spaceAfter(el)
  }
  return window.innerHeight - (top + window.scrollY) - spaceAfter(el)
}

/**
 * The frame a wide table scrolls in. Its height runs from where it sits on
 * the page to the bottom of the window, less what follows it (the list's
 * footer, the page's bottom padding), so the header stays put, both
 * scrollbars are on screen however many columns are shown, and the page
 * itself ends with the window instead of scrolling a little further.
 */
export function GridFrame({ children, className }: { children: ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null)
  const [maxHeight, setMaxHeight] = useState<number | undefined>(undefined)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const measure = () => setMaxHeight(Math.max(256, Math.floor(roomBelow(el))))
    measure()
    window.addEventListener('resize', measure)
    // The page's content, not the window: a row of filter chips above the frame, or a footer that wraps below it,
    // moves the room the frame has.
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null
    ro?.observe(scrollerOf(el) ?? el.closest('main') ?? document.body)
    return () => {
      window.removeEventListener('resize', measure)
      ro?.disconnect()
    }
  }, [])
  return (
    <div ref={ref} className={cn('grid-scroll', className)} style={{ maxHeight }}>
      {children}
    </div>
  )
}

/** The "Columns" button and its list: tick a column to show it, untick to hide it; one control resets widths and hidden columns together. */
export function ColumnPicker({ grid, className }: { grid: ResizableColumns; className?: string }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])
  const hideable = grid.columns.filter((c) => c.hideable !== false)
  const shownCount = hideable.filter((c) => grid.isVisible(c.key)).length
  return (
    <div ref={ref} className={cn('relative', className)}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Columns"
        data-tip="Choose the columns"
        className={cn('btn-secondary h-10 min-h-0 gap-1.5 px-2.5 py-0 text-xs', (open || grid.customised) && 'text-brand-700 dark:text-brand-200')}
      >
        {/* The word only where the row has room for it; the icon and the count say it everywhere. */}
        <Columns3 className="h-4 w-4" /> <span className="hidden 2xl:inline">Columns</span>
        <span className="rounded-full bg-slate-200 px-1.5 text-[10px] font-bold leading-[16px] text-slate-700 dark:bg-slate-700 dark:text-slate-200">
          {shownCount}/{hideable.length}
        </span>
      </button>
      {open && (
        <div role="menu" className="absolute right-0 top-full z-50 mt-2 w-60 rounded-2xl bg-white p-1.5 shadow-lift ring-1 ring-slate-200 animate-drop-in dark:bg-slate-900 dark:ring-slate-800">
          <p className="px-3 pb-1 pt-2 text-[11px] font-bold uppercase tracking-[0.16em] text-muted">Show columns</p>
          <ul className="max-h-80 overflow-y-auto">
            {hideable.map((c) => {
              const on = grid.isVisible(c.key)
              return (
                <li key={c.key}>
                  <button
                    type="button"
                    role="menuitemcheckbox"
                    aria-checked={on}
                    onClick={() => grid.toggle(c.key)}
                    className="flex min-h-[40px] w-full items-center gap-3 rounded-xl px-3 text-left text-sm font-medium text-slate-700 hover:bg-slate-100 dark:text-slate-200 dark:hover:bg-slate-800"
                  >
                    <span className={cn('grid h-5 w-5 shrink-0 place-items-center rounded-md ring-1', on ? 'bg-brand-600 text-white ring-brand-600' : 'ring-slate-300 dark:ring-slate-600')}>
                      {on && <Check className="h-3.5 w-3.5" />}
                    </span>
                    {c.label}
                  </button>
                </li>
              )
            })}
          </ul>
          <div className="mt-1 border-t border-slate-100 pt-1 dark:border-slate-800">
            {grid.handles && (
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  grid.autoFit()
                  setOpen(false)
                }}
                className="flex min-h-[40px] w-full items-center gap-3 rounded-xl px-3 text-left text-sm font-medium text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"
              >
                <Scaling className="h-4 w-4" /> Fit columns to content
              </button>
            )}
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                grid.resetAll()
                setOpen(false)
              }}
              disabled={!grid.customised}
              className="flex min-h-[40px] w-full items-center gap-3 rounded-xl px-3 text-left text-sm font-medium text-slate-600 hover:bg-slate-100 disabled:opacity-40 dark:text-slate-300 dark:hover:bg-slate-800"
            >
              <RotateCcw className="h-4 w-4" /> Back to the default set and widths
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

/**
 * The header row of a resizable table. A label runs to two lines rather than
 * being cut; its full text is the tooltip. Numbers are right-aligned under a
 * right-aligned label.
 */
/** The header row; `menu` puts a column's Excel menu beside its title. */
export function GridHead({ grid, menu }: { grid: ResizableColumns; menu?: (column: ColumnDef) => ReactNode }) {
  return (
    <thead>
      <tr className="border-b border-slate-200 text-left text-[11px] font-bold uppercase tracking-wide text-muted dark:border-slate-800">
        {grid.visible.map((c) => {
          const button = c.label && menu ? menu(c) : null
          return (
            // The cell stays overflow-visible so the grab zone can straddle its edge.
            <th
              key={c.key}
              data-col={c.key}
              className={cn('px-3 py-2 align-bottom', c.align === 'right' && 'text-right', grid.dragging === c.key && '!bg-brand-50 dark:!bg-brand-950')}
            >
              <span className={cn('flex items-end gap-1', c.align === 'right' && 'flex-row-reverse')}>
                {/* Wraps between words only: a title never splits mid-word. */}
                <span className="line-clamp-2 min-w-0 whitespace-normal leading-tight [overflow-wrap:normal] [word-break:keep-all]" data-tip={c.label || undefined}>
                  {c.label}
                </span>
                {button}
              </span>
              {c.hideable !== false && grid.handle(c.key)}
            </th>
          )
        })}
      </tr>
    </thead>
  )
}

/** Rows of grey bars where a list is still loading, one cell per visible column. */
export function SkeletonRows({ grid, rows = 8 }: { grid: ResizableColumns; rows?: number }) {
  return (
    <tbody aria-hidden>
      {Array.from({ length: rows }, (_, i) => (
        <tr key={i} className="data-row border-b border-slate-100 dark:border-slate-800">
          {grid.visible.map((c) => (
            <td key={c.key} className="px-3">
              <span className={cn('skeleton block h-3', c.align === 'right' ? 'ml-auto w-10' : c.flex ? 'w-3/4' : 'w-2/3')} />
            </td>
          ))}
        </tr>
      ))}
    </tbody>
  )
}

/**
 * Under a list: which rows are on screen of how many ("1–100 of 1,351"), the
 * next page, and how many rows a page brings.
 */
export function TableFooter({
  shown,
  total,
  noun,
  hasMore,
  loadingMore,
  onMore,
  pageSize,
  onPageSize,
  extra,
}: {
  shown: number
  total: number | null
  noun: string
  hasMore: boolean
  loadingMore: boolean
  onMore: () => void
  pageSize: number
  onPageSize: (n: number) => void
  /** More figures beside the count ("2 open  25 closed"), set apart by space rather than dots, which a wrapped line would start with. */
  extra?: ReactNode
}) {
  const of = total ?? shown
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-3 py-2 text-13 text-muted">
      <span>
        {shown === 0 ? (
          <>No {noun}</>
        ) : (
          <>
            <span className="font-semibold tabular-nums text-slate-900 dark:text-slate-100">1–{shown.toLocaleString()}</span> of{' '}
            <span className="font-semibold tabular-nums text-slate-900 dark:text-slate-100">{of.toLocaleString()}</span> {noun}
          </>
        )}
      </span>
      {extra && <span className="flex flex-wrap items-center gap-x-3 gap-y-2">{extra}</span>}
      {/* A finger gets 44 px for the next page and the page size, as on the PDI list. */}
      {hasMore && (
        <button type="button" onClick={onMore} disabled={loadingMore} className="btn-secondary h-8 min-h-0 px-3 py-0 text-13 touch:h-11">
          {loadingMore ? 'Loading…' : `Show the next ${Math.min(pageSize, Math.max(0, of - shown) || pageSize).toLocaleString()}`}
        </button>
      )}
      <label className="ml-auto inline-flex items-center gap-2">
        Rows per page
        <select value={pageSize} onChange={(e) => onPageSize(Number(e.target.value))} className="input h-8 !w-auto py-0 pl-2 pr-7 text-13 touch:h-11" aria-label="Rows per page">
          {PAGE_SIZES.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
      </label>
    </div>
  )
}

/** The page sizes a list offers; the API returns at most 500 a page. */
export const PAGE_SIZES = [50, 100, 200] as const
