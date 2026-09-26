// ============================================================================
// §15 — the board: the dashboard's charts on a 12-column grid an administrator
// can rearrange. Each widget keeps its own scroll inside its box, so a small
// box still shows a whole chart. On a narrow screen the grid gives way to a
// stack in the layout's reading order: nothing to drag on a tablet.
// ============================================================================

import { createContext, useContext, useMemo, type ReactNode, type RefObject } from 'react'
import { GridLayout, useContainerWidth, verticalCompactor, type Layout } from 'react-grid-layout'
import 'react-grid-layout/css/styles.css'
import { GripVertical } from 'lucide-react'
import { DASHBOARD_COLS, DASHBOARD_ROW_HEIGHT, normaliseDashboardLayout, type DashboardLayoutItem, type DashboardLayouts, type DashboardPage } from '@qc/shared/kpi'
import { cn } from '@/lib/utils'
import { ChartFillContext } from './charts'

export interface BoardWidget {
  id: string
  title: string
  node: ReactNode
}

export interface BoardState {
  layouts: DashboardLayouts
  /** True while an administrator is moving things: handles show and the grid takes drags. */
  editing: boolean
  setLayout: (page: DashboardPage, layout: DashboardLayoutItem[]) => void
}

export const BoardContext = createContext<BoardState>({ layouts: { general: [], details: [] }, editing: false, setLayout: () => {} })

/** Below this width the grid is a stack: phones and tablets read, they do not arrange. */
const GRID_MIN_WIDTH = 1024

export function Board({ page, widgets, className }: { page: DashboardPage; widgets: BoardWidget[]; className?: string }) {
  const { layouts, editing, setLayout } = useContext(BoardContext)
  const { width, containerRef, mounted } = useContainerWidth()
  // The library types the ref for React 19; React 18's ref attribute wants the older shape.
  const ref = containerRef as unknown as RefObject<HTMLDivElement>
  const ids = widgets.map((w) => w.id).join('|')
  // The layout of the widgets on screen: a widget with no place yet gets one below the rest.
  const layout = useMemo(() => {
    const present = new Set(ids.split('|'))
    return normaliseDashboardLayout(page, layouts[page]).filter((it) => present.has(it.i))
  }, [layouts, page, ids])
  const order = useMemo(() => [...layout].sort((a, b) => a.y - b.y || a.x - b.x).map((it) => it.i), [layout])
  const byId = new Map(widgets.map((w) => [w.id, w]))
  const stacked = mounted && width < GRID_MIN_WIDTH

  if (stacked) {
    return (
      <div ref={ref} className={cn('space-y-4', className)}>
        {order.map((id) => {
          const w = byId.get(id)
          // One scroll per widget here too: the box caps the height and the section body scrolls inside it.
          return w ? <div key={id} className="flex max-h-[36rem] flex-col">{w.node}</div> : null
        })}
      </div>
    )
  }
  return (
    <div ref={ref} className={cn('-mx-2', className)}>
      {mounted && (
        <GridLayout
          width={width}
          layout={layout as Layout}
          gridConfig={{ cols: DASHBOARD_COLS, rowHeight: DASHBOARD_ROW_HEIGHT, margin: [16, 16], containerPadding: [8, 0] }}
          dragConfig={{ enabled: editing, handle: '.board-handle' }}
          resizeConfig={{ enabled: editing, handles: ['se'] }}
          compactor={verticalCompactor}
          onLayoutChange={(next) => {
            if (editing) setLayout(page, next.map((it) => ({ i: it.i, x: it.x, y: it.y, w: it.w, h: it.h })))
          }}
        >
          {layout.map((it) => {
            const w = byId.get(it.i)
            return (
              <div key={it.i} className={cn('flex min-h-0 flex-col', editing && 'rounded-2xl ring-2 ring-dashed ring-brand-300 dark:ring-brand-500/50')}>
                {editing && (
                  <div className="board-handle flex shrink-0 cursor-move items-center gap-1.5 rounded-t-2xl bg-brand-600 px-3 py-1 text-xs font-semibold text-white">
                    <GripVertical className="h-3.5 w-3.5" /> {w?.title ?? it.i}
                    <span className="ml-auto font-normal opacity-80">drag to move · pull the corner to size</span>
                  </div>
                )}
                <div className="min-h-0 flex-1"><ChartFillContext.Provider value>{w?.node}</ChartFillContext.Provider></div>
              </div>
            )
          })}
        </GridLayout>
      )}
    </div>
  )
}
