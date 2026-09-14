// ============================================================================
// A table the person shapes like a spreadsheet: columns dragged wider on a
// desktop so a long item name can be read in the row, and columns hidden
// so the ones that matter today get the width. Both are remembered on this
// device per table. A tablet or phone never sees the drag handles (no fine
// pointer to drag them with; the table keeps its automatic layout there)
// but can still choose which columns to show.
// ============================================================================

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactElement } from 'react'
import { Check, Columns3, RotateCcw } from 'lucide-react'
import { usePersistedState } from '@/lib/usePersistedState'
import { cn } from '@/lib/utils'

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
}

interface Stored {
  widths: Record<string, number>
  /** Only the columns the person changed from their default: true shown, false hidden. */
  shown: Record<string, boolean>
}

const DEFAULT_MIN = 56
const MAX_WIDTH = 1200
const DESKTOP = '(min-width: 1024px) and (pointer: fine)'

function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => typeof window !== 'undefined' && window.matchMedia?.(query).matches)
  useEffect(() => {
    const mq = window.matchMedia?.(query)
    if (!mq) return
    const onChange = () => setMatches(mq.matches)
    onChange()
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [query])
  return matches
}

const shownByDefault = (c: ColumnDef) => c.hideable === false || !c.defaultHidden

function visibleWith(columns: ColumnDef[], shown: Record<string, boolean>): ColumnDef[] {
  return columns.filter((c) => (c.hideable === false ? true : (shown[c.key] ?? shownByDefault(c))))
}

/** Whatever was saved, made safe: unknown keys dropped, widths clamped, at least one column left visible. */
function sanitise(raw: unknown, columns: ColumnDef[]): Stored {
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
    if (typeof v === 'boolean' && v !== shownByDefault(c)) out.shown[c.key] = v
  }
  // An earlier save kept a list of hidden keys; read it once, the same way.
  if (Array.isArray(r.hidden)) for (const k of r.hidden) if (typeof k === 'string' && columns.some((c) => c.key === k && c.hideable !== false && shownByDefault(c))) out.shown[k] = false
  if (visibleWith(columns, out.shown).every((c) => c.hideable === false)) out.shown = {}
  return out
}

export interface ResizableColumns {
  /** True on a desktop with a mouse: fixed layout and handles. False elsewhere: the table lays itself out. */
  enabled: boolean
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
}

export function useResizableColumns(storageKey: string, columns: ColumnDef[]): ResizableColumns {
  const enabled = useMediaQuery(DESKTOP)
  const [raw, setRaw] = usePersistedState<Partial<Stored>>(storageKey, { widths: {}, shown: {} })
  const stored = useMemo(() => sanitise(raw, columns), [raw, columns])
  const setStored = useCallback((fn: (prev: Stored) => Stored) => setRaw((prev) => fn(sanitise(prev, columns))), [setRaw, columns])
  const [dragging, setDragging] = useState<string | null>(null)
  const drag = useRef<{ key: string; startX: number; startWidth: number; min: number } | null>(null)

  const visible = useMemo(() => visibleWith(columns, stored.shown), [columns, stored.shown])
  const visibleKeys = useMemo(() => new Set(visible.map((c) => c.key)), [visible])
  const isVisible = useCallback((key: string) => visibleKeys.has(key), [visibleKeys])

  const widths = useMemo(() => {
    if (!enabled) return null
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
      if (!widths || e.button !== 0) return
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
    [widths, columns, onPointerMove, onPointerUp],
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
        const now = visibleWith(columns, prev.shown).some((c) => c.key === key)
        const shown = { ...prev.shown }
        if (!now === shownByDefault(col)) delete shown[key]
        else shown[key] = !now
        // The last visible column stays: an empty table says nothing.
        if (visibleWith(columns, shown).every((c) => c.hideable === false)) return prev
        return { ...prev, shown }
      }),
    [setStored, columns],
  )
  const resetAll = useCallback(() => setStored(() => ({ widths: {}, shown: {} })), [setStored])
  const customised = Object.keys(stored.shown).length > 0 || Object.keys(stored.widths).length > 0

  const tableStyle = useMemo<CSSProperties | undefined>(() => {
    if (!widths) return undefined
    const total = Object.values(widths).reduce((a, b) => a + b, 0)
    return { tableLayout: 'fixed', width: total, minWidth: total }
  }, [widths])

  const colgroup = useMemo(
    () =>
      widths ? (
        <colgroup>
          {visible.map((c) => (
            <col key={c.key} style={{ width: widths[c.key] }} />
          ))}
        </colgroup>
      ) : null,
    [widths, visible],
  )

  const handle = useCallback(
    (key: string) =>
      widths ? (
        <span
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize column"
          title="Drag to resize; double-click to reset"
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
    [widths, start, resetWidth, dragging],
  )

  return { enabled, visible, columns, isVisible, toggle, resetAll, customised, tableStyle, colgroup, handle, dragging }
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
        className={cn('btn-secondary min-h-[40px] px-3 text-xs', (open || grid.customised) && 'text-brand-700 dark:text-brand-200')}
      >
        <Columns3 className="h-4 w-4" /> Columns
        <span className="rounded-full bg-slate-200 px-1.5 text-[10px] font-bold leading-[16px] text-slate-700 dark:bg-slate-700 dark:text-slate-200">
          {shownCount}/{hideable.length}
        </span>
      </button>
      {open && (
        <div role="menu" className="absolute right-0 top-full z-30 mt-2 w-60 rounded-2xl bg-white p-1.5 shadow-lift ring-1 ring-slate-200 animate-drop-in dark:bg-slate-900 dark:ring-slate-800">
          <p className="px-3 pb-1 pt-2 text-[11px] font-bold uppercase tracking-[0.16em] text-slate-400">Show columns</p>
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
