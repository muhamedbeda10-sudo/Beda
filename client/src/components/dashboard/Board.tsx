// ============================================================================
// §15 — the board: the dashboard's charts on a 12-column grid an administrator
// can rearrange. Each widget keeps its own scroll inside its box, so a small
// box still shows a whole chart. On a narrow screen the grid gives way to a
// stack in the layout's reading order: nothing to drag on a tablet.
// ============================================================================

import { createContext, useContext, useMemo, useState, type ReactNode, type RefObject } from 'react'
import { GridLayout, useContainerWidth, verticalCompactor, type Layout } from 'react-grid-layout'
import 'react-grid-layout/css/styles.css'
import { GripVertical, Pencil } from 'lucide-react'
import { DASHBOARD_COLS, DASHBOARD_HINT_MAX, DASHBOARD_ROW_HEIGHT, DASHBOARD_TITLE_MAX, normaliseDashboardLayout, type DashboardLayoutItem, type DashboardLayouts, type DashboardPage } from '@qc/shared/kpi'
import { Button, Field, Input, Modal } from '@/components/ui'
import { cn } from '@/lib/utils'
import { ChartFillContext } from './charts'

export interface BoardWidget {
  id: string
  title: string
  node: ReactNode
  /** False when the node has no section header of its own to carry a custom name. */
  labelled?: boolean
}

/** The name and description an administrator gave a widget; a Section inside the widget shows them in place of its own. */
export const WidgetLabelContext = createContext<{ title?: string; hint?: string }>({})

export interface BoardState {
  layouts: DashboardLayouts
  /** True while an administrator is moving things: handles show and the grid takes drags. */
  editing: boolean
  setLayout: (page: DashboardPage, layout: DashboardLayoutItem[]) => void
  /** Name and describe one widget; empty strings put the code's own back. */
  setLabel: (page: DashboardPage, id: string, label: { title: string; hint: string }) => void
}

export const BoardContext = createContext<BoardState>({ layouts: { general: [], details: [] }, editing: false, setLayout: () => {}, setLabel: () => {} })

/** Below this width the grid is a stack: phones and tablets read, they do not arrange. */
const GRID_MIN_WIDTH = 1024

export function Board({ page, widgets, className }: { page: DashboardPage; widgets: BoardWidget[]; className?: string }) {
  const { layouts, editing, setLayout, setLabel } = useContext(BoardContext)
  const [labelling, setLabelling] = useState<DashboardLayoutItem | null>(null)
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
          const it = layout.find((x) => x.i === id)
          // One scroll per widget here too: the box caps the height and the section body scrolls inside it.
          return w ? (
            <div key={id} className="flex max-h-[36rem] flex-col">
              <WidgetLabelContext.Provider value={{ title: it?.title, hint: it?.hint }}>
                {w.labelled === false && it?.title && <p className="mb-1 text-sm font-bold">{it.title}</p>}
                {w.node}
              </WidgetLabelContext.Provider>
            </div>
          ) : null
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
                    <GripVertical className="h-3.5 w-3.5" /> {it.title || w?.title || it.i}
                    <span className="ml-auto hidden font-normal opacity-80 sm:inline">drag to move · pull the corner to size</span>
                    <button
                      type="button"
                      onMouseDown={(e) => e.stopPropagation()}
                      onClick={(e) => {
                        e.stopPropagation()
                        setLabelling(it)
                      }}
                      className="ml-2 inline-flex items-center gap-1 rounded-md bg-white/15 px-2 py-0.5 hover:bg-white/25"
                      aria-label={`Name and describe: ${w?.title ?? it.i}`}
                    >
                      <Pencil className="h-3 w-3" /> Name
                    </button>
                  </div>
                )}
                <div className="min-h-0 flex-1">
                  <ChartFillContext.Provider value>
                    <WidgetLabelContext.Provider value={{ title: it.title, hint: it.hint }}>
                      {w?.labelled === false && it.title && <p className="mb-1 text-sm font-bold">{it.title}</p>}
                      {w?.node}
                    </WidgetLabelContext.Provider>
                  </ChartFillContext.Provider>
                </div>
              </div>
            )
          })}
        </GridLayout>
      )}
      {labelling && (
        <LabelDialog
          item={labelling}
          fallback={byId.get(labelling.i)?.title ?? labelling.i}
          onClose={() => setLabelling(null)}
          onSave={(label) => {
            setLabel(page, labelling.i, label)
            setLabelling(null)
          }}
        />
      )}
    </div>
  )
}

/** Name and describe a widget: what everyone reads on its header once the layout is saved. */
function LabelDialog({ item, fallback, onClose, onSave }: { item: DashboardLayoutItem; fallback: string; onClose: () => void; onSave: (label: { title: string; hint: string }) => void }) {
  const [title, setTitle] = useState(item.title ?? '')
  const [hint, setHint] = useState(item.hint ?? '')
  return (
    <Modal open onClose={onClose} title="Name this chart" icon={<Pencil className="h-5 w-5" />}>
      <div className="space-y-3">
        <p className="text-sm text-slate-500 dark:text-slate-400">Everyone sees the name and the description on the chart once you save the layout. Leave a field empty to keep the chart's own.</p>
        <Field label="Name" hint={`Its own name: ${fallback}`}>
          <Input value={title} onChange={(e) => setTitle(e.target.value.slice(0, DASHBOARD_TITLE_MAX))} placeholder={fallback} className="min-h-[48px]" dir="auto" />
        </Field>
        <Field label="Description">
          <textarea value={hint} onChange={(e) => setHint(e.target.value.slice(0, DASHBOARD_HINT_MAX))} rows={3} dir="auto" className="input min-h-[80px] w-full" placeholder="What this chart says and when to look at it." />
        </Field>
        <div className="flex flex-wrap justify-end gap-2">
          <Button className="min-h-[44px]" onClick={() => onSave({ title: '', hint: '' })}>Use its own</Button>
          <Button className="min-h-[44px]" onClick={onClose}>Cancel</Button>
          <Button variant="primary" className="min-h-[44px]" onClick={() => onSave({ title: title.trim(), hint: hint.trim() })}>Apply</Button>
        </div>
      </div>
    </Modal>
  )
}
