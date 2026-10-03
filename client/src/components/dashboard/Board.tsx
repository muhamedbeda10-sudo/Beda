// ============================================================================
// §15 — the board: the dashboard's charts on a 12-column grid an administrator
// can rearrange. Each widget keeps its own scroll inside its box, so a small
// box still shows a whole chart. On a narrow screen the grid gives way to a
// stack in the layout's reading order: nothing to drag on a tablet.
// ============================================================================

import { createContext, useContext, useMemo, useState, type ReactNode, type RefObject } from 'react'
import { GridLayout, useContainerWidth, verticalCompactor, type Layout } from 'react-grid-layout'
import 'react-grid-layout/css/styles.css'
import { BarChart3, Eye, EyeOff, GripVertical, LayoutGrid, LineChart, Pencil, PieChart, Table2 } from 'lucide-react'
import { DASHBOARD_COLS, DASHBOARD_HINT_MAX, DASHBOARD_ROW_HEIGHT, DASHBOARD_TITLE_MAX, DASHBOARD_WIDGETS, normaliseDashboardLayout, type DashboardLayoutItem, type DashboardLayouts, type DashboardPage } from '@qc/shared/kpi'
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
  /** Put a widget away on this administrator's board, or show it again. */
  setHidden: (page: DashboardPage, id: string, hidden: boolean) => void
}

export const BoardContext = createContext<BoardState>({ layouts: { general: [], details: [], comparisons: [] }, editing: false, setLayout: () => {}, setLabel: () => {}, setHidden: () => {} })

/** Below this width the grid is a stack: phones and tablets read, they do not arrange. */
const GRID_MIN_WIDTH = 1024

