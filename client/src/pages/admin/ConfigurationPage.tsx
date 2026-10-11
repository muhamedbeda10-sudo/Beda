import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Navigate, NavLink, useNavigate, useParams } from 'react-router-dom'
import { AlertTriangle, BookOpen, ChevronDown, ClipboardPaste, Factory, FileSpreadsheet, FlaskConical, Gauge, Image as ImageIcon, ListOrdered, Ruler, Shuffle } from 'lucide-react'
import { AdminLayout } from '@/components/admin/AdminLayout'
import { CsvImporter } from '@/components/admin/CsvImporter'
import { PasteImporter } from '@/components/admin/PasteImporter'
import { DEFECTS_IMPORTER, MACHINES_IMPORTER, PRODUCTION_IMPORTER, type Importer } from '@/components/admin/importers'
import { DimensionOrderSection } from '@/components/admin/config/DimensionOrderSection'
import { ReferenceImagesSection } from '@/components/admin/config/ReferenceImagesSection'
import { MachineDefectsSection } from '@/components/admin/config/MachineDefectsSection'
import { MachinesSection } from '@/components/admin/config/MachinesSection'
import { GradeMappingsSection } from '@/components/admin/config/GradeMappingsSection'
import { PTConsumablesSection } from '@/components/admin/config/PTConsumablesSection'
import { WorkInstructionsSection } from '@/components/admin/config/WorkInstructionsSection'
import { KpiTargetsSection } from '@/components/admin/config/KpiTargetsSection'
import { Button, Select } from '@/components/ui'
import { EdgeShadows, useScrollEdges } from '@/components/ui/ScrollX'
import { ConfigurationExport } from '@/components/admin/ConfigurationExport'
import { cn } from '@/lib/utils'

/**
 * §7 — everything the inspection wizard reads its rules from, in one place.
 * Each section is a master-data panel; the ones the ERP exports as a sheet
 * also carry that sheet's importer, folded away under the list until it is
 * needed.
 */
const SECTIONS: Array<{ key: string; label: string; icon: typeof Ruler; panel: ReactNode; importer?: Importer }> = [
  { key: 'machines', label: 'Machines', icon: Factory, panel: <MachinesSection />, importer: MACHINES_IMPORTER },
  { key: 'dimensions', label: 'Item dimensions', icon: ListOrdered, panel: <DimensionOrderSection />, importer: PRODUCTION_IMPORTER },
  { key: 'reference-images', label: 'Reference images', icon: ImageIcon, panel: <ReferenceImagesSection /> },
  { key: 'defects', label: 'Machine defects', icon: AlertTriangle, panel: <MachineDefectsSection />, importer: DEFECTS_IMPORTER },
  { key: 'grades', label: 'Grade mappings', icon: Shuffle, panel: <GradeMappingsSection /> },
  { key: 'pt-consumables', label: 'PT consumables', icon: FlaskConical, panel: <PTConsumablesSection /> },
  { key: 'work-instructions', label: 'Work instructions', icon: BookOpen, panel: <WorkInstructionsSection /> },
  { key: 'kpi-targets', label: 'KPI targets', icon: Gauge, panel: <KpiTargetsSection /> },
]

