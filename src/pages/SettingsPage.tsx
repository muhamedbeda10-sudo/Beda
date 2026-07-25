// ============================================================================
// §7 — Admin. Every piece of master data the inspection wizard depends on is
// maintained here, plus the bulk importers that load production orders, coils
// and production (dimension) data from the ERP exports.
//
// Two rules run through the whole screen:
//   • Nothing is ever hard-deleted (§10) — delete marks the record and audits it.
//   • Imports are idempotent (§7.7) — the same file imported twice updates the
//     same documents rather than duplicating them.
// ============================================================================

import { useCallback, useMemo, useRef, useState, type ReactNode } from 'react'
import { doc, setDoc, writeBatch } from 'firebase/firestore'
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  Factory,
  FileDown,
  FileSpreadsheet,
  FlaskConical,
  Image as ImageIcon,
  Info,
  Layers,
  ListOrdered,
  Loader2,
  Pause,
  Pencil,
  Play,
  Plus,
  RotateCcw,
  Ruler,
  ShieldAlert,
  Shuffle,
  Table2,
  Trash2,
  UploadCloud,
} from 'lucide-react'
import { Badge, Button, Card, EmptyState, Field, Input, Modal, Select, Stat } from '@/components/ui'
import { ImagePicker } from '@/components/inspection/ImagePicker'
import { useAll } from '@/services/useCollection'
import { COL, softDelete, stripUndefined, type AuditContext } from '@/services/repository'
import { useAuth } from '@/store/AuthContext'
import { useApp } from '@/store/AppContext'
import { can } from '@/domain/rules'
import { getDb } from '@/lib/firebase'
import { cn, downloadText, parseCSV, uid } from '@/lib/utils'
import type {
  Coil,
  GradeMapping,
  ItemDimensionMaster,
  ItemDimensionOrder,
  ItemReferenceImage,
  Machine,
  ProductionOrder,
  PTConsumableKind,
  PTConsumableProduct,
  WorkCenterDefect,
} from '@/domain/types'

const WORK_CENTER_CODES = ['7', '11', '22', '48', '58'] as const
const PT_KINDS: readonly PTConsumableKind[] = ['Cleaner', 'Penetrant', 'Developer']

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------

const TABS = [
  { key: 'dimension-order', label: 'Dimension order', icon: ListOrdered },
  { key: 'item-master', label: 'Item master dimensions', icon: Ruler },
  { key: 'reference-images', label: 'Reference images', icon: ImageIcon },
  { key: 'defects', label: 'Work-center defects', icon: AlertTriangle },
  { key: 'machines', label: 'Machines', icon: Factory },
  { key: 'grades', label: 'Grade mappings', icon: Shuffle },
  { key: 'pt-consumables', label: 'PT consumables', icon: FlaskConical },
  { key: 'import', label: 'Bulk import', icon: UploadCloud },
] as const

type TabKey = (typeof TABS)[number]['key']

export function SettingsPage() {
  const { role } = useAuth()
  const [tab, setTab] = useState<TabKey>('dimension-order')

  if (!can(role, 'manage-admin-data')) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-extrabold tracking-tight">Admin</h1>
        <Card className="flex flex-col items-center gap-3 p-8 text-center">
          <span className="grid h-12 w-12 place-items-center rounded-2xl bg-amber-100 text-amber-600 dark:bg-amber-500/15 dark:text-amber-400">
            <ShieldAlert className="h-6 w-6" />
          </span>
          <div>
            <p className="text-lg font-bold">You don't have access to Admin</p>
            <p className="mx-auto mt-1 max-w-md text-sm text-slate-500 dark:text-slate-400">
              Master data and bulk imports are limited to administrators, because a change here
              affects every inspection that follows. Ask an administrator if you need something
              added or corrected.
            </p>
          </div>
          <Badge tone="neutral">Signed in as {role}</Badge>
        </Card>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-extrabold tracking-tight">Admin</h1>
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
          Master data the inspection wizard reads from, and the importers that load it in bulk.
        </p>
      </div>

      <div className="lg:flex lg:items-start lg:gap-6">
        <nav
          aria-label="Admin sections"
          className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-2 lg:mx-0 lg:w-64 lg:shrink-0 lg:flex-col lg:overflow-visible lg:px-0 lg:pb-0"
        >
          {TABS.map((t) => {
            const Icon = t.icon
            const active = tab === t.key
            return (
              <button
                key={t.key}
                type="button"
                onClick={() => setTab(t.key)}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'inline-flex min-h-[48px] shrink-0 items-center gap-2 rounded-2xl px-4 text-sm font-semibold transition-colors lg:w-full lg:justify-start',
                  active
                    ? 'bg-brand-600 text-white shadow-sm'
                    : 'bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700',
                )}
              >
                <Icon className="h-4 w-4 shrink-0" />
                <span className="whitespace-nowrap">{t.label}</span>
              </button>
            )
          })}
        </nav>

        <div className="mt-2 min-w-0 flex-1 lg:mt-0">
          {tab === 'dimension-order' && <DimensionOrderTab />}
          {tab === 'item-master' && <ItemMasterTab />}
          {tab === 'reference-images' && <ReferenceImagesTab />}
          {tab === 'defects' && <WorkCenterDefectsTab />}
          {tab === 'machines' && <MachinesTab />}
          {tab === 'grades' && <GradeMappingsTab />}
          {tab === 'pt-consumables' && <PTConsumablesTab />}
          {tab === 'import' && <BulkImportTab />}
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Shared master-data panel
// ---------------------------------------------------------------------------

interface Column<T> {
  key: string
  label: string
  render: (row: T) => ReactNode
  className?: string
}

interface PanelProps<T extends { id: string }, D> {
  title: string
  description: string
  hint?: ReactNode
  icon: ReactNode
  collectionName: string
  entity: string
  idPrefix: string
  rows: T[]
  loading: boolean
  columns: Column<T>[]
  emptyHint: string
  addLabel: string
  newDraft: () => D
  toDraft: (row: T) => D
  validate: (draft: D) => string | null
  toRecord: (draft: D, id: string, existing?: T) => T
  renderForm: (draft: D, patch: (p: Partial<D>) => void) => ReactNode
  describe: (row: T) => string
  sort?: (a: T, b: T) => number
  groupBy?: (row: T) => string
  groupLabel?: (group: string) => string
  minTableWidth?: string
}

