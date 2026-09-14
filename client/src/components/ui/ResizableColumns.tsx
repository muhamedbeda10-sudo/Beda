// ============================================================================
// Columns a person drags wider on a desktop, the way a spreadsheet does, so a
// long item name can be read in the row instead of opened. The widths are
// remembered on this device per table. A tablet or phone never sees the
// handles: there is no fine pointer to drag them with, and the table keeps
// its automatic layout there.
// ============================================================================

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactElement } from 'react'
import { usePersistedState } from '@/lib/usePersistedState'
import { cn } from '@/lib/utils'

export interface ColumnDef {
  key: string
  /** Starting width in pixels; the person drags from here. */
  width: number
  /** The narrowest the column may be dragged to. */
  min?: number
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

export interface ResizableColumns {
  /** True on a desktop with a mouse: fixed layout and handles. False elsewhere: the table lays itself out. */
  enabled: boolean
  /** Width per column key, only while enabled. */
  widths: Record<string, number> | null
  /** Style for the table: fixed layout at the sum of the widths, so a wider column pushes the table rather than squeezing its neighbours. */
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
  const [stored, setStored] = usePersistedState<Record<string, number>>(storageKey, {})
  const [dragging, setDragging] = useState<string | null>(null)
  const drag = useRef<{ key: string; startX: number; startWidth: number; min: number } | null>(null)

  const widths = useMemo(() => {
    if (!enabled) return null
    const out: Record<string, number> = {}
    for (const c of columns) {
      const min = c.min ?? DEFAULT_MIN
      const saved = stored[c.key]
      out[c.key] = typeof saved === 'number' && Number.isFinite(saved) ? Math.min(MAX_WIDTH, Math.max(min, Math.round(saved))) : c.width
    }
    return out
  }, [enabled, columns, stored])

  const onPointerMove = useCallback(
    (e: PointerEvent) => {
      const d = drag.current
      if (!d) return
      const next = Math.min(MAX_WIDTH, Math.max(d.min, Math.round(d.startWidth + (e.clientX - d.startX))))
      setStored((prev) => (prev[d.key] === next ? prev : { ...prev, [d.key]: next }))
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
  const reset = useCallback(
    (key: string) =>
      setStored((prev) => {
        if (!(key in prev)) return prev
        const { [key]: _gone, ...rest } = prev
        return rest
      }),
    [setStored],
  )

  const tableStyle = useMemo<CSSProperties | undefined>(() => {
    if (!widths) return undefined
    const total = Object.values(widths).reduce((a, b) => a + b, 0)
    return { tableLayout: 'fixed', width: total, minWidth: total }
  }, [widths])

  const colgroup = useMemo(
    () =>
      widths ? (
        <colgroup>
          {columns.map((c) => (
            <col key={c.key} style={{ width: widths[c.key] }} />
          ))}
        </colgroup>
      ) : null,
    [widths, columns],
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
            reset(key)
          }}
          onClick={(e) => e.stopPropagation()}
          className={cn(
            'absolute inset-y-0 -right-1 z-10 w-2 cursor-col-resize select-none touch-none',
            'after:absolute after:inset-y-1.5 after:left-[3px] after:w-0.5 after:rounded-full after:bg-slate-300 after:opacity-0 after:transition-opacity hover:after:opacity-100 dark:after:bg-slate-600',
            dragging === key && 'after:bg-brand-500 after:opacity-100',
          )}
        />
      ) : null,
    [widths, start, reset, dragging],
  )

  return { enabled, widths, tableStyle, colgroup, handle, dragging }
}
