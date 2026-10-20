// ============================================================================
// §25 — Factory map: each factory's floor as a plan view, every machine where
// it stands, coloured by what it is doing now — an inspection open on it
// (the quality record says it is running, on which order, since when, and
// who opened it), planned to be on a line by the plan, or idle — with its
// last day on the production record and what the plan has it make next.
// Planners with Planning setup place the machines (Edit the map); until then
// they wait in the tray under it. On a phone the list reads better: it is
// the default there.
// ============================================================================

import { useEffect, useMemo, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { Link } from 'react-router-dom'
import { Factory, LayoutGrid, List, Map as MapIcon, Minus, MoveDiagonal2, Pencil, Plus, Save, Wand2, X } from 'lucide-react'
import { LAYOUT_COLUMNS, LAYOUT_ROWS, type MachineLayout, type MachineNow } from '@qc/shared/planning'
import { Badge, Button, Drawer, EmptyState } from '@/components/ui'
import { Segmented } from '@/components/ui/PageShell'
import { cn, formatDateTime, formatTime } from '@/lib/utils'
import { PHONE, useMediaQuery } from '@/lib/media'
import { usePersistedState } from '@/lib/usePersistedState'
import { useAuth } from '@/store/AuthContext'
import { useFloor, useSaveLayout } from '@/services/planning'
import { ErrorNote, Loading, SectionCard } from './common'
import { dayLabel, hoursLabel, processName, wallLabel } from './format'

const NO_FACTORY = '—'
const factoryName = (f: string) => (f === '' ? 'No factory set' : f)

const STATUS: Record<MachineNow['status'], { name: string; stripe: string; dot: string }> = {
  running: { name: 'Running (inspection open)', stripe: 'border-l-emerald-600 dark:border-l-emerald-500', dot: 'bg-emerald-600 dark:bg-emerald-500' },
  planned: { name: 'Planned to run now', stripe: 'border-l-brand-600 dark:border-l-brand-400', dot: 'bg-brand-600 dark:bg-brand-400' },
  idle: { name: 'Nothing on it now', stripe: 'border-l-slate-300 dark:border-l-slate-600', dot: 'bg-slate-400 dark:bg-slate-500' },
}

/** Where a machine goes when it is placed without being moved: the first free spot, row by row. */
export function firstFreeSpot(taken: readonly MachineLayout[], w = 3, h = 2): MachineLayout | null {
  for (let y = 0; y + h <= LAYOUT_ROWS; y++) {
    for (let x = 0; x + w <= LAYOUT_COLUMNS; x++) {
      const clash = taken.some((t) => x < t.x + t.w && t.x < x + w && y < t.y + t.h && t.y < y + h)
      if (!clash) return { x, y, w, h }
    }
  }
  return null
}

const clampLayout = (l: MachineLayout): MachineLayout => {
  const w = Math.max(1, Math.min(LAYOUT_COLUMNS, l.w))
  const h = Math.max(1, Math.min(LAYOUT_ROWS, l.h))
  return { w, h, x: Math.max(0, Math.min(LAYOUT_COLUMNS - w, l.x)), y: Math.max(0, Math.min(LAYOUT_ROWS - h, l.y)) }
}

function nowLine(m: MachineNow): string {
  const s = m.sessions[0]
  if (s) return `${s.orderNumber} · ${s.item}`
  if (m.current) return `${m.current.orderNumber} · ${m.current.item}`
  return 'Nothing planned now'
}

function MachineTile({ m, layout, selected, editing, onOpen }: { m: MachineNow; layout: MachineLayout; selected: boolean; editing: boolean; onOpen: () => void }) {
  const st = STATUS[m.status]
  const s = m.sessions[0]
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-pressed={editing ? selected : undefined}
      aria-label={`${m.name}: ${st.name}. ${nowLine(m)}${m.lateLines > 0 ? `. ${m.lateLines} late lines` : ''}`}
      style={{ left: `${(layout.x / LAYOUT_COLUMNS) * 100}%`, top: `${(layout.y / LAYOUT_ROWS) * 100}%`, width: `${(layout.w / LAYOUT_COLUMNS) * 100}%`, height: `${(layout.h / LAYOUT_ROWS) * 100}%` }}
      className={cn(
        'absolute flex flex-col items-stretch justify-start overflow-hidden rounded-lg border border-l-4 border-slate-300 bg-white p-1.5 text-left shadow-sm transition-shadow hover:shadow-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 dark:border-slate-600 dark:bg-slate-900',
        st.stripe,
        selected && 'ring-2 ring-brand-500 ring-offset-1 ring-offset-white dark:ring-offset-slate-900',
      )}
    >
      <span className="flex items-center gap-1">
        <span aria-hidden className={cn('h-2 w-2 shrink-0 rounded-full', st.dot, m.status === 'running' && 'motion-safe:animate-pulse')} />
        <span className="truncate text-[11px] font-bold leading-tight text-slate-900 dark:text-white">{m.name}</span>
      </span>
      <span className="mt-0.5 block truncate text-[10px] leading-tight text-slate-700 dark:text-slate-300">{nowLine(m)}</span>
      {s && <span className="block truncate text-[10px] leading-tight text-muted">since {formatTime(s.startedAt)}, {s.inspector}</span>}
      {layout.h >= 3 && m.next && <span className="mt-1 block truncate text-[10px] leading-tight text-slate-700 dark:text-slate-300">Next: {m.next.orderNumber} · {m.next.item}</span>}
      {layout.h >= 3 && <span className="block truncate text-[10px] leading-tight text-muted">Queue: {m.queueLines} lines, {hoursLabel(m.queueHours)}</span>}
      {m.lateLines > 0 && <span className="absolute bottom-1 right-1 rounded bg-rose-600 px-1 text-[10px] font-bold text-white dark:bg-rose-400 dark:text-rose-950">{m.lateLines} late</span>}
    </button>
  )
}