export function ConfigurationPage() {
  const { section = '' } = useParams()
  const navigate = useNavigate()
  /** Taking the configuration out as a workbook, a sheet per chosen list. */
  const [exporting, setExporting] = useState(false)
  const current = SECTIONS.find((s) => s.key === section)
  // The section switch: a select on a phone, where eight pills took six rows; one scrolling row from 640 px, with
  // a shadow at the end that hides more and the current one brought into view; the pills wrap from 1024 px.
  const strip = useRef<HTMLDivElement>(null)
  const edges = useScrollEdges(strip)
  useEffect(() => {
    strip.current?.querySelector('[aria-current="page"]')?.scrollIntoView({ block: 'nearest', inline: 'center' })
  }, [section])

  if (!current) return <Navigate to={`/admin/configuration/${SECTIONS[0].key}`} replace />

  return (
    <AdminLayout
      title="Configuration"
      needs="manage-admin-data"
      actions={
        <Button className="min-h-[44px]" onClick={() => setExporting(true)}>
          <FileSpreadsheet className="h-4 w-4" /> Export to Excel
        </Button>
      }
    >
      <div className="space-y-4">
        <Select aria-label="Configuration section" value={current.key} onChange={(e) => navigate(`/admin/configuration/${e.target.value}`)} className="min-h-[48px] sm:hidden">
          {SECTIONS.map((s) => (
            <option key={s.key} value={s.key}>
              {s.label}
            </option>
          ))}
        </Select>
        <div className="relative hidden sm:block">
          <div ref={strip} className="scrollbar-none flex gap-2 overflow-x-auto pb-1 lg:flex-wrap lg:overflow-visible">
            {SECTIONS.map((s) => (
              <NavLink
                key={s.key}
                to={`/admin/configuration/${s.key}`}
                className={({ isActive }) =>
                  cn(
                    'group inline-flex h-11 shrink-0 items-center gap-2 whitespace-nowrap rounded-xl px-3.5 text-sm font-semibold transition-[background-color,color,box-shadow] duration-200',
                    isActive
                      ? 'bg-white text-brand-800 shadow-card ring-1 ring-slate-200/80 dark:bg-slate-900 dark:text-white dark:ring-slate-700'
                      : 'text-muted hover:bg-white/70 hover:text-brand-700 dark:hover:bg-slate-800/70',
                  )
                }
              >
                <s.icon className="h-4 w-4 shrink-0 transition-transform duration-200 group-hover:scale-110" />
                {s.label}
              </NavLink>
            ))}
          </div>
          <EdgeShadows {...edges} className="lg:hidden" />
        </div>

        <div key={current.key} className="animate-page-in space-y-4">
          {current.panel}
          {current.importer && <ImporterCard label={current.label} importer={current.importer} />}
        </div>
      </div>

      {exporting && <ConfigurationExport onClose={() => setExporting(false)} />}
    </AdminLayout>
  )
}

/**
 * The section's importer, under its list and folded by default: pasting a
 * sheet is the rare task, finding and editing a record the everyday one, and
 * the importer open above the list pushed it below the fold on a tablet.
 * Opened, it offers the paste grid, or a file instead for a large export.
 */
function ImporterCard({ label, importer }: { label: string; importer: Importer }) {
  const [open, setOpen] = useState(false)
  /** The grid is the everyday way in; a file is there for a large export. */
  const [fileMode, setFileMode] = useState(false)
  const lower = label.toLowerCase()
  return (
    <div className="card">
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="flex w-full items-center gap-3 rounded-2xl p-4 text-left sm:p-5">
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-brand-100 text-brand-700 dark:bg-brand-500/15 dark:text-brand-200">
          {fileMode && open ? <FileSpreadsheet className="h-5 w-5" /> : <ClipboardPaste className="h-5 w-5" />}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-base font-bold">{open ? (fileMode ? `Load ${lower} from a file` : `Paste ${lower} from Excel`) : `Import ${lower} from Excel`}</span>
          <span className="mt-0.5 block text-sm text-muted">{open ? importer.fields.map((f) => f.label).join(' · ') : 'Paste the cells of a sheet, or load a .csv or .xlsx file.'}</span>
        </span>
        <ChevronDown className={cn('h-5 w-5 shrink-0 text-muted transition-transform', open && 'rotate-180')} />
      </button>
      {open && (
        <div className="space-y-4 border-t border-slate-100 px-4 pb-4 pt-4 sm:px-5 sm:pb-5 dark:border-slate-800">
          <div className="flex justify-end">
            <Button className="min-h-[44px]" onClick={() => setFileMode((m) => !m)}>
              {fileMode ? (
                <>
                  <ClipboardPaste className="h-4 w-4" /> Paste instead
                </>
              ) : (
                <>
                  <FileSpreadsheet className="h-4 w-4" /> Load a file instead
                </>
              )}
            </Button>
          </div>
          {fileMode ? <CsvImporter importer={importer} /> : <PasteImporter importer={importer} />}
        </div>
      )}
    </div>
  )
}