function MasterDataPanel<T extends { id: string }, D>(props: PanelProps<T, D>) {
  const { profile } = useAuth()
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
    const id = editing.id ?? uid(props.idPrefix)
    const existing = editing.id ? rows.find((r) => r.id === editing.id) : undefined
    setBusy(true)
    try {
      const record = props.toRecord(editing.draft, id, existing)
      await setDoc(doc(getDb(), props.collectionName, id), stripUndefined(record))
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
      const ctx: AuditContext = {
        userUid: profile?.uid ?? 'unknown',
        userName: profile?.name ?? 'Unknown',
        entity: props.entity,
        entityId: confirming.id,
      }
      await softDelete(props.collectionName, confirming.id, ctx)
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
          <Button
            variant="primary"
            className="min-h-[48px]"
            onClick={() => setEditing({ id: null, draft: props.newDraft() })}
          >
            <Plus className="h-4 w-4" /> {props.addLabel}
          </Button>
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

function numberOrNull(v: string): number | null {
  const t = v.trim()
  if (t === '') return null
  const n = Number(t)
  return Number.isFinite(n) ? n : null
}

function requireText(v: string, label: string): string | null {
  return v.trim() ? null : `${label} is required.`
}

function requireNumber(v: string, label: string): string | null {
  return numberOrNull(v) === null ? `${label} must be a number.` : null
}

// ---------------------------------------------------------------------------
// 1. Dimension order
// ---------------------------------------------------------------------------

interface DimOrderDraft {
  item: string
  dimensionName: string
  sequence: string
  nominal: string
  tolPlus: string
  tolMinus: string
  unit: string
}

function DimensionOrderTab() {
  const { rows, loading } = useAll<ItemDimensionOrder>(COL.itemDimensionOrder)

  const sort = useCallback(
    (a: ItemDimensionOrder, b: ItemDimensionOrder) =>
      a.item.localeCompare(b.item) || a.sequence - b.sequence,
    [],
  )

  return (
    <MasterDataPanel<ItemDimensionOrder, DimOrderDraft>
      title="Dimension order"
      description="Per-item dimensions, in the order they are measured."
      hint={
        <>
          <strong>Sequence</strong> controls the order the inspector measures in — the wizard lists
          the dimensions from the lowest sequence to the highest, so put the measurement that is
          taken first at the machine at 1. These entries also pre-fill nominal and tolerance.
        </>
      }
      icon={<ListOrdered className="h-5 w-5" />}
      collectionName={COL.itemDimensionOrder}
      entity="itemDimensionOrder"
      idPrefix="ido"
      rows={rows}
      loading={loading}
      sort={sort}
      addLabel="Add dimension"
      emptyHint="Add the dimensions for an item, or load them from the Bulk import tab."
      minTableWidth="min-w-[46rem]"
      columns={[
        { key: 'item', label: 'Item', render: (r) => <span className="font-semibold">{r.item}</span> },
        { key: 'name', label: 'Dimension', render: (r) => <span dir="auto">{r.dimensionName}</span> },
        {
          key: 'seq',
          label: 'Seq',
          className: 'tabular-nums',
          render: (r) => <Badge tone="neutral">{r.sequence}</Badge>,
        },
        {
          key: 'nominal',
          label: 'Nominal',
          className: 'tabular-nums',
          render: (r) => (r.nominal === undefined ? '—' : r.nominal),
        },
        {
          key: 'tol',
          label: 'Tolerance',
          className: 'tabular-nums',
          render: (r) => `+${r.tolPlus} / −${r.tolMinus}`,
        },
        { key: 'unit', label: 'Unit', render: (r) => r.unit || '—' },
      ]}
      describe={(r) => `${r.item} · ${r.dimensionName}`}
      newDraft={() => ({
        item: '',
        dimensionName: '',
        sequence: '1',
        nominal: '',
        tolPlus: '0',
        tolMinus: '0',
        unit: 'mm',
      })}
      toDraft={(r) => ({
        item: r.item,
        dimensionName: r.dimensionName,
        sequence: String(r.sequence),
        nominal: r.nominal === undefined ? '' : String(r.nominal),
        tolPlus: String(r.tolPlus),
        tolMinus: String(r.tolMinus),
        unit: r.unit,
      })}
      validate={(d) =>
        requireText(d.item, 'Item') ??
        requireText(d.dimensionName, 'Dimension name') ??
        requireNumber(d.sequence, 'Sequence') ??
        (d.nominal.trim() !== '' && numberOrNull(d.nominal) === null
          ? 'Nominal must be a number.'
          : null) ??
        requireNumber(d.tolPlus, 'Tolerance +') ??
        requireNumber(d.tolMinus, 'Tolerance −') ??
        requireText(d.unit, 'Unit')
      }
      toRecord={(d, id) => ({
        id,
        item: d.item.trim(),
        dimensionName: d.dimensionName.trim(),
        sequence: Number(d.sequence),
        nominal: numberOrNull(d.nominal) ?? undefined,
        tolPlus: Number(d.tolPlus),
        tolMinus: Number(d.tolMinus),
        unit: d.unit.trim(),
      })}
      renderForm={(d, patch) => (
        <>
          <Field label="Item">
            <Input
              value={d.item}
              onChange={(e) => patch({ item: e.target.value })}
              placeholder="XL Light Beam"
            />
          </Field>
          <Field label="Dimension name">
            <Input
              dir="auto"
              value={d.dimensionName}
              onChange={(e) => patch({ dimensionName: e.target.value })}
              placeholder="Width"
            />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Sequence" hint="Lowest is measured first.">
              <Input
                inputMode="numeric"
                value={d.sequence}
                onChange={(e) => patch({ sequence: e.target.value })}
              />
            </Field>
            <Field label="Unit">
              <Input value={d.unit} onChange={(e) => patch({ unit: e.target.value })} placeholder="mm" />
            </Field>
          </div>
          <div className="grid grid-cols-3 gap-3">
            <Field label="Nominal" hint="Optional.">
              <Input
                inputMode="decimal"
                value={d.nominal}
                onChange={(e) => patch({ nominal: e.target.value })}
              />
            </Field>
            <Field label="Tolerance +">
              <Input
                inputMode="decimal"
                value={d.tolPlus}
                onChange={(e) => patch({ tolPlus: e.target.value })}
              />
            </Field>
            <Field label="Tolerance −">
              <Input
                inputMode="decimal"
                value={d.tolMinus}
                onChange={(e) => patch({ tolMinus: e.target.value })}
              />
            </Field>
          </div>
        </>
      )}
    />
  )
}

// ---------------------------------------------------------------------------
// 2. Item master dimensions
// ---------------------------------------------------------------------------

interface DimMasterDraft {
  item: string
  dimensionName: string
  nominal: string
  tolPlus: string
  tolMinus: string
  unit: string
}

function ItemMasterTab() {
  const { rows, loading } = useAll<ItemDimensionMaster>(COL.itemDimensionMaster)

  const sort = useCallback(
    (a: ItemDimensionMaster, b: ItemDimensionMaster) =>
      a.item.localeCompare(b.item) || a.dimensionName.localeCompare(b.dimensionName),
    [],
  )

  return (
    <MasterDataPanel<ItemDimensionMaster, DimMasterDraft>
      title="Item master dimensions"
      description="Fallback nominal and tolerance when an item has no dimension-order entry."
      hint="The wizard reads the dimension order first; anything not found there falls back to this master list."
      icon={<Ruler className="h-5 w-5" />}
      collectionName={COL.itemDimensionMaster}
      entity="itemDimensionMaster"
      idPrefix="idm"
      rows={rows}
      loading={loading}
      sort={sort}
      addLabel="Add dimension"
      emptyHint="Add the master dimensions inspectors should fall back to."
      columns={[
        { key: 'item', label: 'Item', render: (r) => <span className="font-semibold">{r.item}</span> },
        { key: 'name', label: 'Dimension', render: (r) => <span dir="auto">{r.dimensionName}</span> },
        { key: 'nominal', label: 'Nominal', className: 'tabular-nums', render: (r) => r.nominal },
        {
          key: 'tol',
          label: 'Tolerance',
          className: 'tabular-nums',
          render: (r) => `+${r.tolPlus} / −${r.tolMinus}`,
        },
        { key: 'unit', label: 'Unit', render: (r) => r.unit || '—' },
      ]}
      describe={(r) => `${r.item} · ${r.dimensionName}`}
      newDraft={() => ({
        item: '',
        dimensionName: '',
        nominal: '0',
        tolPlus: '0',
        tolMinus: '0',
        unit: 'mm',
      })}
      toDraft={(r) => ({
        item: r.item,
        dimensionName: r.dimensionName,
        nominal: String(r.nominal),
        tolPlus: String(r.tolPlus),
        tolMinus: String(r.tolMinus),
        unit: r.unit,
      })}
      validate={(d) =>
        requireText(d.item, 'Item') ??
        requireText(d.dimensionName, 'Dimension name') ??
        requireNumber(d.nominal, 'Nominal') ??
        requireNumber(d.tolPlus, 'Tolerance +') ??
        requireNumber(d.tolMinus, 'Tolerance −') ??
        requireText(d.unit, 'Unit')
      }
      toRecord={(d, id) => ({
        id,
        item: d.item.trim(),
        dimensionName: d.dimensionName.trim(),
        nominal: Number(d.nominal),
        tolPlus: Number(d.tolPlus),
        tolMinus: Number(d.tolMinus),
        unit: d.unit.trim(),
      })}
      renderForm={(d, patch) => (
        <>
          <Field label="Item">
            <Input value={d.item} onChange={(e) => patch({ item: e.target.value })} />
          </Field>
          <Field label="Dimension name">
            <Input
              dir="auto"
              value={d.dimensionName}
              onChange={(e) => patch({ dimensionName: e.target.value })}
            />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Nominal">
              <Input
                inputMode="decimal"
                value={d.nominal}
                onChange={(e) => patch({ nominal: e.target.value })}
              />
            </Field>
            <Field label="Unit">
              <Input value={d.unit} onChange={(e) => patch({ unit: e.target.value })} />
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Tolerance +">
              <Input
                inputMode="decimal"
                value={d.tolPlus}
                onChange={(e) => patch({ tolPlus: e.target.value })}
              />
            </Field>
            <Field label="Tolerance −">
              <Input
                inputMode="decimal"
                value={d.tolMinus}
                onChange={(e) => patch({ tolMinus: e.target.value })}
              />
            </Field>
          </div>
        </>
      )}
    />
  )
}

// ---------------------------------------------------------------------------
// 3. Item reference images
// ---------------------------------------------------------------------------

interface RefImageDraft {
  item: string
  caption: string
  imageId: string
}

function ReferenceImagesTab() {
  const { rows, loading } = useAll<ItemReferenceImage>(COL.itemReferenceImages)

  const sort = useCallback(
    (a: ItemReferenceImage, b: ItemReferenceImage) =>
      a.item.localeCompare(b.item) || (a.caption ?? '').localeCompare(b.caption ?? ''),
    [],
  )

  return (
    <MasterDataPanel<ItemReferenceImage, RefImageDraft>
      title="Item reference images"
      description="The approved photo an inspector compares the real part against."
      hint="These images are shown to inspectors during inspection, so they can compare the part in front of them with the reference before judging it."
      icon={<ImageIcon className="h-5 w-5" />}
      collectionName={COL.itemReferenceImages}
      entity="itemReferenceImages"
      idPrefix="iri"
      rows={rows}
      loading={loading}
      sort={sort}
      addLabel="Add reference"
      emptyHint="Attach a reference photo to an item so inspectors have something to compare against."
      minTableWidth="min-w-[34rem]"
      columns={[
        { key: 'item', label: 'Item', render: (r) => <span className="font-semibold">{r.item}</span> },
        { key: 'caption', label: 'Caption', render: (r) => <span dir="auto">{r.caption || '—'}</span> },
        {
          key: 'image',
          label: 'Image',
          render: (r) => (
            <ImagePicker imageIds={r.imageId ? [r.imageId] : []} onChange={() => undefined} readOnly />
          ),
        },
      ]}
      describe={(r) => `${r.item}${r.caption ? ` · ${r.caption}` : ''}`}
      newDraft={() => ({ item: '', caption: '', imageId: '' })}
      toDraft={(r) => ({ item: r.item, caption: r.caption ?? '', imageId: r.imageId })}
      validate={(d) =>
        requireText(d.item, 'Item') ?? (d.imageId.trim() ? null : 'Choose a reference image.')
      }
      toRecord={(d, id) => ({
        id,
        item: d.item.trim(),
        imageId: d.imageId,
        caption: d.caption.trim() || undefined,
      })}
      renderForm={(d, patch) => (
        <>
          <Field label="Item">
            <Input value={d.item} onChange={(e) => patch({ item: e.target.value })} />
          </Field>
          <Field label="Caption" hint="Optional — what the inspector should be looking at.">
            <Input dir="auto" value={d.caption} onChange={(e) => patch({ caption: e.target.value })} />
          </Field>
          <div>
            <span className="label">Reference image</span>
            <ImagePicker
              imageIds={d.imageId ? [d.imageId] : []}
              onChange={(ids) => patch({ imageId: ids[0] ?? '' } as Partial<RefImageDraft>)}
            />
            <p className="mt-1 text-xs text-slate-400">
              One image per entry — adding another replaces the current reference.
            </p>
          </div>
        </>
      )}
    />
  )
}

// ---------------------------------------------------------------------------
// 4. Work-center defects
// ---------------------------------------------------------------------------

interface DefectDraft {
  workCenterCode: string
  defectName: string
}

function WorkCenterDefectsTab() {
  const { rows, loading } = useAll<WorkCenterDefect>(COL.workCenterDefects)

  const sort = useCallback(
    (a: WorkCenterDefect, b: WorkCenterDefect) => a.defectName.localeCompare(b.defectName),
    [],
  )
  const groupBy = useCallback((r: WorkCenterDefect) => r.workCenterCode, [])
  const groupLabel = useCallback((g: string) => `Work centre ${g}`, [])

  return (
    <MasterDataPanel<WorkCenterDefect, DefectDraft>
      title="Work-center defects"
      description="The defect names offered on each work centre, grouped by centre."
      hint="Inspectors only ever see the defects listed for their own work centre, so keep each list short and specific. Arabic names are supported and display right-to-left automatically."
      icon={<AlertTriangle className="h-5 w-5" />}
      collectionName={COL.workCenterDefects}
      entity="workCenterDefects"
      idPrefix="wcd"
      rows={rows}
      loading={loading}
      sort={sort}
      groupBy={groupBy}
      groupLabel={groupLabel}
      addLabel="Add defect"
      emptyHint="Add the defect names inspectors should be able to pick from."
      minTableWidth="min-w-[28rem]"
      columns={[
        {
          key: 'name',
          label: 'Defect name',
          render: (r) => (
            <span dir="auto" className="font-semibold">
              {r.defectName}
            </span>
          ),
        },
        {
          key: 'wc',
          label: 'Work centre',
          render: (r) => <Badge tone="neutral">{r.workCenterCode}</Badge>,
        },
      ]}
      describe={(r) => `${r.defectName} (work centre ${r.workCenterCode})`}
      newDraft={() => ({ workCenterCode: WORK_CENTER_CODES[0], defectName: '' })}
      toDraft={(r) => ({ workCenterCode: r.workCenterCode, defectName: r.defectName })}
      validate={(d) =>
        requireText(d.workCenterCode, 'Work centre') ?? requireText(d.defectName, 'Defect name')
      }
      toRecord={(d, id) => ({
        id,
        workCenterCode: d.workCenterCode,
        defectName: d.defectName.trim(),
      })}
      renderForm={(d, patch) => (
        <>
          <Field label="Work centre">
            <Select
              className="min-h-[48px]"
              value={d.workCenterCode}
              onChange={(e) => patch({ workCenterCode: e.target.value })}
            >
              {WORK_CENTER_CODES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Defect name" hint="Arabic or English.">
            <Input
              dir="auto"
              value={d.defectName}
              onChange={(e) => patch({ defectName: e.target.value })}
              placeholder="خدش سطحى"
            />
          </Field>
        </>
      )}
    />
  )
}

// ---------------------------------------------------------------------------
// 5. Machines
// ---------------------------------------------------------------------------

interface MachineDraft {
  code: string
  name: string
  line: string
}

function MachinesTab() {
  const { rows, loading } = useAll<Machine>(COL.machines)

  const sort = useCallback(
    (a: Machine, b: Machine) =>
      a.code.localeCompare(b.code, undefined, { numeric: true }) ||
      a.line.localeCompare(b.line, undefined, { numeric: true }),
    [],
  )

  return (
    <MasterDataPanel<Machine, MachineDraft>
      title="Machines"
      description="The machines and lines an order can be produced on."
      hint="The work-centre code decides which wizard steps appear — paint centres get the paint sample step, PT centres get the weld inspection step."
      icon={<Factory className="h-5 w-5" />}
      collectionName={COL.machines}
      entity="machines"
      idPrefix="mch"
      rows={rows}
      loading={loading}
      sort={sort}
      addLabel="Add machine"
      emptyHint="Add the machines and lines used on the shop floor."
      minTableWidth="min-w-[42rem]"
      columns={[
        { key: 'code', label: 'Work centre', render: (r) => <Badge tone="blue">{r.code}</Badge> },
        { key: 'name', label: 'Work-centre name', render: (r) => r.name },
        { key: 'line', label: 'Line', render: (r) => r.line || '—' },
        {
          key: 'displayName',
          label: 'Shown as',
          render: (r) => <span className="font-semibold">{r.displayName}</span>,
        },
      ]}
      describe={(r) => r.displayName || r.name}
      newDraft={() => ({ code: WORK_CENTER_CODES[0], name: '', line: '' })}
      toDraft={(r) => ({ code: r.code, name: r.name, line: r.line })}
      validate={(d) =>
        requireText(d.code, 'Work-centre code') ??
        requireText(d.name, 'Work-centre name') ??
        requireText(d.line, 'Line')
      }
      toRecord={(d, id) => {
        const code = d.code.trim()
        const name = d.name.trim()
        const line = d.line.trim()
        return {
          id,
          code,
          name,
          line,
          // The label the shop floor recognises: "58-A. Welding Line-LM4".
          displayName: [code, name, line].filter(Boolean).join('-'),
        }
      }}
      renderForm={(d, patch) => (
        <>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Work-centre code">
              <Select
                className="min-h-[48px]"
                value={d.code}
                onChange={(e) => patch({ code: e.target.value })}
              >
                {WORK_CENTER_CODES.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Line">
              <Input value={d.line} onChange={(e) => patch({ line: e.target.value })} placeholder="LM4" />
            </Field>
          </div>
          <Field label="Work-centre name" hint='Shown as "{code}-{name}-{line}", e.g. 58-A. Welding Line-LM4'>
            <Input
              value={d.name}
              onChange={(e) => patch({ name: e.target.value })}
              placeholder="A. Welding Line"
            />
          </Field>
        </>
      )}
    />
  )
}

// ---------------------------------------------------------------------------
// 6. Grade mappings
// ---------------------------------------------------------------------------

interface GradeDraft {
  gradeA: string
  gradeB: string
}

function GradeMappingsTab() {
  const { rows, loading } = useAll<GradeMapping>(COL.gradeMappings)

  const sort = useCallback(
    (a: GradeMapping, b: GradeMapping) =>
      a.gradeA.localeCompare(b.gradeA) || a.gradeB.localeCompare(b.gradeB),
    [],
  )

  return (
    <MasterDataPanel<GradeMapping, GradeDraft>
      title="Grade mappings"
      description="Grades that count as the same material when a coil is checked against an order."
      hint={
        <>
          Equivalence is <strong>transitive</strong>: if A ≡ B and B ≡ C, then A ≡ C is applied
          automatically. Record each pair once — the reverse direction is implied as well.
        </>
      }
      icon={<Shuffle className="h-5 w-5" />}
      collectionName={COL.gradeMappings}
      entity="gradeMappings"
      idPrefix="gm"
      rows={rows}
      loading={loading}
      sort={sort}
      addLabel="Add mapping"
      emptyHint="Add a pair of grades that should be treated as equivalent."
      minTableWidth="min-w-[26rem]"
      columns={[
        { key: 'a', label: 'Grade A', render: (r) => <span className="font-semibold">{r.gradeA}</span> },
        { key: 'eq', label: '', className: 'w-8 text-center text-slate-400', render: () => '≡' },
        { key: 'b', label: 'Grade B', render: (r) => <span className="font-semibold">{r.gradeB}</span> },
      ]}
      describe={(r) => `${r.gradeA} ≡ ${r.gradeB}`}
      newDraft={() => ({ gradeA: '', gradeB: '' })}
      toDraft={(r) => ({ gradeA: r.gradeA, gradeB: r.gradeB })}
      validate={(d) =>
        requireText(d.gradeA, 'Grade A') ??
        requireText(d.gradeB, 'Grade B') ??
        (d.gradeA.trim().toLowerCase() === d.gradeB.trim().toLowerCase()
          ? 'Both grades are the same — no mapping is needed.'
          : null)
      }
      toRecord={(d, id) => ({ id, gradeA: d.gradeA.trim(), gradeB: d.gradeB.trim() })}
      renderForm={(d, patch) => (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Grade A">
            <Input
              value={d.gradeA}
              onChange={(e) => patch({ gradeA: e.target.value })}
              placeholder="S355JR"
            />
          </Field>
          <Field label="Grade B">
            <Input
              value={d.gradeB}
              onChange={(e) => patch({ gradeB: e.target.value })}
              placeholder="ST52-3"
            />
          </Field>
        </div>
      )}
    />
  )
}

// ---------------------------------------------------------------------------
// 7. PT consumables
// ---------------------------------------------------------------------------

interface PTDraft {
  kind: PTConsumableKind
  productName: string
  lotBatch: string
}

function PTConsumablesTab() {
  const { rows, loading } = useAll<PTConsumableProduct>(COL.ptConsumables)

  const sort = useCallback(
    (a: PTConsumableProduct, b: PTConsumableProduct) =>
      PT_KINDS.indexOf(a.kind) - PT_KINDS.indexOf(b.kind) ||
      a.productName.localeCompare(b.productName),
    [],
  )

  return (
    <MasterDataPanel<PTConsumableProduct, PTDraft>
      title="PT consumables"
      description="Cleaner, penetrant and developer products offered on the PT / weld step."
      hint="The lot / batch recorded on a PT inspection is the chemical audit trail — keep these current so inspectors pick from the list instead of typing."
      icon={<FlaskConical className="h-5 w-5" />}
      collectionName={COL.ptConsumables}
      entity="ptConsumables"
      idPrefix="ptc"
      rows={rows}
      loading={loading}
      sort={sort}
      addLabel="Add consumable"
      emptyHint="Add the PT consumables in use, with their current lot numbers."
      minTableWidth="min-w-[32rem]"
      columns={[
        {
          key: 'kind',
          label: 'Kind',
          render: (r) => (
            <Badge tone={r.kind === 'Cleaner' ? 'blue' : r.kind === 'Penetrant' ? 'red' : 'violet'}>
              {r.kind}
            </Badge>
          ),
        },
        {
          key: 'name',
          label: 'Product',
          render: (r) => <span className="font-semibold">{r.productName}</span>,
        },
        {
          key: 'lot',
          label: 'Lot / batch',
          render: (r) => <span className="tabular-nums">{r.lotBatch}</span>,
        },
      ]}
      describe={(r) => `${r.kind} — ${r.productName}`}
      newDraft={() => ({ kind: 'Cleaner', productName: '', lotBatch: '' })}
      toDraft={(r) => ({ kind: r.kind, productName: r.productName, lotBatch: r.lotBatch })}
      validate={(d) =>
        requireText(d.productName, 'Product name') ?? requireText(d.lotBatch, 'Lot / batch')
      }
      toRecord={(d, id) => ({
        id,
        kind: d.kind,
        productName: d.productName.trim(),
        lotBatch: d.lotBatch.trim(),
      })}
      renderForm={(d, patch) => (
        <>
          <Field label="Kind">
            <Select
              className="min-h-[48px]"
              value={d.kind}
              onChange={(e) => patch({ kind: e.target.value as PTConsumableKind })}
            >
              {PT_KINDS.map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Product name">
            <Input
              value={d.productName}
              onChange={(e) => patch({ productName: e.target.value })}
              placeholder="SKL-SP2 Red Penetrant"
            />
          </Field>
          <Field label="Lot / batch">
            <Input
              value={d.lotBatch}
              onChange={(e) => patch({ lotBatch: e.target.value })}
              placeholder="B24-0417"
            />
          </Field>
        </>
      )}
    />
  )
}

// ---------------------------------------------------------------------------
// 8. Bulk import (§7)
// ---------------------------------------------------------------------------

type CellValue = string | number

interface ImportField {
  /** Also the CSV template header, and the name error messages use. */
  key: string
  label: string
  kind: 'text' | 'number'
  aliases?: string[]
  sample: string
}

interface Importer<T extends { id: string }> {
  id: string
  title: string
  description: string
  collectionName: string
  idPrefix: string
  templateFile: string
  fields: ImportField[]
  /** Fields that together form the business key. Import is blocked if unmapped. */
  businessKeys: string[]
  existing: T[]
  loading: boolean
  keyOf: (row: T) => string
  build: (values: Record<string, CellValue>, previous: T | undefined, id: string) => T
}

const BATCH_SIZE = 100

function normaliseHeader(h: string): string {
  return h.toLowerCase().replace(/[^a-z0-9]/g, '')
}

function normaliseKeyPart(v: unknown): string {
  return String(v ?? '').trim().toLowerCase()
}

/** FNV-1a — a short, stable suffix so two different business keys can never
 *  collide on the same document id after the slug strips their characters. */
function keyHash(s: string): string {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return (h >>> 0).toString(36)
}

/** Deterministic document id derived from the business key, so re-importing the
 *  same file updates the same documents instead of duplicating them (§7.7). */
function deterministicId(prefix: string, key: string): string {
  const slug = key
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60)
  return `${prefix}_${slug ? `${slug}_` : ''}${keyHash(key)}`
}

function csvCell(v: string): string {
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v
}

/** Unmapped columns leave the existing value alone, so a partial file can be
 *  used to correct one column without wiping the rest of the record. */
function str(v: CellValue | undefined, previous: string | undefined, fallback = ''): string {
  return v === undefined ? (previous ?? fallback) : String(v)
}

function num(v: CellValue | undefined, previous: number | undefined, fallback = 0): number {
  return v === undefined ? (previous ?? fallback) : Number(v)
}

function BulkImportTab() {
  const [which, setWhich] = useState<'orders' | 'coils' | 'production'>('orders')

  const { rows: orders, loading: ordersLoading } = useAll<ProductionOrder>(COL.orders)
  const { rows: coils, loading: coilsLoading } = useAll<Coil>(COL.coils)
  const { rows: dims, loading: dimsLoading } = useAll<ItemDimensionOrder>(COL.itemDimensionOrder)

  const ordersImporter = useMemo<Importer<ProductionOrder>>(
    () => ({
      id: 'orders',
      title: 'Production orders',
      description: 'Existing orders are matched and updated on the order number.',
      collectionName: COL.orders,
      idPrefix: 'ord',
      templateFile: 'production-orders-template.csv',
      businessKeys: ['orderNumber'],
      existing: orders,
      loading: ordersLoading,
      keyOf: (r) => normaliseKeyPart(r.orderNumber),
      fields: [
        {
          key: 'orderNumber',
          label: 'Order number',
          kind: 'text',
          aliases: ['order', 'order no', 'ordernr', 'po'],
          sample: '20480-Ph1.4-SMA',
        },
        { key: 'item', label: 'Item', kind: 'text', aliases: ['item name', 'description'], sample: 'Shuttle Beam' },
        { key: 'itemCode', label: 'Item code', kind: 'text', aliases: ['code', 'part code'], sample: 'LB406015-5TA3' },
        {
          key: 'workCenterCode',
          label: 'Work centre',
          kind: 'text',
          aliases: ['work center', 'work centre', 'wc'],
          sample: '48',
        },
        { key: 'requiredQty', label: 'Required qty', kind: 'number', aliases: ['required', 'quantity'], sample: '1350' },
        { key: 'finishedQty', label: 'Finished qty', kind: 'number', aliases: ['finished', 'produced'], sample: '900' },
        { key: 'drawing', label: 'Drawing', kind: 'text', aliases: ['dwg'], sample: 'BS9059/48' },
        {
          key: 'drawingAlt',
          label: 'Alternative drawing',
          kind: 'text',
          aliases: ['drawing 2', 'alt drawing'],
          sample: 'BS9059/48-ALT',
        },
        { key: 'issue', label: 'Issue', kind: 'text', aliases: ['rev', 'revision'], sample: 'Rev C' },
        { key: 'material', label: 'Material', kind: 'text', sample: 'Steel' },
        { key: 'expectedGrade', label: 'Expected grade', kind: 'text', aliases: ['grade'], sample: 'ST52-3' },
        { key: 'customer', label: 'Customer', kind: 'text', aliases: ['client'], sample: 'Alpha Racking' },
        { key: 'type', label: 'Type', kind: 'text', sample: 'Export' },
        { key: 'colour', label: 'Colour', kind: 'text', aliases: ['color', 'ral'], sample: 'RAL7016' },
        {
          key: 'date',
          label: 'Date',
          kind: 'text',
          aliases: ['order date'],
          sample: new Date().toISOString().slice(0, 10),
        },
      ],
      build: (v, prev, id) => ({
        id,
        orderNumber: str(v.orderNumber, prev?.orderNumber),
        item: str(v.item, prev?.item),
        itemCode: str(v.itemCode, prev?.itemCode),
        workCenterCode: str(v.workCenterCode, prev?.workCenterCode),
        machineId: prev?.machineId,
        requiredQty: num(v.requiredQty, prev?.requiredQty),
        finishedQty: num(v.finishedQty, prev?.finishedQty),
        drawing: str(v.drawing, prev?.drawing),
        drawingAlt: v.drawingAlt === undefined ? prev?.drawingAlt : String(v.drawingAlt),
        issue: v.issue === undefined ? prev?.issue : String(v.issue),
        material: str(v.material, prev?.material),
        expectedGrade: str(v.expectedGrade, prev?.expectedGrade),
        customer: str(v.customer, prev?.customer),
        type: str(v.type, prev?.type),
        colour: str(v.colour, prev?.colour),
        date: str(v.date, prev?.date, new Date().toISOString()),
      }),
    }),
    [orders, ordersLoading],
  )

  const coilsImporter = useMemo<Importer<Coil>>(
    () => ({
      id: 'coils',
      title: 'Coils',
      description: 'Existing coils are matched and updated on the coil number.',
      collectionName: COL.coils,
      idPrefix: 'coil',
      templateFile: 'coils-template.csv',
      businessKeys: ['coilNumber'],
      existing: coils,
      loading: coilsLoading,
      keyOf: (r) => normaliseKeyPart(r.coilNumber),
      fields: [
        {
          key: 'coilNumber',
          label: 'Coil number',
          kind: 'text',
          aliases: ['coil', 'coil id', 'coil no'],
          sample: 'C10021',
        },
        { key: 'grade', label: 'Grade', kind: 'text', sample: 'S355JR' },
        { key: 'smType', label: 'SM type', kind: 'text', aliases: ['sm', 'type'], sample: 'HR' },
        { key: 'supplier', label: 'Supplier', kind: 'text', aliases: ['vendor', 'mill'], sample: 'Ezz Steel' },
        { key: 'thickness', label: 'Thickness', kind: 'number', aliases: ['thk'], sample: '2.5' },
        { key: 'width', label: 'Width', kind: 'number', sample: '1250' },
        { key: 'yield', label: 'Yield', kind: 'number', aliases: ['yield strength'], sample: '355' },
        { key: 'notes', label: 'Notes', kind: 'text', aliases: ['remarks', 'comment'], sample: '' },
      ],
      build: (v, prev, id) => ({
        id,
        coilNumber: str(v.coilNumber, prev?.coilNumber),
        grade: v.grade === undefined ? prev?.grade : String(v.grade),
        smType: v.smType === undefined ? prev?.smType : String(v.smType),
        supplier: v.supplier === undefined ? prev?.supplier : String(v.supplier),
        thickness: v.thickness === undefined ? prev?.thickness : Number(v.thickness),
        width: v.width === undefined ? prev?.width : Number(v.width),
        yield: v.yield === undefined ? prev?.yield : Number(v.yield),
        notes: v.notes === undefined ? prev?.notes : String(v.notes),
      }),
    }),
    [coils, coilsLoading],
  )

  const productionImporter = useMemo<Importer<ItemDimensionOrder>>(
    () => ({
      id: 'production',
      title: 'Production data',
      description:
        'Item dimensions and the sequence they are measured in. Matched on item + dimension name.',
      collectionName: COL.itemDimensionOrder,
      idPrefix: 'ido',
      templateFile: 'production-data-template.csv',
      businessKeys: ['item', 'dimensionName'],
      existing: dims,
      loading: dimsLoading,
      keyOf: (r) => `${normaliseKeyPart(r.item)}||${normaliseKeyPart(r.dimensionName)}`,
      fields: [
        { key: 'item', label: 'Item', kind: 'text', aliases: ['item name', 'product'], sample: 'XL Light Beam' },
        {
          key: 'dimensionName',
          label: 'Dimension name',
          kind: 'text',
          aliases: ['dimension', 'name', 'characteristic'],
          sample: 'Width',
        },
        { key: 'sequence', label: 'Sequence', kind: 'number', aliases: ['seq', 'order', 'no'], sample: '1' },
        { key: 'nominal', label: 'Nominal', kind: 'number', aliases: ['target', 'nom'], sample: '125' },
        { key: 'tolPlus', label: 'Tolerance +', kind: 'number', aliases: ['tol plus', 'upper', 'plus'], sample: '0.5' },
        {
          key: 'tolMinus',
          label: 'Tolerance −',
          kind: 'number',
          aliases: ['tol minus', 'lower', 'minus'],
          sample: '0.5',
        },
        { key: 'unit', label: 'Unit', kind: 'text', aliases: ['uom'], sample: 'mm' },
      ],
      build: (v, prev, id) => ({
        id,
        item: str(v.item, prev?.item),
        dimensionName: str(v.dimensionName, prev?.dimensionName),
        sequence: num(v.sequence, prev?.sequence, 1),
        nominal: v.nominal === undefined ? prev?.nominal : Number(v.nominal),
        tolPlus: num(v.tolPlus, prev?.tolPlus),
        tolMinus: num(v.tolMinus, prev?.tolMinus),
        unit: str(v.unit, prev?.unit, 'mm'),
      }),
    }),
    [dims, dimsLoading],
  )

  const SOURCES = [
    { key: 'orders', label: 'Production orders', icon: Layers },
    { key: 'coils', label: 'Coils', icon: Table2 },
    { key: 'production', label: 'Production data', icon: Ruler },
  ] as const

  return (
    <div className="space-y-4">
      <Card className="space-y-4 p-4 sm:p-5">
        <div className="flex min-w-0 items-start gap-3">
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-brand-100 text-brand-600 dark:bg-brand-500/15 dark:text-brand-300">
            <UploadCloud className="h-5 w-5" />
          </span>
          <div className="min-w-0">
            <h2 className="text-lg font-bold">Bulk import</h2>
            <p className="mt-0.5 text-sm text-slate-500 dark:text-slate-400">
              Load a CSV export, check exactly what it would change, then import. Nothing is written
              until you press Import — and importing the same file twice updates the same records
              rather than creating duplicates.
            </p>
          </div>
        </div>

        <div className="flex gap-2 overflow-x-auto pb-1">
          {SOURCES.map((t) => {
            const Icon = t.icon
            const active = which === t.key
            return (
              <button
                key={t.key}
                type="button"
                onClick={() => setWhich(t.key)}
                aria-current={active ? 'true' : undefined}
                className={cn(
                  'inline-flex min-h-[48px] shrink-0 items-center gap-2 rounded-2xl px-4 text-sm font-semibold transition-colors',
                  active
                    ? 'bg-slate-900 text-white dark:bg-white dark:text-slate-900'
                    : 'bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700',
                )}
              >
                <Icon className="h-4 w-4" />
                <span className="whitespace-nowrap">{t.label}</span>
              </button>
            )
          })}
        </div>
      </Card>

      {which === 'orders' && <CsvImporter key="orders" importer={ordersImporter} />}
      {which === 'coils' && <CsvImporter key="coils" importer={coilsImporter} />}
      {which === 'production' && <CsvImporter key="production" importer={productionImporter} />}
    </div>
  )
}

// ---- The importer itself ---------------------------------------------------

interface PlannedRow<T> {
  rowNumber: number
  docId: string
  record: T
  values: Record<string, CellValue>
  mode: 'new' | 'update'
}

interface RowError {
  rowNumber: number
  message: string
}

interface Plan<T> {
  valid: PlannedRow<T>[]
  errors: RowError[]
  newCount: number
  updateCount: number
}

type RunStatus = 'idle' | 'running' | 'paused' | 'done'

function CsvImporter<T extends { id: string }>({ importer }: { importer: Importer<T> }) {
  const { toast } = useApp()
  const fileRef = useRef<HTMLInputElement>(null)

  const [dragging, setDragging] = useState(false)
  const [fileName, setFileName] = useState<string | null>(null)
  const [headers, setHeaders] = useState<string[]>([])
  const [dataRows, setDataRows] = useState<string[][]>([])
  const [mapping, setMapping] = useState<Record<string, number>>({})
  const [parseError, setParseError] = useState<string | null>(null)

  const [status, setStatus] = useState<RunStatus>('idle')
  const [written, setWritten] = useState(0)
  const [runTotal, setRunTotal] = useState(0)
  const [runError, setRunError] = useState<string | null>(null)

  const pausedRef = useRef(false)
  const cursorRef = useRef(0)
  const runPlanRef = useRef<PlannedRow<T>[]>([])

  const locked = status === 'running' || status === 'paused'

  const resetRun = useCallback(() => {
    pausedRef.current = false
    cursorRef.current = 0
    runPlanRef.current = []
    setStatus('idle')
    setWritten(0)
    setRunTotal(0)
    setRunError(null)
  }, [])

  const autoMap = useCallback(
    (cols: string[]) => {
      const byNorm = new Map<string, number>()
      cols.forEach((c, i) => {
        const n = normaliseHeader(c)
        if (n && !byNorm.has(n)) byNorm.set(n, i)
      })
      const next: Record<string, number> = {}
      for (const f of importer.fields) {
        const candidates = [f.key, f.label, ...(f.aliases ?? [])].map(normaliseHeader)
        const hit = candidates.map((c) => byNorm.get(c)).find((i) => i !== undefined)
        next[f.key] = hit ?? -1
      }
      return next
    },
    [importer],
  )

  const loadFile = useCallback(
    async (file: File | undefined | null) => {
      if (!file) return
      resetRun()
      setParseError(null)
      try {
        const text = (await file.text()).replace(/^﻿/, '')
        const grid = parseCSV(text)
        setFileName(file.name)
        if (grid.length === 0) {
          setHeaders([])
          setDataRows([])
          setMapping({})
          setParseError('That file has no rows in it.')
          return
        }
        const cols = grid[0].map((h) => h.trim())
        const rest = grid.slice(1)
        setHeaders(cols)
        setDataRows(rest)
        setMapping(autoMap(cols))
        if (rest.length === 0) setParseError('That file has a header row but no data rows.')
      } catch {
        setParseError('That file could not be read. Save it as CSV and try again.')
      }
    },
    [autoMap, resetRun],
  )

  const missingKeys = useMemo(
    () => importer.businessKeys.filter((k) => (mapping[k] ?? -1) < 0),
    [importer.businessKeys, mapping],
  )

  /** The dry run. Pure: it computes what WOULD be written and never writes. */
  const plan = useMemo<Plan<T> | null>(() => {
    if (headers.length === 0 || dataRows.length === 0) return null
    if (missingKeys.length > 0) return null

    const existingByKey = new Map<string, T>()
    for (const row of importer.existing) existingByKey.set(importer.keyOf(row), row)

    const builtByKey = new Map<string, T>()
    const idByKey = new Map<string, string>()
    const valid: PlannedRow<T>[] = []
    const errors: RowError[] = []
    let newCount = 0
    let updateCount = 0

    dataRows.forEach((row, i) => {
      // The header is line 1, so data row i is the line the user sees in their
      // spreadsheet at i + 2. Errors have to point at that line, not at an index.
      const rowNumber = i + 2
      const values: Record<string, CellValue> = {}
      const problems: string[] = []

      for (const f of importer.fields) {
        const col = mapping[f.key] ?? -1
        if (col < 0) continue
        const raw = (row[col] ?? '').trim()
        if (raw === '') continue
        if (f.kind === 'number') {
          const n = Number(raw.replace(/,/g, ''))
          if (!Number.isFinite(n)) {
            problems.push(`${f.key} is not a number ("${raw}")`)
            continue
          }
          values[f.key] = n
        } else {
          values[f.key] = raw
        }
      }

      for (const k of importer.businessKeys) {
        if (values[k] === undefined || String(values[k]).trim() === '') {
          problems.push(`${k} is empty`)
        }
      }

      if (problems.length > 0) {
        errors.push({ rowNumber, message: problems.join('; ') })
        return
      }

      const key = importer.businessKeys.map((k) => normaliseKeyPart(values[k])).join('||')
      const existing = existingByKey.get(key)
      const previous = builtByKey.get(key) ?? existing
      const docId = idByKey.get(key) ?? existing?.id ?? deterministicId(importer.idPrefix, key)
      idByKey.set(key, docId)

      const record = importer.build(values, previous, docId)
      const mode: 'new' | 'update' = previous ? 'update' : 'new'
      if (mode === 'new') newCount += 1
      else updateCount += 1
      builtByKey.set(key, record)
      valid.push({ rowNumber, docId, record, values, mode })
    })

    return { valid, errors, newCount, updateCount }
  }, [headers, dataRows, mapping, missingKeys, importer])

  const mappedFields = useMemo(
    () => importer.fields.filter((f) => (mapping[f.key] ?? -1) >= 0),
    [importer.fields, mapping],
  )

  /**
   * Write in batches, from the cursor onwards. Pausing leaves the cursor where
   * it is, so resuming continues from the next unwritten row and never rewrites
   * a row that already landed.
   */
  async function run() {
    const source = status === 'paused' ? runPlanRef.current : plan?.valid
    if (!source || source.length === 0) return

    if (status !== 'paused') {
      runPlanRef.current = source
      cursorRef.current = 0
      setWritten(0)
      setRunTotal(source.length)
    }

    pausedRef.current = false
    setRunError(null)
    setStatus('running')

    try {
      const store = getDb()
      const rows = runPlanRef.current
      while (cursorRef.current < rows.length) {
        if (pausedRef.current) {
          setStatus('paused')
          return
        }
        const chunk = rows.slice(cursorRef.current, cursorRef.current + BATCH_SIZE)
        const batch = writeBatch(store)
        for (const p of chunk) {
          batch.set(doc(store, importer.collectionName, p.docId), stripUndefined(p.record))
        }
        await batch.commit()
        cursorRef.current += chunk.length
        setWritten(cursorRef.current)
      }
      setStatus('done')
      toast(`Imported ${rows.length} row${rows.length === 1 ? '' : 's'}.`, 'success')
    } catch (e) {
      setStatus('paused')
      const done = cursorRef.current
      setRunError(
        `${e instanceof Error ? e.message : 'The import stopped unexpectedly.'} ${done} row${
          done === 1 ? '' : 's'
        } already imported — resume to continue from there.`,
      )
    }
  }

  function downloadTemplate() {
    const head = importer.fields.map((f) => csvCell(f.key)).join(',')
    const sample = importer.fields.map((f) => csvCell(f.sample)).join(',')
    downloadText(importer.templateFile, `${head}\n${sample}\n`)
  }

  function clearFile() {
    resetRun()
    setFileName(null)
    setHeaders([])
    setDataRows([])
    setMapping({})
    setParseError(null)
    if (fileRef.current) fileRef.current.value = ''
  }

  const progressPct = runTotal > 0 ? Math.round((written / runTotal) * 100) : 0
  const hasFile = headers.length > 0 && dataRows.length > 0

  return (
    <div className="space-y-4">
      {/* ---- Source file ---- */}
      <Card className="space-y-4 p-4 sm:p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="text-base font-bold">{importer.title}</h3>
            <p className="mt-0.5 text-sm text-slate-500 dark:text-slate-400">{importer.description}</p>
          </div>
          <Button className="min-h-[48px]" onClick={downloadTemplate}>
            <FileDown className="h-4 w-4" /> Download CSV template
          </Button>
        </div>

        <div
          onDragOver={(e) => {
            e.preventDefault()
            if (!locked) setDragging(true)
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault()
            setDragging(false)
            if (locked) return
            void loadFile(e.dataTransfer.files?.[0])
          }}
          className={cn(
            'rounded-2xl border-2 border-dashed px-4 py-8 text-center transition-colors',
            dragging
              ? 'border-brand-500 bg-brand-50 dark:bg-brand-500/10'
              : 'border-slate-300 dark:border-slate-700',
            locked && 'opacity-60',
          )}
        >
          <FileSpreadsheet className="mx-auto h-8 w-8 text-slate-300 dark:text-slate-600" />
          <p className="mt-2 text-sm font-semibold">{fileName ?? 'Drop a .csv file here'}</p>
          <p className="mt-0.5 text-xs text-slate-400">
            {fileName
              ? `${dataRows.length} data row${dataRows.length === 1 ? '' : 's'} · ${headers.length} column${headers.length === 1 ? '' : 's'}`
              : 'The first row must contain the column headers.'}
          </p>
          <div className="mt-3 flex flex-wrap justify-center gap-2">
            <Button
              variant="primary"
              className="min-h-[48px]"
              onClick={() => fileRef.current?.click()}
              disabled={locked}
            >
              <UploadCloud className="h-4 w-4" /> Browse files
            </Button>
            {fileName && (
              <Button className="min-h-[48px]" onClick={clearFile} disabled={status === 'running'}>
                <RotateCcw className="h-4 w-4" /> Start over
              </Button>
            )}
          </div>
          <input
            ref={fileRef}
            type="file"
            accept=".csv,text/csv"
            hidden
            onChange={(e) => {
              void loadFile(e.target.files?.[0])
            }}
          />
        </div>

        {parseError && (
          <p className="flex items-start gap-2 rounded-2xl bg-rose-50 px-3 py-2.5 text-sm text-rose-700 dark:bg-rose-500/10 dark:text-rose-300">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" /> {parseError}
          </p>
        )}
      </Card>

      {/* ---- Column mapping ---- */}
      {hasFile && (
        <Card className="space-y-4 p-4 sm:p-5">
          <div>
            <h3 className="text-base font-bold">Match your columns</h3>
            <p className="mt-0.5 text-sm text-slate-500 dark:text-slate-400">
              Columns whose names matched are already selected. The sample under each one comes from
              the first data row, so you can confirm the mapping is right before importing. Anything
              you don't need can be skipped.
            </p>
          </div>

          {missingKeys.length > 0 && (
            <p className="flex items-start gap-2 rounded-2xl bg-amber-50 px-3 py-2.5 text-sm text-amber-800 dark:bg-amber-500/10 dark:text-amber-300">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>
                {missingKeys.join(' and ')} {missingKeys.length === 1 ? 'is' : 'are'} how existing
                records are matched, so {missingKeys.length === 1 ? 'it' : 'they'} must be mapped
                before this file can be imported.
              </span>
            </p>
          )}

          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {importer.fields.map((f) => {
              const col = mapping[f.key] ?? -1
              const isKey = importer.businessKeys.includes(f.key)
              const sample = col >= 0 ? (dataRows[0]?.[col] ?? '').trim() : ''
              return (
                <div key={f.key}>
                  <Field
                    label={isKey ? `${f.label} *` : f.label}
                    hint={col >= 0 ? `Sample: ${sample === '' ? '(empty)' : sample}` : undefined}
                  >
                    <Select
                      className="min-h-[48px]"
                      value={String(col)}
                      disabled={locked}
                      onChange={(e) => {
                        const next = Number(e.target.value)
                        setMapping((m) => ({ ...m, [f.key]: next }))
                        resetRun()
                      }}
                    >
                      <option value="-1">— skip —</option>
                      {headers.map((h, i) => (
                        <option key={`${i}-${h}`} value={String(i)}>
                          {h || `Column ${i + 1}`}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  {isKey && col < 0 && (
                    <p className="mt-1 text-xs font-semibold text-amber-600 dark:text-amber-400">
                      Required — records are matched on this.
                    </p>
                  )}
                </div>
              )
            })}
          </div>
        </Card>
      )}

      {/* ---- Dry run + import ---- */}
      {plan && (
        <Card className="space-y-4 p-4 sm:p-5">
          <div>
            <h3 className="text-base font-bold">Preview — nothing has been written yet</h3>
            <p className="mt-0.5 text-sm text-slate-500 dark:text-slate-400">
              This is exactly what pressing Import would do.
            </p>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Stat
              label="New records"
              value={plan.newCount}
              icon={<Plus className="h-5 w-5" />}
              tone="green"
            />
            <Stat
              label="Would be updated"
              value={plan.updateCount}
              sub="Matched on the business key"
              icon={<RotateCcw className="h-5 w-5" />}
              tone="blue"
            />
            <Stat
              label="Rows skipped"
              value={plan.errors.length}
              sub={plan.errors.length > 0 ? 'Listed below with the reason' : 'No problems found'}
              icon={<AlertTriangle className="h-5 w-5" />}
              tone={plan.errors.length > 0 ? 'amber' : 'neutral'}
            />
          </div>

          {plan.valid.length > 0 && (
            <div>
              <p className="mb-2 text-xs font-bold uppercase tracking-wide text-slate-400">
                First {Math.min(5, plan.valid.length)} of {plan.valid.length} mapped rows
              </p>
              <div className="overflow-x-auto rounded-2xl ring-1 ring-slate-200 dark:ring-slate-800">
                <table className="w-full min-w-[40rem] text-sm">
                  <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500 dark:bg-slate-800/60 dark:text-slate-400">
                    <tr>
                      <th className="px-3 py-2.5 font-bold">Row</th>
                      <th className="px-3 py-2.5 font-bold">Action</th>
                      {mappedFields.map((f) => (
                        <th key={f.key} className="px-3 py-2.5 font-bold">
                          {f.label}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                    {plan.valid.slice(0, 5).map((p) => (
                      <tr key={p.rowNumber}>
                        <td className="px-3 py-2.5 tabular-nums text-slate-400">{p.rowNumber}</td>
                        <td className="px-3 py-2.5">
                          <Badge tone={p.mode === 'new' ? 'green' : 'blue'}>
                            {p.mode === 'new' ? 'New' : 'Update'}
                          </Badge>
                        </td>
                        {mappedFields.map((f) => (
                          <td key={f.key} dir="auto" className="whitespace-nowrap px-3 py-2.5">
                            {p.values[f.key] === undefined ? '—' : String(p.values[f.key])}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {plan.errors.length > 0 && (
            <div>
              <p className="mb-2 text-xs font-bold uppercase tracking-wide text-slate-400">
                Rows that will be skipped
              </p>
              <ul className="max-h-60 space-y-1 overflow-y-auto rounded-2xl bg-rose-50 p-3 text-sm text-rose-800 dark:bg-rose-500/10 dark:text-rose-300">
                {plan.errors.slice(0, 25).map((e) => (
                  <li key={e.rowNumber} className="flex items-start gap-2">
                    <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                    <span dir="auto">
                      Row {e.rowNumber}: {e.message}
                    </span>
                  </li>
                ))}
                {plan.errors.length > 25 && (
                  <li className="pl-6 text-xs opacity-80">
                    …and {plan.errors.length - 25} more. Every other row still imports.
                  </li>
                )}
              </ul>
            </div>
          )}

          <div className="space-y-3 border-t border-slate-100 pt-4 dark:border-slate-800">
            {status !== 'idle' && (
              <div>
                <div className="mb-1.5 flex items-center justify-between gap-2 text-xs font-semibold text-slate-500 dark:text-slate-400">
                  <span>
                    {status === 'done'
                      ? 'Import complete'
                      : status === 'paused'
                        ? 'Paused — rows already written will not be written again'
                        : 'Importing…'}
                  </span>
                  <span className="tabular-nums">
                    {written} / {runTotal} ({progressPct}%)
                  </span>
                </div>
                <div className="h-2 overflow-hidden rounded-full bg-slate-200 dark:bg-slate-800">
                  <div
                    role="progressbar"
                    aria-valuenow={progressPct}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    className={cn(
                      'h-full rounded-full transition-all',
                      status === 'done' ? 'bg-emerald-500' : 'bg-brand-600',
                    )}
                    style={{ width: `${progressPct}%` }}
                  />
                </div>
              </div>
            )}

            {runError && (
              <p className="flex items-start gap-2 rounded-2xl bg-rose-50 px-3 py-2.5 text-sm text-rose-700 dark:bg-rose-500/10 dark:text-rose-300">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" /> {runError}
              </p>
            )}

            {status === 'done' && (
              <p className="flex items-start gap-2 rounded-2xl bg-emerald-50 px-3 py-2.5 text-sm text-emerald-800 dark:bg-emerald-500/10 dark:text-emerald-300">
                <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
                <span>
                  {runTotal} row{runTotal === 1 ? '' : 's'} imported. Importing this same file again
                  would update these records rather than duplicate them.
                </span>
              </p>
            )}

            <div className="flex flex-wrap items-center gap-2">
              {status === 'idle' && (
                <Button
                  variant="primary"
                  className="min-h-[48px]"
                  onClick={() => void run()}
                  disabled={plan.valid.length === 0 || importer.loading}
                >
                  <Play className="h-4 w-4" /> Import {plan.valid.length} row
                  {plan.valid.length === 1 ? '' : 's'}
                </Button>
              )}

              {status === 'running' && (
                <>
                  <Button
                    className="min-h-[48px]"
                    onClick={() => {
                      pausedRef.current = true
                    }}
                  >
                    <Pause className="h-4 w-4" /> Pause
                  </Button>
                  <span className="inline-flex items-center gap-2 text-sm text-slate-400">
                    <Loader2 className="h-4 w-4 animate-spin" /> Writing in batches of {BATCH_SIZE}…
                  </span>
                </>
              )}

              {status === 'paused' && (
                <>
                  <Button variant="primary" className="min-h-[48px]" onClick={() => void run()}>
                    <Play className="h-4 w-4" /> Resume from row {written + 1}
                  </Button>
                  <Button className="min-h-[48px]" onClick={resetRun}>
                    <RotateCcw className="h-4 w-4" /> Discard the rest
                  </Button>
                </>
              )}

              {status === 'done' && (
                <Button className="min-h-[48px]" onClick={clearFile}>
                  <UploadCloud className="h-4 w-4" /> Import another file
                </Button>
              )}
            </div>
          </div>
        </Card>
      )}

      {hasFile && !plan && missingKeys.length > 0 && (
        <Card className="p-5">
          <p className="flex items-start gap-2 text-sm text-slate-500 dark:text-slate-400">
            <Info className="mt-0.5 h-4 w-4 shrink-0" />
            Map {missingKeys.join(' and ')} above to see what this file would change.
          </p>
        </Card>
      )}
    </div>
  )
}
