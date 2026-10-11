// ============================================================================
// §7 — the generic master-data panel: list, add, edit, soft-delete. Every
// configuration section is this panel with its own columns and form.
// ============================================================================

import { useCallback, useMemo, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useQueryClient } from '@tanstack/react-query'
import { CheckSquare, Loader2, Pencil, Plus, Search, Square, Trash2, X } from 'lucide-react'
import { Badge, Button, Card, EmptyState, Input, Modal, Select } from '@/components/ui'
import { ScrollX } from '@/components/ui/ScrollX'
import { useMaster } from '@/services/queries'
import { createMaster, deleteManyMaster, deleteMaster, updateMaster } from '@/services/mutations'
import { useApp } from '@/store/AppContext'
import { PHONE, useMediaQuery } from '@/lib/media'
import { cn } from '@/lib/utils'
import { useTableView, ViewTh } from '@/components/ui/ColumnFilter'
import type { MasterKind, MasterRecordByKind } from '@qc/shared/api'


export interface Column<T> {
  key: string
  label: string
  render: (row: T) => ReactNode
  className?: string
  /** What the column's filter lists, searches and sorts for a row; the row's own field of the same key by default. */
  text?: (row: T) => string
  /** A figure the column sorts by instead of its text. */
  sortNum?: (row: T) => number | null
  /** A column with nothing to filter (a picture, a sign). */
  filterable?: false
  /** A column of little value on a narrow table: shown from a wide screen (1280 px) only. The phone's cards keep it. */
  hideBelow?: 'xl'
}

/**
 * The sticky Actions header cell (.table-sticky-last paints the column opaque,
 * so it needs the header's own colour): slate-50 in the light theme, and in
 * the dark one the colour the thead's translucent slate-800/60 makes over the
 * slate-900 card — opaque, or the column scrolled under it would show through.
 */
export const STICKY_TH = 'bg-slate-50 dark:bg-[#182234]'

/** The row's actions, Edit and Delete: 44 px each. */
const ROW_BTN = 'grid h-11 w-11 place-items-center rounded-xl text-muted transition-colors'

/**
 * Whether a click on a row landed on something of its own — a checkbox, an
 * action, a thumbnail that opens — rather than on the row itself. A row that
 * opens on a tap asks this first, so its buttons keep their own meaning.
 */
export function clickedControl(e: ReactMouseEvent<HTMLElement>): boolean {
  return !!(e.target as HTMLElement).closest('button, a, input, select, textarea, [role="button"]')
}

/** A row's own field under a column's key, as text: what a column with no `text` filters on. */
function fieldText(row: object, key: string): string {
  const v = (row as Record<string, unknown>)[key]
  return typeof v === 'string' || typeof v === 'number' ? String(v) : typeof v === 'boolean' ? (v ? 'Yes' : 'No') : ''
}

interface PanelProps<K extends MasterKind, D> {
  title: string
  icon: ReactNode
  /** Which master-data table the API manages for this panel. */
  kind: K
  rows: MasterRecordByKind[K][]
  loading: boolean
  columns: Column<MasterRecordByKind[K]>[]
  emptyHint: string
  addLabel: string
  newDraft: () => D
  toDraft: (row: MasterRecordByKind[K]) => D
  validate: (draft: D) => string | null
  /** The record body the API stores. The id is assigned by the API. */
  toRecord: (draft: D) => Omit<MasterRecordByKind[K], 'id'>
  renderForm: (draft: D, patch: (p: Partial<D>) => void) => ReactNode
  describe: (row: MasterRecordByKind[K]) => string
  /** Extra header buttons, rendered before the add button. */
  extraActions?: ReactNode
  sort?: (a: MasterRecordByKind[K], b: MasterRecordByKind[K]) => number
  groupBy?: (row: MasterRecordByKind[K]) => string
  groupLabel?: (group: string) => string
  minTableWidth?: string
  /** What the filter box matches against; every text field of the row by default. */
  searchText?: (row: MasterRecordByKind[K]) => string
  searchPlaceholder?: string
}