function MachineDetail({ m, onClose }: { m: MachineNow | null; onClose: () => void }) {
  if (!m) return null
  const st = STATUS[m.status]
  return (
    <Drawer open onClose={onClose} title={m.name} subtitle={`${factoryName(m.factory)} · ${processName(m.process)} · ${hoursLabel(m.hoursPerDay)} a day (${m.capacitySource === 'set' ? 'set' : m.capacitySource === 'inferred' ? 'learnt' : 'default'})`} icon={<Factory className="h-5 w-5" />}>
      <div className="space-y-5 text-sm">
        <p className="flex items-center gap-2 font-semibold">
          <span aria-hidden className={cn('h-2.5 w-2.5 rounded-full', st.dot)} /> {st.name}
        </p>
        <section>
          <h3 className="mb-1.5 font-bold">On it now, by the quality record</h3>
          {m.sessions.length === 0 ? (
            <p className="text-muted">No inspection is open on this machine.</p>
          ) : (
            <ul className="space-y-2">
              {m.sessions.map((s) => (
                <li key={s.sessionId} className="rounded-xl bg-emerald-50 p-3 ring-1 ring-inset ring-emerald-200 dark:bg-emerald-500/10 dark:ring-emerald-500/25">
                  <p className="font-semibold">
                    {s.orderNumber} · {s.item}
                  </p>
                  <p className="text-muted">
                    {s.customer} · Order ID {s.lineKey}
                  </p>
                  <p className="text-muted">
                    Since {formatDateTime(s.startedAt)}, opened by {s.inspector}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </section>
        <section>
          <h3 className="mb-1.5 font-bold">Last day on the production record</h3>
          {m.lastRecord ? (
            <p>
              {dayLabel(m.lastRecord.workDay, true)}
              {m.lastRecord.shift ? `, ${m.lastRecord.shift}` : ''}: {m.lastRecord.producedQty.toLocaleString()} pieces of {m.lastRecord.item || '—'}
              {m.lastRecord.workers.length > 0 && <span className="block text-muted">Workers: {m.lastRecord.workers.join('، ')}</span>}
            </p>
          ) : (
            <p className="text-muted">Nothing on the production record in the last 45 days.</p>
          )}
        </section>
        <section>
          <h3 className="mb-1.5 font-bold">By the plan</h3>
          <dl className="space-y-2">
            {[
              ['Now', m.current],
              ['Next', m.next],
            ].map(([label, op]) => (
              <div key={label as string}>
                <dt className="text-muted">{label as string}</dt>
                <dd>
                  {op && typeof op !== 'string' ? (
                    <>
                      <span className="font-semibold">
                        {op.orderNumber} · {op.item}
                      </span>
                      <span className="block text-muted">
                        {wallLabel(op.start)} to {wallLabel(op.end)} · {hoursLabel(op.hours)}
                        {op.lateDays > 0 ? ` · ${op.lateDays} days late` : ''}
                      </span>
                    </>
                  ) : (
                    '—'
                  )}
                </dd>
              </div>
            ))}
          </dl>
          <p className="mt-2 text-muted">
            In its queue: {m.queueLines} lines, {hoursLabel(m.queueHours)}
            {m.lateLines > 0 ? `, ${m.lateLines} late` : ''}.
          </p>
          <Link to={`/planning/schedule?machine=${encodeURIComponent(m.key)}`} className="mt-2 inline-block font-semibold text-brand-700 underline-offset-4 hover:underline dark:text-brand-300">
            Open its schedule
          </Link>
        </section>
      </div>
    </Drawer>
  )
}

function FloorList({ machines, onOpen }: { machines: MachineNow[]; onOpen: (m: MachineNow) => void }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[720px] text-sm">
        <thead className="text-left text-xs text-muted">
          <tr className="border-b border-slate-200 dark:border-slate-700">
            <th scope="col" className="py-2 pr-3 font-semibold">Machine</th>
            <th scope="col" className="py-2 pr-3 font-semibold">Now</th>
            <th scope="col" className="py-2 pr-3 font-semibold">Last production day</th>
            <th scope="col" className="py-2 pr-3 font-semibold">Next in the plan</th>
            <th scope="col" className="py-2 font-semibold">Queue</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
          {machines.map((m) => (
            <tr key={m.key} className="align-top">
              <td className="py-2 pr-3">
                <button type="button" onClick={() => onOpen(m)} className="flex items-center gap-2 text-left font-semibold text-brand-700 underline-offset-4 hover:underline dark:text-brand-300">
                  <span aria-hidden className={cn('h-2.5 w-2.5 shrink-0 rounded-full', STATUS[m.status].dot)} />
                  {m.name}
                </button>
                <span className="block pl-[18px] text-xs text-muted">{processName(m.process)}</span>
              </td>
              <td className="py-2 pr-3">
                {m.sessions[0] ? (
                  <>
                    <span className="block">{nowLine(m)}</span>
                    <span className="text-xs text-muted">
                      since {formatTime(m.sessions[0].startedAt)}, {m.sessions[0].inspector}
                    </span>
                  </>
                ) : (
                  <span className="text-muted">{m.current ? `Planned: ${nowLine(m)}` : 'Idle'}</span>
                )}
              </td>
              <td className="py-2 pr-3">
                {m.lastRecord ? (
                  <>
                    <span className="block">{dayLabel(m.lastRecord.workDay)}</span>
                    <span className="text-xs text-muted">
                      {m.lastRecord.producedQty.toLocaleString()} pcs{m.lastRecord.shift ? `, ${m.lastRecord.shift}` : ''}
                    </span>
                  </>
                ) : (
                  <span className="text-muted">—</span>
                )}
              </td>
              <td className="py-2 pr-3">{m.next ? `${m.next.orderNumber} · ${m.next.item}` : <span className="text-muted">—</span>}</td>
              <td className="whitespace-nowrap py-2 tabular-nums">
                {m.queueLines} lines, {hoursLabel(m.queueHours)}
                {m.lateLines > 0 && (
                  <Badge tone="red" className="ml-1.5">
                    {m.lateLines} late
                  </Badge>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export function FloorSection() {
  const { data, error, isLoading, refetch } = useFloor()
  const { can } = useAuth()
  const mayEdit = can('manage-planning-setup')
  const phone = useMediaQuery(PHONE)
  const [view, setView] = usePersistedState<'map' | 'list'>('qc-planning:floor-view', phone ? 'list' : 'map')
  const [factory, setFactory] = usePersistedState<string>('qc-planning:factory', '')
  const [open, setOpen] = useState<string | null>(null)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState<Map<string, MachineLayout>>(new Map())
  const [selected, setSelected] = useState<string | null>(null)
  const save = useSaveLayout()

  const factories = data?.factories ?? []
  const current = factories.includes(factory === NO_FACTORY ? '' : factory) ? (factory === NO_FACTORY ? '' : factory) : (factories[0] ?? '')
  const machines = useMemo(() => (data?.machines ?? []).filter((m) => m.factory === current), [data, current])
  useEffect(() => {
    if (!editing) setDraft(new Map(machines.filter((m) => m.layout).map((m) => [m.key, m.layout!])))
  }, [machines, editing])

  if (isLoading) return <Loading what="Reading the floor" />
  if (error || !data) return <ErrorNote error={error} retry={() => void refetch()} />
  if (data.machines.length === 0) return <EmptyState icon={<Factory className="h-10 w-10" />} title="No machines in the register" hint="Add them under Configuration → Machines, with their factory and process." />

  const placed = machines.filter((m) => draft.has(m.key))
  const unplaced = machines.filter((m) => !draft.has(m.key))
  const running = machines.filter((m) => m.status === 'running').length
  const openMachine = data.machines.find((m) => m.key === open) ?? null

  const move = (key: string, change: Partial<MachineLayout>) => {
    setDraft((d) => {
      const at = d.get(key)
      if (!at) return d
      const next = new Map(d)
      next.set(key, clampLayout({ ...at, ...change }))
      return next
    })
  }
  const place = (key: string) => {
    const spot = firstFreeSpot([...draft.values()])
    if (!spot) return
    setDraft((d) => new Map(d).set(key, spot))
    setSelected(key)
  }
  const placeAll = () => {
    const next = new Map(draft)
    for (const m of unplaced) {
      const spot = firstFreeSpot([...next.values()])
      if (!spot) break
      next.set(m.key, spot)
    }
    setDraft(next)
  }
  const onTileKey = (e: ReactKeyboardEvent, key: string) => {
    if (!editing || selected !== key) return
    const at = draft.get(key)
    if (!at) return
    const step: Record<string, Partial<MachineLayout>> = { ArrowLeft: { x: at.x - 1 }, ArrowRight: { x: at.x + 1 }, ArrowUp: { y: at.y - 1 }, ArrowDown: { y: at.y + 1 } }
    const change = step[e.key]
    if (change) {
      e.preventDefault()
      move(key, e.shiftKey ? (e.key === 'ArrowLeft' ? { w: at.w - 1 } : e.key === 'ArrowRight' ? { w: at.w + 1 } : e.key === 'ArrowUp' ? { h: at.h - 1 } : { h: at.h + 1 }) : change)
    }
  }
  const finish = async () => {
    await save.mutateAsync({ positions: placed.map((m) => ({ machineKey: m.key, ...draft.get(m.key)! })) })
    setEditing(false)
    setSelected(null)
  }
  const sel = selected ? draft.get(selected) : undefined

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        {factories.length > 1 && (
          <Segmented label="Factory" value={current === '' ? NO_FACTORY : current} options={factories.map((f) => ({ value: f === '' ? NO_FACTORY : f, label: factoryName(f) }))} onChange={(v) => !editing && setFactory(v)} />
        )}
        <Segmented
          label="View"
          value={view}
          onChange={setView}
          options={[
            { value: 'map', label: 'Map', icon: <MapIcon className="h-4 w-4" /> },
            { value: 'list', label: 'List', icon: <List className="h-4 w-4" /> },
          ]}
        />
        <p className="text-13 text-muted">
          {running} of {machines.length} running now · queues from {data.planName}
        </p>
        <span className="flex-1" />
        {mayEdit && view === 'map' && !editing && (
          <Button className="min-h-[44px]" onClick={() => setEditing(true)}>
            <Pencil className="h-4 w-4" /> Edit the map
          </Button>
        )}
      </div>

      {view === 'list' ? (
        <SectionCard title={factoryName(current)} hint="What each machine is on now, by the open inspections; its last production day; what the plan has it make next.">
          <FloorList machines={machines} onOpen={(m) => setOpen(m.key)} />
        </SectionCard>
      ) : (
        <SectionCard
          title={factoryName(current)}
          hint={editing ? 'Choose a machine, then move it with the arrows below it (or the arrow keys; Shift with an arrow resizes it). Save when it looks like the floor.' : 'Each machine where it stands on the floor. Choose one for what it is on, its last production day and its queue.'}
          actions={
            editing ? (
              <>
                {unplaced.length > 0 && (
                  <Button className="min-h-[44px]" onClick={placeAll}>
                    <Wand2 className="h-4 w-4" /> Place the rest
                  </Button>
                )}
                <Button
                  className="min-h-[44px]"
                  onClick={() => {
                    setEditing(false)
                    setSelected(null)
                  }}
                >
                  <X className="h-4 w-4" /> Cancel
                </Button>
                <Button variant="primary" className="min-h-[44px]" disabled={save.isPending} onClick={() => void finish()}>
                  <Save className="h-4 w-4" /> Save the map
                </Button>
              </>
            ) : undefined
          }
        >
          {save.error && <ErrorNote error={save.error} />}
          <div className="overflow-x-auto">
            <div
              className="relative min-w-[720px] rounded-xl border border-slate-200 bg-slate-50 dark:border-slate-700 dark:bg-slate-950"
              style={{
                aspectRatio: `${LAYOUT_COLUMNS} / ${LAYOUT_ROWS}`,
                backgroundImage: 'linear-gradient(to right, rgb(148 163 184 / 0.18) 1px, transparent 1px), linear-gradient(to bottom, rgb(148 163 184 / 0.18) 1px, transparent 1px)',
                backgroundSize: `${100 / LAYOUT_COLUMNS}% ${100 / LAYOUT_ROWS}%`,
              }}
              role="group"
              aria-label={`Map of ${factoryName(current)}`}
            >
              {placed.length === 0 && !editing && (
                <p className="absolute inset-0 grid place-items-center p-6 text-center text-sm text-muted">
                  {mayEdit ? 'No machine is on this map yet: press Edit the map and place them.' : 'No machine is on this map yet: someone with Planning setup places them.'}
                </p>
              )}
              {placed.map((m) => (
                <div key={m.key} onKeyDown={(e) => onTileKey(e, m.key)}>
                  <MachineTile m={m} layout={draft.get(m.key)!} editing={editing} selected={selected === m.key} onOpen={() => (editing ? setSelected(m.key) : setOpen(m.key))} />
                </div>
              ))}
            </div>
          </div>
          {editing && sel && selected && (
            <div className="mt-3 flex flex-wrap items-center gap-2 rounded-xl bg-brand-50 p-3 text-sm dark:bg-brand-500/10" aria-live="polite">
              <span className="font-semibold">{machines.find((m) => m.key === selected)?.name}</span>
              <span className="text-muted">
                at {sel.x + 1},{sel.y + 1}, {sel.w}×{sel.h} cells
              </span>
              <span className="flex-1" />
              {(
                [
                  ['Left', { x: sel.x - 1 }],
                  ['Right', { x: sel.x + 1 }],
                  ['Up', { y: sel.y - 1 }],
                  ['Down', { y: sel.y + 1 }],
                ] as const
              ).map(([label, change]) => (
                <Button key={label} className="min-h-[40px] px-3" onClick={() => move(selected, change)}>
                  {label}
                </Button>
              ))}
              <Button className="min-h-[40px] px-3" aria-label="Narrower" onClick={() => move(selected, { w: sel.w - 1 })}>
                <Minus className="h-4 w-4" /> W
              </Button>
              <Button className="min-h-[40px] px-3" aria-label="Wider" onClick={() => move(selected, { w: sel.w + 1 })}>
                <Plus className="h-4 w-4" /> W
              </Button>
              <Button className="min-h-[40px] px-3" aria-label="Shorter" onClick={() => move(selected, { h: sel.h - 1 })}>
                <Minus className="h-4 w-4" /> H
              </Button>
              <Button className="min-h-[40px] px-3" aria-label="Taller" onClick={() => move(selected, { h: sel.h + 1 })}>
                <Plus className="h-4 w-4" /> H
              </Button>
              <Button
                className="min-h-[40px] px-3"
                onClick={() => {
                  setDraft((d) => {
                    const next = new Map(d)
                    next.delete(selected)
                    return next
                  })
                  setSelected(null)
                }}
              >
                <MoveDiagonal2 className="h-4 w-4" /> Off the map
              </Button>
            </div>
          )}
          {unplaced.length > 0 && (
            <div className="mt-4">
              <h3 className="mb-2 flex items-center gap-2 text-sm font-bold">
                <LayoutGrid className="h-4 w-4" aria-hidden /> Not on the map yet ({unplaced.length})
              </h3>
              <ul className="flex flex-wrap gap-2">
                {unplaced.map((m) => (
                  <li key={m.key}>
                    <button
                      type="button"
                      onClick={() => (editing ? place(m.key) : setOpen(m.key))}
                      className="inline-flex min-h-[40px] items-center gap-2 rounded-lg bg-white px-3 text-13 font-semibold ring-1 ring-inset ring-slate-200 hover:ring-brand-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 dark:bg-slate-900 dark:ring-slate-700"
                    >
                      <span aria-hidden className={cn('h-2 w-2 rounded-full', STATUS[m.status].dot)} />
                      {m.name}
                      {editing && <Plus className="h-3.5 w-3.5 text-muted" aria-label="Place it" />}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <ul className="mt-4 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted" aria-label="What the colours mean">
            {(Object.keys(STATUS) as MachineNow['status'][]).map((s) => (
              <li key={s} className="inline-flex items-center gap-1.5">
                <span aria-hidden className={cn('h-2.5 w-2.5 rounded-full', STATUS[s].dot)} />
                {STATUS[s].name}
              </li>
            ))}
            <li>Read again every minute; machines with an inspection open count as running.</li>
          </ul>
        </SectionCard>
      )}
      <MachineDetail m={openMachine} onClose={() => setOpen(null)} />
    </div>
  )
}

