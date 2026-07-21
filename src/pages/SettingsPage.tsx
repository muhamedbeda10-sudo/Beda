import { useMemo, useRef, useState } from 'react'
import {
  Settings,
  User,
  Sun,
  Moon,
  RotateCcw,
  ShieldAlert,
  Bug,
  Ruler,
  Award,
  FlaskConical,
  Upload,
  Plus,
  Pencil,
  Trash2,
  Save,
  Download,
  FileSpreadsheet,
  Check,
} from 'lucide-react'
import { useDB, actions } from '@/store/db'
import { useApp } from '@/store/AppContext'
import { Badge, Button, Card, Field, Input, Modal, Select } from '@/components/ui'
import { cn, parseCSV, downloadText } from '@/lib/utils'
import type {
  DefectType,
  DimensionSpec,
  GradeMapping,
  PTConsumable,
  DefectSeverity,
  ProductionOrder,
} from '@/types'

type TabKey =
  | 'general'
  | 'defects'
  | 'dimensions'
  | 'grades'
  | 'consumables'
  | 'import'

const TABS: Array<{ key: TabKey; label: string; icon: React.ReactNode }> = [
  { key: 'general', label: 'General', icon: <Settings className="h-4 w-4" /> },
  { key: 'defects', label: 'Defect Types', icon: <Bug className="h-4 w-4" /> },
  { key: 'dimensions', label: 'Dimensions', icon: <Ruler className="h-4 w-4" /> },
  { key: 'grades', label: 'Grade Mappings', icon: <Award className="h-4 w-4" /> },
  { key: 'consumables', label: 'PT Consumables', icon: <FlaskConical className="h-4 w-4" /> },
  { key: 'import', label: 'Bulk Import', icon: <Upload className="h-4 w-4" /> },
]

export function SettingsPage() {
  const [tab, setTab] = useState<TabKey>('general')

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-3">
        <span className="grid h-11 w-11 shrink-0 place-items-center rounded-2xl bg-brand-100 text-brand-600 dark:bg-brand-500/15 dark:text-brand-300">
          <Settings className="h-6 w-6" />
        </span>
        <div>
          <h1 className="text-xl font-extrabold leading-tight">Settings</h1>
          <p className="text-sm text-slate-500 dark:text-slate-400">
            Manage lookups, reference data and system configuration.
          </p>
        </div>
      </div>

      <div className="flex flex-col gap-5 lg:flex-row">
        {/* Tab navigation — horizontal scroll on mobile, vertical rail on desktop */}
        <nav className="lg:w-56 lg:shrink-0">
          <div className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1 lg:flex-col lg:overflow-visible lg:pb-0">
            {TABS.map((t) => (
              <button
                key={t.key}
                onClick={() => setTab(t.key)}
                className={cn(
                  'flex shrink-0 items-center gap-2 whitespace-nowrap rounded-xl px-3.5 py-2.5 text-sm font-semibold transition-colors lg:w-full',
                  tab === t.key
                    ? 'bg-brand-600 text-white shadow-sm'
                    : 'bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700',
                )}
              >
                {t.icon}
                {t.label}
              </button>
            ))}
          </div>
        </nav>

        <div className="min-w-0 flex-1">
          {tab === 'general' && <GeneralTab />}
          {tab === 'defects' && <DefectTypesTab />}
          {tab === 'dimensions' && <DimensionsTab />}
          {tab === 'grades' && <GradeMappingsTab />}
          {tab === 'consumables' && <ConsumablesTab />}
          {tab === 'import' && <BulkImportTab />}
        </div>
      </div>
    </div>
  )
}