/** Every text and number field of a record, joined — what the filter box searches by default. */
function defaultSearchText(row: object): string {
  return Object.values(row)
    .filter((v) => typeof v === 'string' || typeof v === 'number')
    .join(' ')
}

export function MasterDataPanel<K extends MasterKind, D>(props: PanelProps<K, D>) {
  type T = MasterRecordByKind[K]
  const queryClient = useQueryClient()
  const { toast } = useApp()
  const [editing, setEditing] = useState<{ id: string | null; draft: D } | null>(null)
  const [confirming, setConfirming] = useState<T | null>(null)
  const [busy, setBusy] = useState(false)
  const [filter, setFilter] = useState('')
  const [selected, setSelected] = useState<Set<string>>(() => new Set())
  const [confirmingMany, setConfirmingMany] = useState(false)

  const { rows, sort, groupBy, searchText } = props
  // On a phone each record is a card (its first column as the title, the rest as label and value, Edit and Delete
  // at the end): a table of 54 rem has no place on a 360 px screen. From 640 px the table, its Actions column
  // kept in view while the rest scrolls under it, and a tap on a row opens its edit dialog.
  const phone = useMediaQuery(PHONE)

  // The filter narrows what is shown, sorted and grouped; a code typed here
  // finds the rows of one item, one machine, one defect name.
  const sorted = useMemo(() => {
    const terms = filter.trim().toLowerCase().split(/\s+/).filter(Boolean)
    const matches = (row: T) => {
      if (terms.length === 0) return true
      const hay = (searchText ? searchText(row) : defaultSearchText(row)).toLowerCase()
      return terms.every((t) => hay.includes(t))
    }
    const copy = rows.filter(matches)
    return sort ? copy.sort(sort) : copy
  }, [rows, sort, filter, searchText])

  // Excel's sort and filter on every column, after the filter box.
  const view = useTableView(
    sorted,
    props.columns.map((c) => ({ key: c.key, value: c.text ?? ((r: T) => fieldText(r, c.key)), sortValue: c.sortNum, numeric: !!c.sortNum })),
  )
  const shown = view.rows

  // A selection only ever holds rows that still exist and are shown.
  const visibleIds = useMemo(() => new Set(shown.map((r) => r.id)), [shown])
  const selectedVisible = useMemo(() => Array.from(selected).filter((id) => visibleIds.has(id)), [selected, visibleIds])
  const allVisibleSelected = shown.length > 0 && selectedVisible.length === shown.length

  const toggle = (id: string) =>
    setSelected((cur) => {
      const next = new Set(cur)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  const toggleAll = () =>
    setSelected((cur) => {
      if (allVisibleSelected) {
        const next = new Set(cur)
        for (const id of visibleIds) next.delete(id)
        return next
      }
      return new Set([...cur, ...visibleIds])
    })

  const groups = useMemo(() => {
    if (!groupBy) return null
    const map = new Map<string, T[]>()
    for (const row of shown) {
      const g = groupBy(row)
      const arr = map.get(g) ?? []
      arr.push(row)
      map.set(g, arr)
    }
    return Array.from(map.entries()).sort((a, b) =>
      a[0].localeCompare(b[0], undefined, { numeric: true }),
    )
  }, [shown, groupBy])

  const patch = useCallback((p: Partial<D>) => {
    setEditing((cur) => (cur ? { ...cur, draft: { ...cur.draft, ...p } } : cur))
  }, [])

  async function save() {
    if (!editing) return
    const problem = props.validate(editing.draft)
    if (problem) {
      toast(problem, 'error')
      return
    }
    setBusy(true)
    try {
      const record = props.toRecord(editing.draft)
      if (editing.id) await updateMaster(queryClient, props.kind, editing.id, record)
      else await createMaster(queryClient, props.kind, record)
      toast(editing.id ? 'Changes saved.' : 'Added.', 'success')
      setEditing(null)
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not save that record.', 'error')
    } finally {
      setBusy(false)
    }
  }

  async function remove() {
    if (!confirming) return
    setBusy(true)
    try {
      await deleteMaster(queryClient, props.kind, confirming.id)
      toast('Deleted. The record is kept for the audit trail.', 'success')
      setConfirming(null)
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not delete that record.', 'error')
    } finally {
      setBusy(false)
    }
  }

  async function removeMany() {
    if (selectedVisible.length === 0) return
    setBusy(true)
    try {
      const n = await deleteManyMaster(queryClient, props.kind, selectedVisible)
      toast(`${n} record${n === 1 ? '' : 's'} deleted. They are kept for the audit trail.`, 'success')
      setSelected(new Set())
      setConfirmingMany(false)
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not delete those records.', 'error')
    } finally {
      setBusy(false)
    }
  }

  const checkbox = (checked: boolean, onClick: () => void, label: string) => (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-label={label}
      onClick={onClick}
      className={cn('grid h-11 w-11 shrink-0 place-items-center rounded-xl transition-colors', checked ? 'text-brand-600' : 'text-slate-300 hover:text-slate-500')}
    >
      {checked ? <CheckSquare className="h-5 w-5" /> : <Square className="h-5 w-5" />}
    </button>
  )

  const edit = (row: T) => setEditing({ id: row.id, draft: props.toDraft(row) })

  const actions = (row: T) => (
    <>
      <button type="button" onClick={() => edit(row)} aria-label={`Edit ${props.describe(row)}`} className={cn(ROW_BTN, 'hover:bg-slate-100 hover:text-brand-600 dark:hover:bg-slate-800')}>
        <Pencil className="h-4 w-4" />
      </button>
      <button type="button" onClick={() => setConfirming(row)} aria-label={`Delete ${props.describe(row)}`} className={cn(ROW_BTN, 'hover:bg-rose-50 hover:text-rose-600 dark:hover:bg-rose-500/10')}>
        <Trash2 className="h-4 w-4" />
      </button>
    </>
  )

  /** Ticks every row of one group, or unticks them all when they all are. */
  const toggleGroup = (visible: T[]) =>
    setSelected((cur) => {
      const next = new Set(cur)
      const all = visible.every((r) => next.has(r.id))
      for (const r of visible) if (all) next.delete(r.id)
      else next.add(r.id)
      return next
    })

  const table = (visible: T[]) => (
    <ScrollX className="rounded-2xl ring-1 ring-slate-200 dark:ring-slate-800" innerClassName="rounded-2xl" shadows="start">
      <table className={cn('table-sticky-last w-full text-sm', props.minTableWidth ?? 'min-w-[40rem]')}>
        <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-muted dark:bg-slate-800/60">
          <tr>
            <th className="w-12 px-1 py-1">
              {checkbox(
                visible.length > 0 && visible.every((r) => selected.has(r.id)),
                () => toggleGroup(visible),
                'Select every row in this group',
              )}
            </th>
            {props.columns.map((c) =>
              c.filterable === false ? (
                <th key={c.key} className={cn('px-3 py-2.5 font-bold', c.hideBelow && 'hidden xl:table-cell', c.className)}>
                  {c.label}
                </th>
              ) : (
                <ViewTh key={c.key} view={view} column={c.key} label={c.label} className={cn('px-3 py-2.5 font-bold', c.hideBelow && 'hidden xl:table-cell', c.className)} />
              ),
            )}
            <th className={cn(STICKY_TH, 'px-3 py-2.5 text-right font-bold')}>Actions</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
          {visible.map((row) => (
            <tr
              key={row.id}
              onClick={(e) => {
                if (!clickedControl(e)) edit(row)
              }}
              className={cn('cursor-pointer hover:bg-slate-50/70 dark:hover:bg-slate-800/40', selected.has(row.id) && 'bg-brand-50/60 dark:bg-brand-500/10')}
            >
              <td className="px-1 py-1">{checkbox(selected.has(row.id), () => toggle(row.id), `Select ${props.describe(row)}`)}</td>
              {props.columns.map((c) => (
                <td key={c.key} className={cn('px-3 py-2.5 align-middle', c.hideBelow && 'hidden xl:table-cell', c.className)}>
                  {c.render(row)}
                </td>
              ))}
              {/* The sticky column paints its own background, so a selected row's tint is given to it again. */}
              <td className={cn('px-2 py-1 text-right', selected.has(row.id) && 'bg-brand-50 dark:bg-slate-800')}>
                <div className="inline-flex gap-0.5">{actions(row)}</div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </ScrollX>
  )

  const cards = (visible: T[]) => {
    const [title, ...rest] = props.columns
    return (
      <ul className="space-y-2">
        {visible.map((row) => (
          <li
            key={row.id}
            className={cn('flex items-start gap-1 rounded-2xl p-2 ring-1 ring-slate-200 dark:ring-slate-800', selected.has(row.id) && 'bg-brand-50/60 dark:bg-brand-500/10')}
          >
            {checkbox(selected.has(row.id), () => toggle(row.id), `Select ${props.describe(row)}`)}
            <div className="min-w-0 flex-1 py-1.5">
              <button type="button" onClick={() => edit(row)} aria-label={`Edit ${props.describe(row)}`} className="-my-1.5 flex min-h-[44px] w-full items-center break-words text-left text-sm font-semibold">
                {title.render(row)}
              </button>
              {rest.length > 0 && (
                <dl className="mt-1 grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-1 text-xs">
                  {rest.map((c) => (
                    <div key={c.key} className="contents">
                      <dt className="text-muted">{c.label || ''}</dt>
                      <dd className="min-w-0 break-words">{c.render(row)}</dd>
                    </div>
                  ))}
                </dl>
              )}
            </div>
            <div className="flex shrink-0 gap-0.5">{actions(row)}</div>
          </li>
        ))}
      </ul>
    )
  }

  const list = phone ? cards : table

  return (
    <div className={cn('space-y-4', phone && selectedVisible.length > 0 && 'pb-20')}>
      {/* On a phone the rows ticked may be far down a long list: what to do with them stays in view at the foot of the screen. */}
      {phone &&
        selectedVisible.length > 0 &&
        createPortal(
          <div
            role="toolbar"
            aria-label="Selected records"
            className="fixed inset-x-0 bottom-0 z-40 flex items-center gap-2 border-t border-slate-200 bg-white/95 px-4 py-2 backdrop-blur safe-bottom dark:border-slate-800 dark:bg-slate-900/95"
          >
            <span className="min-w-0 flex-1 truncate text-sm font-semibold">{selectedVisible.length} selected</span>
            <Button className="min-h-[44px]" onClick={() => setSelected(new Set())}>
              Clear
            </Button>
            <Button variant="danger" className="min-h-[44px]" onClick={() => setConfirmingMany(true)}>
              <Trash2 className="h-4 w-4" /> Delete
            </Button>
          </div>,
          document.body,
        )}
      <Card className="space-y-4 p-4 sm:p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex min-w-0 items-start gap-3">
            <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-brand-100 text-brand-600 dark:bg-brand-500/15 dark:text-brand-300">
              {props.icon}
            </span>
            <div className="min-w-0">
              <h2 className="text-lg font-bold">{props.title}</h2>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            {props.extraActions}
            <Button
              variant="primary"
              className="min-h-[48px]"
              onClick={() => setEditing({ id: null, draft: props.newDraft() })}
            >
              <Plus className="h-4 w-4" /> {props.addLabel}
            </Button>
          </div>
        </div>


        {!props.loading && rows.length > 0 && (
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative min-w-[16rem] flex-1">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
              <Input
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder={props.searchPlaceholder ?? 'Filter by item code, machine, name…'}
                className="min-h-[48px] pl-9 pr-9"
                aria-label={`Filter ${props.title}`}
              />
              {filter && (
                <button type="button" onClick={() => setFilter('')} aria-label="Clear filter" className="absolute right-2 top-1/2 -translate-y-1/2 rounded-lg p-1.5 text-muted hover:text-slate-600">
                  <X className="h-4 w-4" />
                </button>
              )}
            </div>
            {shown.length > 0 && (
              <Button className="min-h-[48px]" onClick={toggleAll}>
                {allVisibleSelected ? <CheckSquare className="h-4 w-4" /> : <Square className="h-4 w-4" />}
                {allVisibleSelected ? 'Unselect all' : `Select all${filter ? ' shown' : ''}`}
              </Button>
            )}
            {selectedVisible.length > 0 && (
              <>
                <Badge tone="blue">{selectedVisible.length} selected</Badge>
                <Button variant="danger" className="min-h-[48px] max-sm:hidden" onClick={() => setConfirmingMany(true)}>
                  <Trash2 className="h-4 w-4" /> Delete selected
                </Button>
                <Button className="min-h-[48px] max-sm:hidden" onClick={() => setSelected(new Set())}>
                  Clear
                </Button>
              </>
            )}
          </div>
        )}

        {props.loading ? (
          <div className="flex items-center justify-center gap-2 py-12 text-sm text-muted">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading…
          </div>
        ) : rows.length > 0 && sorted.length === 0 ? (
          <EmptyState title="Nothing matches that filter" hint="Try fewer words, or clear the filter." action={<Button onClick={() => setFilter('')}>Clear filter</Button>} />
        ) : sorted.length > 0 && shown.length === 0 ? (
          <EmptyState title="No row matches the column filters" hint="Change a column's filter, or show every row again." action={<Button onClick={view.clear}>Clear the column filters</Button>} />
        ) : sorted.length === 0 ? (
          <EmptyState
            title="Nothing here yet"
            hint={props.emptyHint}
            action={
              <Button
                variant="primary"
                className="min-h-[48px]"
                onClick={() => setEditing({ id: null, draft: props.newDraft() })}
              >
                <Plus className="h-4 w-4" /> {props.addLabel}
              </Button>
            }
          />
        ) : groups ? (
          <div className="space-y-5">
            {groups.map(([group, groupRows]) => (
              <div key={group}>
                <div className="mb-2 flex items-center gap-2">
                  <Badge tone="blue">{props.groupLabel ? props.groupLabel(group) : group}</Badge>
                  <span className="text-xs text-muted">
                    {groupRows.length} {groupRows.length === 1 ? 'entry' : 'entries'}
                  </span>
                </div>
                {list(groupRows)}
              </div>
            ))}
          </div>
        ) : (
          list(shown)
        )}

        {!props.loading && shown.length > 0 && (
          <p className="flex flex-wrap items-center gap-x-2 text-xs text-muted">
            <span>
              {shown.length} {shown.length === 1 ? 'record' : 'records'}
              {shown.length !== rows.length ? ` shown of ${rows.length}` : ''}
            </span>
            {view.active > 0 && (
              <button type="button" onClick={view.clear} className="font-semibold text-brand-700 hover:underline dark:text-brand-300">
                Clear the column filters
              </button>
            )}
          </p>
        )}
      </Card>

      <Modal
        open={editing !== null}
        onClose={() => {
          if (!busy) setEditing(null)
        }}
        title={editing?.id ? `Edit — ${props.title}` : `Add — ${props.title}`}
        icon={props.icon}
        footer={
          <>
            <Button className="min-h-[48px]" onClick={() => setEditing(null)} disabled={busy}>
              Cancel
            </Button>
            <Button variant="primary" className="min-h-[48px]" onClick={() => void save()} disabled={busy}>
              {busy && <Loader2 className="h-4 w-4 animate-spin" />}
              {editing?.id ? 'Save changes' : 'Add'}
            </Button>
          </>
        }
      >
        {editing && <div className="space-y-3">{props.renderForm(editing.draft, patch)}</div>}
      </Modal>

      <Modal
        open={confirmingMany}
        onClose={() => {
          if (!busy) setConfirmingMany(false)
        }}
        title={`Delete ${selectedVisible.length} selected record${selectedVisible.length === 1 ? '' : 's'}?`}
        size="sm"
        icon={<Trash2 className="h-5 w-5" />}
        footer={
          <>
            <Button className="min-h-[48px]" onClick={() => setConfirmingMany(false)} disabled={busy}>
              Keep them
            </Button>
            <Button variant="danger" className="min-h-[48px]" onClick={() => void removeMany()} disabled={busy}>
              {busy && <Loader2 className="h-4 w-4 animate-spin" />}
              Delete {selectedVisible.length}
            </Button>
          </>
        }
      >
        <p className="text-sm">They will stop appearing to inspectors.</p>
        <p className="mt-2 text-sm text-muted">
          Nothing is erased — each record is marked deleted and kept, together with who deleted it, so past inspections stay explainable.
        </p>
      </Modal>

      <Modal
        open={confirming !== null}
        onClose={() => {
          if (!busy) setConfirming(null)
        }}
        title="Delete this record?"
        size="sm"
        icon={<Trash2 className="h-5 w-5" />}
        footer={
          <>
            <Button className="min-h-[48px]" onClick={() => setConfirming(null)} disabled={busy}>
              Keep it
            </Button>
            <Button variant="danger" className="min-h-[48px]" onClick={() => void remove()} disabled={busy}>
              {busy && <Loader2 className="h-4 w-4 animate-spin" />}
              Delete
            </Button>
          </>
        }
      >
        <p className="text-sm" dir="auto">
          <span className="font-semibold">{confirming ? props.describe(confirming) : ''}</span> will
          stop appearing to inspectors.
        </p>
        <p className="mt-2 text-sm text-muted">
          Nothing is erased — the record is marked deleted and kept, together with who deleted it,
          so past inspections stay explainable.
        </p>
      </Modal>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Small form helpers
// ---------------------------------------------------------------------------

export function numberOrNull(v: string): number | null {
  const t = v.trim()
  if (t === '') return null
  const n = Number(t)
  return Number.isFinite(n) ? n : null
}

export function requireText(v: string, label: string): string | null {
  return v.trim() ? null : `${label} is required.`
}

export function requireNumber(v: string, label: string): string | null {
  return numberOrNull(v) === null ? `${label} must be a number.` : null
}

/**
 * A machine chosen from the register. Codes are what orders, defects and
 * dimension rows carry, so the register is the only place they may come from.
 */
export function MachineSelect({
  value,
  onChange,
  allowAny,
  autoFocus,
}: {
  value: string
  onChange: (code: string) => void
  /** Offer "every machine" as the empty choice (dimension rows). */
  allowAny?: boolean
  autoFocus?: boolean
}) {
  const { data: machines = [] } = useMaster('machines')
  const sorted = useMemo(
    () => [...machines].sort((a, b) => (a.factory ?? '').localeCompare(b.factory ?? '') || a.code.localeCompare(b.code, undefined, { numeric: true })),
    [machines],
  )
  const known = sorted.some((m) => m.code.trim().toLowerCase() === value.trim().toLowerCase())
  return (
    <Select className="min-h-[48px]" value={value} onChange={(e) => onChange(e.target.value)} autoFocus={autoFocus}>
      <option value="">{allowAny ? 'Every machine' : '— choose a machine —'}</option>
      {/* A code the register no longer lists is kept selectable so the row can still be edited. */}
      {value && !known && <option value={value}>{value} (not in the machine register)</option>}
      {sorted.map((m) => (
        <option key={m.id} value={m.code}>
          {m.displayName}
          {m.factory ? ` — ${m.factory}` : ''}
        </option>
      ))}
    </Select>
  )
}
