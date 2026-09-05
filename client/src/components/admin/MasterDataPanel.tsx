// ============================================================================
// §7 — the generic master-data panel: list, add, edit, soft-delete. Every
// configuration section is this panel with its own columns and form.
// ============================================================================

import { useCallback, useMemo, useState, type ReactNode } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Info, Loader2, Pencil, Plus, Trash2 } from 'lucide-react'
import { Badge, Button, Card, EmptyState, Modal, Select } from '@/components/ui'
import { useMaster } from '@/services/queries'
import { createMaster, deleteMaster, updateMaster } from '@/services/mutations'
import { useApp } from '@/store/AppContext'
import { can } from '@/domain'
import { cn } from '@/lib/utils'
import type { MasterKind, MasterRecordByKind } from '@qc/shared/api'


export interface Column<T> {
  key: string
  label: string
  render: (row: T) => ReactNode
  className?: string
}

interface PanelProps<K extends MasterKind, D> {
  title: string
  description: string
  hint?: ReactNode
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
}

export function MasterDataPanel<K extends MasterKind, D>(props: PanelProps<K, D>) {
  type T = MasterRecordByKind[K]
  const queryClient = useQueryClient()
  const { toast } = useApp()
  const [editing, setEditing] = useState<{ id: string | null; draft: D } | null>(null)
  const [confirming, setConfirming] = useState<T | null>(null)
  const [busy, setBusy] = useState(false)

  const { rows, sort, groupBy } = props

  const sorted = useMemo(() => {
    const copy = [...rows]
    return sort ? copy.sort(sort) : copy
  }, [rows, sort])

  const groups = useMemo(() => {
    if (!groupBy) return null
    const map = new Map<string, T[]>()
    for (const row of sorted) {
      const g = groupBy(row)
      const arr = map.get(g) ?? []
      arr.push(row)
      map.set(g, arr)
    }
    return Array.from(map.entries()).sort((a, b) =>
      a[0].localeCompare(b[0], undefined, { numeric: true }),
    )
  }, [sorted, groupBy])

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

  const table = (visible: T[]) => (
    <div className="overflow-x-auto rounded-2xl ring-1 ring-slate-200 dark:ring-slate-800">
      <table className={cn('w-full text-sm', props.minTableWidth ?? 'min-w-[40rem]')}>
        <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500 dark:bg-slate-800/60 dark:text-slate-400">
          <tr>
            {props.columns.map((c) => (
              <th key={c.key} className={cn('px-3 py-2.5 font-bold', c.className)}>
                {c.label}
              </th>
            ))}
            <th className="px-3 py-2.5 text-right font-bold">Actions</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
          {visible.map((row) => (
            <tr key={row.id} className="hover:bg-slate-50/70 dark:hover:bg-slate-800/40">
              {props.columns.map((c) => (
                <td key={c.key} className={cn('px-3 py-2.5 align-middle', c.className)}>
                  {c.render(row)}
                </td>
              ))}
              <td className="px-3 py-2 text-right">
                <div className="inline-flex gap-1">
                  <button
                    type="button"
                    onClick={() => setEditing({ id: row.id, draft: props.toDraft(row) })}
                    aria-label={`Edit ${props.describe(row)}`}
                    className="grid h-12 w-12 place-items-center rounded-xl text-slate-400 transition-colors hover:bg-slate-100 hover:text-brand-600 dark:hover:bg-slate-800"
                  >
                    <Pencil className="h-4 w-4" />
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirming(row)}
                    aria-label={`Delete ${props.describe(row)}`}
                    className="grid h-12 w-12 place-items-center rounded-xl text-slate-400 transition-colors hover:bg-rose-50 hover:text-rose-600 dark:hover:bg-rose-500/10"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )

  return (
    <div className="space-y-4">
      <Card className="space-y-4 p-4 sm:p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex min-w-0 items-start gap-3">
            <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-brand-100 text-brand-600 dark:bg-brand-500/15 dark:text-brand-300">
              {props.icon}
            </span>
            <div className="min-w-0">
              <h2 className="text-lg font-bold">{props.title}</h2>
              <p className="mt-0.5 text-sm text-slate-500 dark:text-slate-400">{props.description}</p>
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

        {props.hint && (
          <p className="flex items-start gap-2 rounded-2xl bg-brand-50 px-3 py-2.5 text-sm text-brand-800 dark:bg-brand-500/10 dark:text-brand-200">
            <Info className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{props.hint}</span>
          </p>
        )}

        {props.loading ? (
          <div className="flex items-center justify-center gap-2 py-12 text-sm text-slate-400">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading…
          </div>
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
                  <span className="text-xs text-slate-400">
                    {groupRows.length} {groupRows.length === 1 ? 'entry' : 'entries'}
                  </span>
                </div>
                {table(groupRows)}
              </div>
            ))}
          </div>
        ) : (
          table(sorted)
        )}

        {!props.loading && sorted.length > 0 && (
          <p className="text-xs text-slate-400">
            {sorted.length} {sorted.length === 1 ? 'record' : 'records'}
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
        <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">
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