// ============================================================================
// General
// ============================================================================
function GeneralTab() {
  const { user, setUser, theme, toggleTheme, toast } = useApp()
  const [name, setName] = useState(user)
  const [confirmReset, setConfirmReset] = useState(false)

  return (
    <div className="space-y-5">
      <Card className="p-5">
        <SectionHeader
          icon={<User className="h-5 w-5" />}
          title="Profile"
          subtitle="Your display name is attached to inspections and audit entries."
        />
        <div className="mt-4 max-w-md space-y-3">
          <Field label="Display name">
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Mohamed Abdelrahman"
            />
          </Field>
          <Button
            variant="primary"
            disabled={!name.trim() || name.trim() === user}
            onClick={() => {
              setUser(name.trim())
              toast('Display name updated', 'success')
            }}
          >
            <Save className="h-4 w-4" /> Save name
          </Button>
        </div>
      </Card>

      <Card className="p-5">
        <SectionHeader
          icon={theme === 'dark' ? <Moon className="h-5 w-5" /> : <Sun className="h-5 w-5" />}
          title="Appearance"
          subtitle={`Currently using the ${theme} theme.`}
        />
        <div className="mt-4">
          <Button variant="secondary" onClick={toggleTheme}>
            {theme === 'dark' ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
            Switch to {theme === 'dark' ? 'light' : 'dark'} mode
          </Button>
        </div>
      </Card>

      <Card className="border-rose-200 p-5 dark:border-rose-500/30">
        <SectionHeader
          icon={<ShieldAlert className="h-5 w-5" />}
          title="Danger zone"
          subtitle="Destructive actions that affect all local data."
          tone="danger"
        />
        <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-sm text-slate-600 dark:text-slate-300">
            Reset the demo database back to the original seed data.
          </p>
          <Button variant="danger" className="shrink-0" onClick={() => setConfirmReset(true)}>
            <RotateCcw className="h-4 w-4" /> Reset demo data
          </Button>
        </div>
      </Card>

      <Modal
        open={confirmReset}
        onClose={() => setConfirmReset(false)}
        title="Reset demo data?"
        icon={<RotateCcw className="h-5 w-5" />}
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmReset(false)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                actions.reset()
                setConfirmReset(false)
                toast('Demo data restored to seed', 'success')
              }}
            >
              <RotateCcw className="h-4 w-4" /> Reset everything
            </Button>
          </>
        }
      >
        <p className="text-sm text-slate-600 dark:text-slate-300">
          This permanently discards every order, inspection session, sample, measurement, defect
          and image you have created, and restores the original seed data set. This cannot be
          undone.
        </p>
      </Modal>
    </div>
  )
}

// ============================================================================
// Defect Types
// ============================================================================
const SEVERITIES: DefectSeverity[] = ['Minor', 'Major', 'Critical']

function severityTone(s: DefectSeverity) {
  return s === 'Critical' ? 'red' : s === 'Major' ? 'amber' : 'neutral'
}