export function Board({ page, widgets, className }: { page: DashboardPage; widgets: BoardWidget[]; className?: string }) {
  const { layouts, editing, setLayout, setLabel, setHidden } = useContext(BoardContext)
  const [labelling, setLabelling] = useState<DashboardLayoutItem | null>(null)
  const { width, containerRef, mounted } = useContainerWidth()
  // The library types the ref for React 19; React 18's ref attribute wants the older shape.
  const ref = containerRef as unknown as RefObject<HTMLDivElement>
  const ids = widgets.map((w) => w.id).join('|')
  // The layout of the widgets on screen: a widget with no place yet gets one below the rest; one an administrator hid is left out.
  const layout = useMemo(() => {
    const present = new Set(ids.split('|'))
    return normaliseDashboardLayout(page, layouts[page]).filter((it) => present.has(it.i) && !it.hidden)
  }, [layouts, page, ids])
  const hiddenCount = useMemo(() => normaliseDashboardLayout(page, layouts[page]).filter((it) => it.hidden).length, [layouts, page])
  const order = useMemo(() => [...layout].sort((a, b) => a.y - b.y || a.x - b.x).map((it) => it.i), [layout])
  const byId = new Map(widgets.map((w) => [w.id, w]))
  const stacked = mounted && width < GRID_MIN_WIDTH

  if (layout.length === 0 && hiddenCount > 0) {
    return (
      <div ref={ref} className={cn('rounded-2xl border border-dashed border-slate-300 p-6 text-center text-sm text-slate-400 dark:border-slate-700', className)}>
        Every chart here is hidden. {editing ? 'Open Charts to show some again.' : 'An administrator shows them again from Arrange → Charts.'}
      </div>
    )
  }

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
                    <GripVertical className="h-3.5 w-3.5 shrink-0" /> <span className="min-w-0 truncate">{it.title || w?.title || it.i}</span>
                    <span className="ml-auto hidden truncate font-normal opacity-80 lg:inline">drag to move · pull the corner to size</span>
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
                    <button
                      type="button"
                      onMouseDown={(e) => e.stopPropagation()}
                      onClick={(e) => {
                        e.stopPropagation()
                        setHidden(page, it.i, true)
                      }}
                      className="inline-flex items-center gap-1 rounded-md bg-white/15 px-2 py-0.5 hover:bg-white/25"
                      aria-label={`Hide: ${it.title || w?.title || it.i}`}
                    >
                      <EyeOff className="h-3 w-3" /> Hide
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

/** Name and describe a widget: what its header reads on your board once the layout is saved. */
function LabelDialog({ item, fallback, onClose, onSave }: { item: DashboardLayoutItem; fallback: string; onClose: () => void; onSave: (label: { title: string; hint: string }) => void }) {
  const [title, setTitle] = useState(item.title ?? '')
  const [hint, setHint] = useState(item.hint ?? '')
  return (
    <Modal open onClose={onClose} title="Name this chart" icon={<Pencil className="h-5 w-5" />}>
      <div className="space-y-3">
        <p className="text-sm text-slate-500 dark:text-slate-400">The name and the description show on your dashboard once you save the layout; nobody else's changes. Leave a field empty to keep the chart's own.</p>
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

/** The kind of drawing a widget is, for its tile in the gallery. */
function widgetIcon(id: string) {
  const k = id.toLowerCase()
  if (k.includes('pie') || k.includes('disposition')) return PieChart
  if (k.includes('tiles')) return LayoutGrid
  if (k.includes('table') || k.includes('byorder') || k.includes('byitem') || k.includes('details') || k.includes('hold') || k.includes('discipline') || k.includes('ranking') || k.includes('suppliers')) return Table2
  if (k.includes('trend') || k.includes('bymonth') || k.includes('chart') || k.includes('monthly') || k.includes('daily')) return LineChart
  return BarChart3
}

const PAGE_NAME: Record<DashboardPage, string> = { general: 'General', details: 'Details', comparisons: 'Comparisons' }

/**
 * The gallery of every chart the dashboard has, page by page: tick a tile to
 * show it, untick it to put it away on your own board. A chart shown again goes to
 * the bottom of its page, to be dragged where it belongs. Nothing is kept
 * until the layout is saved.
 */
export function ChartGallery({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { layouts, setHidden } = useContext(BoardContext)
  const pages: DashboardPage[] = ['general', 'comparisons', 'details']
  return (
    <Modal open={open} onClose={onClose} title="Charts on the dashboard" icon={<LayoutGrid className="h-5 w-5" />} size="xl" footer={<Button variant="primary" onClick={onClose}>Done</Button>}>
      <div className="space-y-5">
        <p className="text-sm text-slate-500 dark:text-slate-400">Tick the charts you see. A chart you untick is hidden on your dashboard once you save the layout, and nobody else's changes; tick it again and it comes back at the bottom of its page.</p>
        {pages.map((page) => {
          const items = normaliseDashboardLayout(page, layouts[page])
          const byId = new Map(items.map((it) => [it.i, it]))
          const shown = items.filter((it) => !it.hidden).length
          return (
            <section key={page}>
              <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
                <h3 className="text-sm font-bold">
                  {PAGE_NAME[page]} <span className="font-normal text-slate-400">· {shown} of {items.length} shown</span>
                </h3>
                <span className="flex gap-3 text-xs font-semibold">
                  <button type="button" className="text-brand-700 hover:underline disabled:opacity-40 dark:text-brand-300" disabled={shown === items.length} onClick={() => items.forEach((it) => it.hidden && setHidden(page, it.i, false))}>
                    Show all
                  </button>
                  <button type="button" className="text-slate-500 hover:underline disabled:opacity-40" disabled={shown === 0} onClick={() => items.forEach((it) => !it.hidden && setHidden(page, it.i, true))}>
                    Hide all
                  </button>
                </span>
              </div>
              <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
                {DASHBOARD_WIDGETS[page].map((spec) => {
                  const it = byId.get(spec.id)
                  const on = !it?.hidden
                  const Icon = widgetIcon(spec.id)
                  const name = it?.title || spec.title
                  return (
                    <li key={spec.id}>
                      <button
                        type="button"
                        role="switch"
                        aria-checked={on}
                        aria-label={`${on ? 'Hide' : 'Show'}: ${name}`}
                        onClick={() => setHidden(page, spec.id, on)}
                        className={cn('flex h-full w-full flex-col gap-2 rounded-xl p-3 text-left ring-1 transition-colors', on ? 'bg-brand-50 ring-brand-300 dark:bg-brand-500/10 dark:ring-brand-500/40' : 'bg-white opacity-70 ring-slate-200 hover:opacity-100 dark:bg-slate-900 dark:ring-slate-700')}
                      >
                        <span className="flex items-start justify-between gap-2">
                          <span className={cn('grid h-9 w-9 place-items-center rounded-lg', on ? 'bg-brand-600 text-white' : 'bg-slate-100 text-slate-400 dark:bg-slate-800')}>
                            <Icon className="h-5 w-5" />
                          </span>
                          {on ? <Eye className="h-4 w-4 text-brand-600 dark:text-brand-300" /> : <EyeOff className="h-4 w-4 text-slate-400" />}
                        </span>
                        <span className="text-sm font-semibold leading-tight" dir="auto">{name}</span>
                        {it?.title && <span className="text-[11px] text-slate-400">{spec.title}</span>}
                        <span className={cn('mt-auto text-[11px] font-semibold uppercase tracking-wide', on ? 'text-brand-700 dark:text-brand-300' : 'text-slate-400')}>{on ? 'Shown' : 'Hidden'}</span>
                      </button>
                    </li>
                  )
                })}
              </ul>
            </section>
          )
        })}
      </div>
    </Modal>
  )
}
