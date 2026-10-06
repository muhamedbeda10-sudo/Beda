import { useState, type ReactNode } from 'react'
import { Navigate, NavLink, useParams } from 'react-router-dom'
import { AlertTriangle, BookOpen, ClipboardPaste, Factory, FileSpreadsheet, FlaskConical, Gauge, Image as ImageIcon, ListOrdered, Ruler, Shuffle } from 'lucide-react'
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
import { Button } from '@/components/ui'
import { ConfigurationExport } from '@/components/admin/ConfigurationExport'
import { cn } from '@/lib/utils'

/**
 * §7 — everything the inspection wizard reads its rules from, in one place.
 * Each section is a master-data panel; the ones the ERP exports as a sheet
 * also carry that sheet's importer, folded away until it is needed.
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
  /** Taking the configuration out as a workbook, a sheet per chosen list. */
  const [exporting, setExporting] = useState(false)
  const current = SECTIONS.find((s) => s.key === section)
  /** The grid is the everyday way in; a file is there for a large export. */
  const [fileMode, setFileMode] = useState(false)

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
        <div className="flex flex-wrap gap-2 pb-1">
          {SECTIONS.map((s) => (
            <NavLink
              key={s.key}
              to={`/admin/configuration/${s.key}`}
              onClick={() => setFileMode(false)}
              className={({ isActive }) =>
                cn(
                  'group inline-flex min-h-[44px] shrink-0 items-center gap-2 rounded-xl px-3.5 text-sm font-semibold transition-[background-color,color,box-shadow] duration-200',
                  isActive
                    ? 'bg-white text-brand-800 shadow-card ring-1 ring-slate-200/80 dark:bg-slate-900 dark:text-white dark:ring-slate-700'
                    : 'text-muted hover:bg-white/70 hover:text-brand-700 dark:hover:bg-slate-800/70',
                )
              }
            >
              <s.icon className="h-4 w-4 transition-transform duration-200 group-hover:scale-110" />
              {s.label}
            </NavLink>
          ))}
        </div>

        <div key={current.key} className="animate-page-in space-y-4">
          {current.importer && (
            <div className="card space-y-4 p-4 sm:p-5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="flex min-w-0 items-start gap-3">
                  <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-brand-100 text-brand-700 dark:bg-brand-500/15 dark:text-brand-200">
                    {fileMode ? <FileSpreadsheet className="h-5 w-5" /> : <ClipboardPaste className="h-5 w-5" />}
                  </span>
                  <div className="min-w-0">
                    <h3 className="text-base font-bold">{fileMode ? `Load ${current.label.toLowerCase()} from a file` : `Paste ${current.label.toLowerCase()} from Excel`}</h3>
                    <p className="mt-0.5 text-sm text-muted">{current.importer.fields.map((f) => f.label).join(' · ')}</p>
                  </div>
                </div>
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
              {fileMode ? <CsvImporter importer={current.importer} /> : <PasteImporter importer={current.importer} />}
            </div>
          )}

          {current.panel}
        </div>
      </div>

      {exporting && <ConfigurationExport onClose={() => setExporting(false)} />}
    </AdminLayout>
  )
}