function DefectTypesTab() {
  const db = useDB()
  const { toast } = useApp()
  const [editing, setEditing] = useState<DefectType | null>(null)
  const [confirmDel, setConfirmDel] = useState<DefectType | null>(null)

  const blank: DefectType = {
    id: '',
    code: '',
    title: '',
    description: '',
    defaultSeverity: 'Minor',
    active: true,
  }

  return (
    <LookupCard
      title="Defect Types"
      subtitle="Standard visual-defect catalogue used during inspections."
      count={db.defectTypes.length}
      onAdd={() => setEditing(blank)}
    >
      {db.defectTypes.length === 0 ? (
        <EmptyRow label="No defect types yet." />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <Th>
                <td className="py-2 pr-3">Code</td>
                <td className="py-2 pr-3">Title</td>
                <td className="py-2 pr-3">Severity</td>
                <td className="py-2 pr-3">Status</td>
                <td className="py-2" />
              </Th>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {db.defectTypes.map((row) => (
                <tr key={row.id}>
                  <td className="py-2.5 pr-3 font-mono font-semibold">{row.code}</td>
                  <td className="py-2.5 pr-3">
                    <p className="font-medium" dir="auto">
                      {row.title}
                    </p>
                    {row.description && (
                      <p className="text-xs text-slate-400" dir="auto">
                        {row.description}
                      </p>
                    )}
                  </td>
                  <td className="py-2.5 pr-3">
                    <Badge tone={severityTone(row.defaultSeverity)}>{row.defaultSeverity}</Badge>
                  </td>
                  <td className="py-2.5 pr-3">
                    <ActiveBadge active={row.active} />
                  </td>
                  <td className="py-2.5">
                    <RowActions onEdit={() => setEditing(row)} onDelete={() => setConfirmDel(row)} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {editing && (
        <DefectTypeModal
          initial={editing}
          onClose={() => setEditing(null)}
          onSave={(row) => {
            actions.saveDefectType(row)
            setEditing(null)
            toast('Defect type saved', 'success')
          }}
        />
      )}

      <ConfirmDelete
        row={confirmDel}
        label={confirmDel?.code}
        onCancel={() => setConfirmDel(null)}
        onConfirm={() => {
          if (confirmDel) actions.deleteDefectType(confirmDel.id)
          setConfirmDel(null)
          toast('Defect type deleted', 'info')
        }}
      />
    </LookupCard>
  )
}

function DefectTypeModal({
  initial,
  onClose,
  onSave,
}: {
  initial: DefectType
  onClose: () => void
  onSave: (row: DefectType) => void
}) {
  const [form, setForm] = useState<DefectType>(initial)
  const valid = form.code.trim() !== '' && form.title.trim() !== ''
  return (
    <Modal
      open
      onClose={onClose}
      title={initial.id ? 'Edit defect type' : 'Add defect type'}
      icon={<Bug className="h-5 w-5" />}
      footer={<SaveFooter onClose={onClose} valid={valid} onSave={() => onSave(form)} />}
    >
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Code">
            <Input
              value={form.code}
              onChange={(e) => setForm({ ...form, code: e.target.value })}
              placeholder="e.g. SCR"
            />
          </Field>
          <Field label="Default severity">
            <Select
              value={form.defaultSeverity}
              onChange={(e) =>
                setForm({ ...form, defaultSeverity: e.target.value as DefectSeverity })
              }
            >
              {SEVERITIES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <Field label="Title">
          <Input
            dir="auto"
            value={form.title}
            onChange={(e) => setForm({ ...form, title: e.target.value })}
            placeholder="Short title (Arabic supported)"
          />
        </Field>
        <Field label="Description">
          <Input
            dir="auto"
            value={form.description}
            onChange={(e) => setForm({ ...form, description: e.target.value })}
            placeholder="Optional longer description"
          />
        </Field>
        <ActiveToggle
          checked={form.active}
          onChange={(v) => setForm({ ...form, active: v })}
        />
      </div>
    </Modal>
  )
}

// ============================================================================
// Dimensions
// ============================================================================
function DimensionsTab() {
  const db = useDB()
  const { toast } = useApp()
  const [editing, setEditing] = useState<DimensionSpec | null>(null)
  const [confirmDel, setConfirmDel] = useState<DimensionSpec | null>(null)

  const blank: DimensionSpec = {
    id: '',
    code: '',
    name: '',
    target: 0,
    tolMinus: 0,
    tolPlus: 0,
    unit: 'mm',
    active: true,
  }

  return (
    <LookupCard
      title="Dimension Specs"
      subtitle="Target dimensions and tolerance bands for measurements."
      count={db.dimensionSpecs.length}
      onAdd={() => setEditing(blank)}
    >
      {db.dimensionSpecs.length === 0 ? (
        <EmptyRow label="No dimension specs yet." />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <Th>
                <td className="py-2 pr-3">Code</td>
                <td className="py-2 pr-3">Name</td>
                <td className="py-2 pr-3">Target ± Tol</td>
                <td className="py-2 pr-3">Status</td>
                <td className="py-2" />
              </Th>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {db.dimensionSpecs.map((row) => (
                <tr key={row.id}>
                  <td className="py-2.5 pr-3 font-mono font-semibold">{row.code}</td>
                  <td className="py-2.5 pr-3">{row.name}</td>
                  <td className="py-2.5 pr-3 tabular-nums">
                    <span className="font-semibold">{row.target}</span>
                    <span className="text-slate-400">
                      {' '}
                      (-{row.tolMinus} / +{row.tolPlus}) {row.unit}
                    </span>
                  </td>
                  <td className="py-2.5 pr-3">
                    <ActiveBadge active={row.active} />
                  </td>
                  <td className="py-2.5">
                    <RowActions onEdit={() => setEditing(row)} onDelete={() => setConfirmDel(row)} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {editing && (
        <DimensionModal
          initial={editing}
          onClose={() => setEditing(null)}
          onSave={(row) => {
            actions.saveDimensionSpec(row)
            setEditing(null)
            toast('Dimension spec saved', 'success')
          }}
        />
      )}

      <ConfirmDelete
        row={confirmDel}
        label={confirmDel?.code}
        onCancel={() => setConfirmDel(null)}
        onConfirm={() => {
          if (confirmDel) actions.deleteDimensionSpec(confirmDel.id)
          setConfirmDel(null)
          toast('Dimension spec deleted', 'info')
        }}
      />
    </LookupCard>
  )
}

function DimensionModal({
  initial,
  onClose,
  onSave,
}: {
  initial: DimensionSpec
  onClose: () => void
  onSave: (row: DimensionSpec) => void
}) {
  const [form, setForm] = useState<DimensionSpec>(initial)
  const valid = form.code.trim() !== '' && form.name.trim() !== ''
  const num = (v: string) => (v === '' ? 0 : Number(v))
  return (
    <Modal
      open
      onClose={onClose}
      title={initial.id ? 'Edit dimension' : 'Add dimension'}
      icon={<Ruler className="h-5 w-5" />}
      footer={<SaveFooter onClose={onClose} valid={valid} onSave={() => onSave(form)} />}
    >
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Code">
            <Input
              value={form.code}
              onChange={(e) => setForm({ ...form, code: e.target.value })}
              placeholder="e.g. H"
            />
          </Field>
          <Field label="Name">
            <Input
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="e.g. Height"
            />
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Field label="Target">
            <Input
              type="number"
              step="any"
              value={form.target}
              onChange={(e) => setForm({ ...form, target: num(e.target.value) })}
            />
          </Field>
          <Field label="Tol −">
            <Input
              type="number"
              step="any"
              value={form.tolMinus}
              onChange={(e) => setForm({ ...form, tolMinus: num(e.target.value) })}
            />
          </Field>
          <Field label="Tol +">
            <Input
              type="number"
              step="any"
              value={form.tolPlus}
              onChange={(e) => setForm({ ...form, tolPlus: num(e.target.value) })}
            />
          </Field>
          <Field label="Unit">
            <Input
              value={form.unit}
              onChange={(e) => setForm({ ...form, unit: e.target.value })}
              placeholder="mm"
            />
          </Field>
        </div>
        <ActiveToggle checked={form.active} onChange={(v) => setForm({ ...form, active: v })} />
      </div>
    </Modal>
  )
}

// ============================================================================
// Grade Mappings
// ============================================================================
function GradeMappingsTab() {
  const db = useDB()
  const { toast } = useApp()
  const [editing, setEditing] = useState<GradeMapping | null>(null)

  const blank: GradeMapping = {
    id: '',
    grade: '',
    minPassRate: 0,
    maxDefectRate: 0,
    color: '#2563eb',
    label: '',
  }

  return (
    <LookupCard
      title="Grade Mappings"
      subtitle="Map pass / defect thresholds to a quality grade and colour."
      count={db.gradeMappings.length}
      onAdd={() => setEditing(blank)}
    >
      {db.gradeMappings.length === 0 ? (
        <EmptyRow label="No grade mappings yet." />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <Th>
                <td className="py-2 pr-3">Grade</td>
                <td className="py-2 pr-3">Label</td>
                <td className="py-2 pr-3">Min pass %</td>
                <td className="py-2 pr-3">Max defect %</td>
                <td className="py-2" />
              </Th>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {db.gradeMappings.map((row) => (
                <tr key={row.id}>
                  <td className="py-2.5 pr-3">
                    <span
                      className="inline-flex items-center gap-2 rounded-full px-2.5 py-0.5 text-xs font-bold text-white"
                      style={{ backgroundColor: row.color }}
                    >
                      {row.grade || '—'}
                    </span>
                  </td>
                  <td className="py-2.5 pr-3">{row.label}</td>
                  <td className="py-2.5 pr-3 tabular-nums">{row.minPassRate}%</td>
                  <td className="py-2.5 pr-3 tabular-nums">{row.maxDefectRate}%</td>
                  <td className="py-2.5">
                    <RowActions onEdit={() => setEditing(row)} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {editing && (
        <GradeModal
          initial={editing}
          onClose={() => setEditing(null)}
          onSave={(row) => {
            actions.saveGradeMapping(row)
            setEditing(null)
            toast('Grade mapping saved', 'success')
          }}
        />
      )}
    </LookupCard>
  )
}

function GradeModal({
  initial,
  onClose,
  onSave,
}: {
  initial: GradeMapping
  onClose: () => void
  onSave: (row: GradeMapping) => void
}) {
  const [form, setForm] = useState<GradeMapping>(initial)
  const valid = form.grade.trim() !== ''
  const num = (v: string) => (v === '' ? 0 : Number(v))
  return (
    <Modal
      open
      onClose={onClose}
      title={initial.id ? 'Edit grade mapping' : 'Add grade mapping'}
      icon={<Award className="h-5 w-5" />}
      footer={<SaveFooter onClose={onClose} valid={valid} onSave={() => onSave(form)} />}
    >
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Grade">
            <Input
              value={form.grade}
              onChange={(e) => setForm({ ...form, grade: e.target.value })}
              placeholder="e.g. A"
            />
          </Field>
          <Field label="Label">
            <Input
              value={form.label}
              onChange={(e) => setForm({ ...form, label: e.target.value })}
              placeholder="e.g. Premium"
            />
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Min pass rate (%)">
            <Input
              type="number"
              step="any"
              value={form.minPassRate}
              onChange={(e) => setForm({ ...form, minPassRate: num(e.target.value) })}
            />
          </Field>
          <Field label="Max defect rate (%)">
            <Input
              type="number"
              step="any"
              value={form.maxDefectRate}
              onChange={(e) => setForm({ ...form, maxDefectRate: num(e.target.value) })}
            />
          </Field>
        </div>
        <Field label="Colour">
          <div className="flex items-center gap-3">
            <input
              type="color"
              value={form.color}
              onChange={(e) => setForm({ ...form, color: e.target.value })}
              className="h-10 w-16 cursor-pointer rounded-lg border border-slate-200 bg-transparent p-1 dark:border-slate-700"
              aria-label="Grade colour"
            />
            <span
              className="inline-flex items-center gap-2 rounded-full px-3 py-1 text-sm font-bold text-white"
              style={{ backgroundColor: form.color }}
            >
              {form.grade || 'Preview'}
            </span>
            <span className="font-mono text-xs text-slate-400">{form.color}</span>
          </div>
        </Field>
      </div>
    </Modal>
  )
}

// ============================================================================
// PT Consumables
// ============================================================================
const PT_TYPES = ['Penetrant', 'Developer', 'Cleaner']

function ConsumablesTab() {
  const db = useDB()
  const { toast } = useApp()
  const [editing, setEditing] = useState<PTConsumable | null>(null)
  const [confirmDel, setConfirmDel] = useState<PTConsumable | null>(null)

  const blank: PTConsumable = {
    id: '',
    code: '',
    name: '',
    type: 'Penetrant',
    batch: '',
    expiry: '',
    active: true,
  }

  return (
    <LookupCard
      title="PT Consumables"
      subtitle="Penetrant-testing materials and their batch / expiry tracking."
      count={db.ptConsumables.length}
      onAdd={() => setEditing(blank)}
    >
      {db.ptConsumables.length === 0 ? (
        <EmptyRow label="No consumables yet." />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <Th>
                <td className="py-2 pr-3">Code</td>
                <td className="py-2 pr-3">Name</td>
                <td className="py-2 pr-3">Type</td>
                <td className="py-2 pr-3">Batch</td>
                <td className="py-2 pr-3">Expiry</td>
                <td className="py-2 pr-3">Status</td>
                <td className="py-2" />
              </Th>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {db.ptConsumables.map((row) => (
                <tr key={row.id}>
                  <td className="py-2.5 pr-3 font-mono font-semibold">{row.code}</td>
                  <td className="py-2.5 pr-3">{row.name}</td>
                  <td className="py-2.5 pr-3">
                    <Badge tone="violet">{row.type}</Badge>
                  </td>
                  <td className="py-2.5 pr-3 font-mono">{row.batch || '—'}</td>
                  <td className="py-2.5 pr-3 tabular-nums">{row.expiry || '—'}</td>
                  <td className="py-2.5 pr-3">
                    <ActiveBadge active={row.active} />
                  </td>
                  <td className="py-2.5">
                    <RowActions onEdit={() => setEditing(row)} onDelete={() => setConfirmDel(row)} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {editing && (
        <ConsumableModal
          initial={editing}
          onClose={() => setEditing(null)}
          onSave={(row) => {
            actions.savePTConsumable(row)
            setEditing(null)
            toast('Consumable saved', 'success')
          }}
        />
      )}

      <ConfirmDelete
        row={confirmDel}
        label={confirmDel?.code}
        onCancel={() => setConfirmDel(null)}
        onConfirm={() => {
          if (confirmDel) actions.deletePTConsumable(confirmDel.id)
          setConfirmDel(null)
          toast('Consumable deleted', 'info')
        }}
      />
    </LookupCard>
  )
}

function ConsumableModal({
  initial,
  onClose,
  onSave,
}: {
  initial: PTConsumable
  onClose: () => void
  onSave: (row: PTConsumable) => void
}) {
  const [form, setForm] = useState<PTConsumable>(initial)
  const valid = form.code.trim() !== '' && form.name.trim() !== ''
  return (
    <Modal
      open
      onClose={onClose}
      title={initial.id ? 'Edit consumable' : 'Add consumable'}
      icon={<FlaskConical className="h-5 w-5" />}
      footer={<SaveFooter onClose={onClose} valid={valid} onSave={() => onSave(form)} />}
    >
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Code">
            <Input
              value={form.code}
              onChange={(e) => setForm({ ...form, code: e.target.value })}
              placeholder="e.g. PT-DP"
            />
          </Field>
          <Field label="Type">
            <Select
              value={form.type}
              onChange={(e) => setForm({ ...form, type: e.target.value })}
            >
              {PT_TYPES.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <Field label="Name">
          <Input
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            placeholder="Product name"
          />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Batch">
            <Input
              value={form.batch}
              onChange={(e) => setForm({ ...form, batch: e.target.value })}
              placeholder="Batch / lot no."
            />
          </Field>
          <Field label="Expiry">
            <Input
              type="date"
              value={form.expiry}
              onChange={(e) => setForm({ ...form, expiry: e.target.value })}
            />
          </Field>
        </div>
        <ActiveToggle checked={form.active} onChange={(v) => setForm({ ...form, active: v })} />
      </div>
    </Modal>
  )
}

// ============================================================================
// Bulk Import
// ============================================================================
type OrderFieldKey =
  | 'orderId'
  | 'item'
  | 'itemCode'
  | 'requiredQty'
  | 'finishedQty'
  | 'color'
  | 'drawing'
  | 'route'
  | 'nominalL'

const ORDER_FIELDS: Array<{ key: OrderFieldKey; label: string; numeric?: boolean; required?: boolean }> = [
  { key: 'orderId', label: 'Order ID', required: true },
  { key: 'item', label: 'Item' },
  { key: 'itemCode', label: 'Item Code' },
  { key: 'requiredQty', label: 'Required Qty', numeric: true },
  { key: 'finishedQty', label: 'Finished Qty', numeric: true },
  { key: 'color', label: 'Color' },
  { key: 'drawing', label: 'Drawing' },
  { key: 'route', label: 'Route' },
  { key: 'nominalL', label: 'Nominal L', numeric: true },
]

const NONE = '__none__'

function guessMapping(headers: string[]): Record<OrderFieldKey, string> {
  const norm = (s: string) => s.toLowerCase().replace(/[\s_-]/g, '')
  const map = {} as Record<OrderFieldKey, string>
  for (const f of ORDER_FIELDS) {
    const target = norm(f.label)
    const targetKey = norm(f.key)
    const idx = headers.findIndex((h) => {
      const n = norm(h)
      return n === targetKey || n === target
    })
    map[f.key] = idx >= 0 ? String(idx) : NONE
  }
  return map
}

function BulkImportTab() {
  const { toast } = useApp()
  const fileRef = useRef<HTMLInputElement>(null)
  const [fileName, setFileName] = useState('')
  const [headers, setHeaders] = useState<string[]>([])
  const [rows, setRows] = useState<string[][]>([])
  const [mapping, setMapping] = useState<Record<OrderFieldKey, string>>(
    () => guessMapping([]),
  )

  const handleFile = async (file: File) => {
    const text = await file.text()
    const parsed = parseCSV(text)
    if (parsed.length === 0) {
      toast('The CSV file appears to be empty', 'error')
      return
    }
    const hdr = parsed[0]
    const body = parsed.slice(1)
    setFileName(file.name)
    setHeaders(hdr)
    setRows(body)
    setMapping(guessMapping(hdr))
  }

  const preview = useMemo(() => {
    return rows.slice(0, 5).map((r) => {
      const obj: Partial<Record<OrderFieldKey, string>> = {}
      for (const f of ORDER_FIELDS) {
        const col = mapping[f.key]
        if (col !== NONE) obj[f.key] = r[Number(col)] ?? ''
      }
      return obj
    })
  }, [rows, mapping])

  const mappedFields = ORDER_FIELDS.filter((f) => mapping[f.key] !== NONE)
  const orderIdMapped = mapping.orderId !== NONE

  const buildRows = (): Array<Partial<ProductionOrder> & { orderId: string }> => {
    const out: Array<Partial<ProductionOrder> & { orderId: string }> = []
    for (const r of rows) {
      const orderId = (r[Number(mapping.orderId)] ?? '').trim()
      if (!orderId) continue
      const obj: Partial<ProductionOrder> & { orderId: string } = { orderId }
      for (const f of ORDER_FIELDS) {
        if (f.key === 'orderId') continue
        const col = mapping[f.key]
        if (col === NONE) continue
        const raw = (r[Number(col)] ?? '').trim()
        if (f.numeric) {
          ;(obj as Record<string, unknown>)[f.key] = Number(raw) || 0
        } else {
          ;(obj as Record<string, unknown>)[f.key] = raw
        }
      }
      out.push(obj)
    }
    return out
  }

  const doImport = () => {
    const built = buildRows()
    if (built.length === 0) {
      toast('No rows with a valid Order ID to import', 'error')
      return
    }
    const { created, updated } = actions.bulkImportOrders(built)
    toast(`Import complete — ${created} created, ${updated} updated`, 'success')
  }

  const downloadTemplate = () => {
    const headerLine = ORDER_FIELDS.map((f) => f.key).join(',')
    const sampleLine = [
      '20095-QC1-HYH',
      'Bracket Assembly',
      '125185TA3',
      '500',
      '120',
      'RAL9010',
      'DWG-4471',
      'Local',
      '1250',
    ].join(',')
    downloadText('orders-template.csv', `${headerLine}\n${sampleLine}\n`)
  }

  return (
    <Card className="p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <SectionHeader
          icon={<Upload className="h-5 w-5" />}
          title="Bulk import orders"
          subtitle="Import production orders from a CSV file with column mapping."
        />
        <Button variant="secondary" className="shrink-0" onClick={downloadTemplate}>
          <Download className="h-4 w-4" /> CSV template
        </Button>
      </div>

      {/* File input */}
      <div className="mt-4">
        <input
          ref={fileRef}
          type="file"
          accept=".csv"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0]
            if (f) void handleFile(f)
            e.target.value = ''
          }}
        />
        <button
          onClick={() => fileRef.current?.click()}
          className="flex w-full flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-slate-300 py-8 text-center transition-colors hover:border-brand-400 hover:bg-brand-50/40 dark:border-slate-700 dark:hover:border-brand-500/40 dark:hover:bg-brand-500/5"
        >
          <FileSpreadsheet className="h-8 w-8 text-slate-400" />
          <span className="text-sm font-semibold text-slate-600 dark:text-slate-300">
            {fileName ? `Selected: ${fileName}` : 'Click to choose a CSV file'}
          </span>
          <span className="text-xs text-slate-400">First row is treated as headers</span>
        </button>
      </div>

      {headers.length > 0 && (
        <>
          {/* Column mapping */}
          <div className="mt-5">
            <h4 className="mb-2 text-sm font-bold uppercase tracking-wide text-slate-500 dark:text-slate-400">
              Column mapping
            </h4>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {ORDER_FIELDS.map((f) => (
                <Field
                  key={f.key}
                  label={f.required ? `${f.label} *` : f.label}
                >
                  <Select
                    value={mapping[f.key]}
                    onChange={(e) => setMapping({ ...mapping, [f.key]: e.target.value })}
                  >
                    <option value={NONE}>—</option>
                    {headers.map((h, i) => (
                      <option key={i} value={String(i)}>
                        {h || `Column ${i + 1}`}
                      </option>
                    ))}
                  </Select>
                </Field>
              ))}
            </div>
            {!orderIdMapped && (
              <p className="mt-2 text-sm font-medium text-rose-500">
                Order ID must be mapped before importing.
              </p>
            )}
          </div>

          {/* Preview */}
          <div className="mt-5">
            <h4 className="mb-2 text-sm font-bold uppercase tracking-wide text-slate-500 dark:text-slate-400">
              Preview{' '}
              <span className="font-normal text-slate-400">
                (first {preview.length} of {rows.length} rows)
              </span>
            </h4>
            <div className="overflow-x-auto rounded-xl border border-slate-200 dark:border-slate-800">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-slate-50 dark:bg-slate-800/50">
                    {mappedFields.map((f) => (
                      <td
                        key={f.key}
                        className="whitespace-nowrap px-3 py-2 text-xs font-bold uppercase text-slate-400"
                      >
                        {f.label}
                      </td>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                  {preview.map((row, i) => (
                    <tr key={i}>
                      {mappedFields.map((f) => (
                        <td key={f.key} className="whitespace-nowrap px-3 py-2">
                          {row[f.key] ?? ''}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="mt-5 flex justify-end">
            <Button variant="primary" disabled={!orderIdMapped} onClick={doImport}>
              <Upload className="h-4 w-4" /> Import {rows.length} rows
            </Button>
          </div>
        </>
      )}
    </Card>
  )
}

// ============================================================================
// Shared building blocks
// ============================================================================
function SectionHeader({
  icon,
  title,
  subtitle,
  tone,
}: {
  icon: React.ReactNode
  title: string
  subtitle?: string
  tone?: 'danger'
}) {
  return (
    <div className="flex items-center gap-3">
      <span
        className={cn(
          'grid h-10 w-10 shrink-0 place-items-center rounded-xl',
          tone === 'danger'
            ? 'bg-rose-100 text-rose-600 dark:bg-rose-500/15 dark:text-rose-400'
            : 'bg-brand-100 text-brand-600 dark:bg-brand-500/15 dark:text-brand-300',
        )}
      >
        {icon}
      </span>
      <div className="min-w-0">
        <h3 className="text-base font-bold leading-tight">{title}</h3>
        {subtitle && <p className="text-sm text-slate-500 dark:text-slate-400">{subtitle}</p>}
      </div>
    </div>
  )
}

function LookupCard({
  title,
  subtitle,
  count,
  onAdd,
  children,
}: {
  title: string
  subtitle: string
  count: number
  onAdd: () => void
  children: React.ReactNode
}) {
  return (
    <Card className="p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-center gap-2">
          <h3 className="text-base font-bold">{title}</h3>
          <Badge tone="blue">{count}</Badge>
        </div>
        <Button variant="primary" className="shrink-0" onClick={onAdd}>
          <Plus className="h-4 w-4" /> Add
        </Button>
      </div>
      <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">{subtitle}</p>
      <div className="mt-4">{children}</div>
    </Card>
  )
}

function Th({ children }: { children: React.ReactNode }) {
  return (
    <tr className="border-b border-slate-100 text-left text-xs font-bold uppercase tracking-wide text-slate-400 dark:border-slate-800">
      {children}
    </tr>
  )
}

function EmptyRow({ label }: { label: string }) {
  return (
    <div className="rounded-xl border border-dashed border-slate-300 py-8 text-center text-sm text-slate-400 dark:border-slate-700">
      {label}
    </div>
  )
}

function ActiveBadge({ active }: { active: boolean }) {
  return <Badge tone={active ? 'green' : 'neutral'}>{active ? 'Active' : 'Inactive'}</Badge>
}

function RowActions({ onEdit, onDelete }: { onEdit: () => void; onDelete?: () => void }) {
  return (
    <div className="flex justify-end gap-1">
      <button
        onClick={onEdit}
        className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-brand-600 dark:hover:bg-slate-800"
        aria-label="Edit"
      >
        <Pencil className="h-4 w-4" />
      </button>
      {onDelete && (
        <button
          onClick={onDelete}
          className="rounded-lg p-1.5 text-slate-400 hover:bg-rose-50 hover:text-rose-600 dark:hover:bg-rose-500/10"
          aria-label="Delete"
        >
          <Trash2 className="h-4 w-4" />
        </button>
      )}
    </div>
  )
}

function ActiveToggle({
  checked,
  onChange,
}: {
  checked: boolean
  onChange: (v: boolean) => void
}) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      className="flex w-full items-center justify-between rounded-xl border border-slate-200 px-3.5 py-2.5 text-left dark:border-slate-700"
    >
      <span className="text-sm font-semibold">Active</span>
      <span
        className={cn(
          'relative inline-flex h-6 w-11 items-center rounded-full transition-colors',
          checked ? 'bg-brand-600' : 'bg-slate-300 dark:bg-slate-600',
        )}
      >
        <span
          className={cn(
            'inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform',
            checked ? 'translate-x-5' : 'translate-x-0.5',
          )}
        />
      </span>
    </button>
  )
}

function SaveFooter({
  onClose,
  onSave,
  valid,
}: {
  onClose: () => void
  onSave: () => void
  valid: boolean
}) {
  return (
    <>
      <Button variant="ghost" onClick={onClose}>
        Cancel
      </Button>
      <Button variant="primary" disabled={!valid} onClick={onSave}>
        <Check className="h-4 w-4" /> Save
      </Button>
    </>
  )
}

function ConfirmDelete<T>({
  row,
  label,
  onCancel,
  onConfirm,
}: {
  row: T | null
  label?: string
  onCancel: () => void
  onConfirm: () => void
}) {
  return (
    <Modal
      open={!!row}
      onClose={onCancel}
      title="Delete entry?"
      icon={<Trash2 className="h-5 w-5" />}
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button variant="danger" onClick={onConfirm}>
            <Trash2 className="h-4 w-4" /> Delete
          </Button>
        </>
      }
    >
      <p className="text-sm text-slate-600 dark:text-slate-300">
        Permanently delete <b>{label ?? 'this entry'}</b>? This cannot be undone.
      </p>
    </Modal>
  )
}
