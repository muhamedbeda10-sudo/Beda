import { useState, type ReactNode } from 'react'
import { Navigate, NavLink, useParams } from 'react-router-dom'
import { AlertTriangle, ChevronDown, Factory, FlaskConical, Image as ImageIcon, ListOrdered, Ruler, Shuffle, UploadCloud } from 'lucide-react'
import { AdminLayout } from '@/components/admin/AdminLayout'
import { CsvImporter } from '@/components/admin/CsvImporter'
import { DEFECTS_IMPORTER, MACHINES_IMPORTER, PRODUCTION_IMPORTER, type Importer } from '@/components/admin/importers'
import { DimensionOrderSection } from '@/components/admin/config/DimensionOrderSection'
import { ItemMasterSection } from '@/components/admin/config/ItemMasterSection'
import { ReferenceImagesSection } from '@/components/admin/config/ReferenceImagesSection'
import { MachineDefectsSection } from '@/components/admin/config/MachineDefectsSection'
import { MachinesSection } from '@/components/admin/config/MachinesSection'
import { GradeMappingsSection } from '@/components/admin/config/GradeMappingsSection'
import { PTConsumablesSection } from '@/components/admin/config/PTConsumablesSection'
import { Button } from '@/components/ui'
import { cn } from '@/lib/utils'

/**
 * §7 — everything the inspection wizard reads its rules from, in one place.
 * Each section is a master-data panel; the ones the ERP exports as a sheet
 * also carry that sheet's importer, folded away until it is needed.
 */
const SECTIONS: Array<{ key: string; label: string; icon: typeof Ruler; panel: ReactNode; importer?: Importer }> = [
  { key: 'machines', label: 'Machines', icon: Factory, panel: <MachinesSection />, importer: MACHINES_IMPORTER },
  { key: 'dimensions', label: 'Item dimensions', icon: ListOrdered, panel: <DimensionOrderSection />, importer: PRODUCTION_IMPORTER },
  { key: 'master-dimensions', label: 'Master dimensions', icon: Ruler, panel: <ItemMasterSection /> },
  { key: 'reference-images', label: 'Reference images', icon: ImageIcon, panel: <ReferenceImagesSection /> },
  { key: 'defects', label: 'Machine defects', icon: AlertTriangle, panel: <MachineDefectsSection />, importer: DEFECTS_IMPORTER },
  { key: 'grades', label: 'Grade mappings', icon: Shuffle, panel: <GradeMappingsSection /> },
  { key: 'pt-consumables', label: 'PT consumables', icon: FlaskConical, panel: <PTConsumablesSection /> },
]

export function ConfigurationPage() {
  const { section = '' } = useParams()
  const current = SECTIONS.find((s) => s.key === section)
  const [importOpen, setImportOpen] = useState(false)

  if (!current) return <Navigate to={`/admin/configuration/${SECTIONS[0].key}`} replace />

  return (
    <AdminLayout title="Configuration" description="The master data every inspection is judged against." needs="manage-admin-data">
      <div className="space-y-4">
        <div className="flex gap-2 overflow-x-auto pb-1 lg:flex-wrap lg:overflow-visible">
          {SECTIONS.map((s) => (
            <NavLink
              key={s.key}
              to={`/admin/configuration/${s.key}`}
              onClick={() => setImportOpen(false)}
              className={({ isActive }) =>
                cn(
                  'group inline-flex min-h-[44px] shrink-0 items-center gap-2 rounded-xl px-3.5 text-sm font-semibold transition-[background-color,color,box-shadow] duration-200',
                  isActive
                    ? 'bg-white text-brand-800 shadow-card ring-1 ring-slate-200/80 dark:bg-slate-900 dark:text-white dark:ring-slate-700'
                    : 'text-slate-500 hover:bg-white/70 hover:text-brand-700 dark:text-slate-400 dark:hover:bg-slate-800/70',
                )
              }
            >
              <s.icon className="h-4 w-4 transition-transform duration-200 group-hover:scale-110" />
              {s.label}
            </NavLink>
          ))}
        </div>

        <div key={current.key} className="animate-page-in space-y-4">
          {current.panel}

          {current.importer && (
            <div className="card overflow-hidden">
              <Button
                variant="ghost"
                className="w-full justify-between rounded-none px-5 py-4 text-left"
                onClick={() => setImportOpen((o) => !o)}
                aria-expanded={importOpen}
              >
                <span className="flex items-center gap-3">
                  <span className="grid h-9 w-9 place-items-center rounded-xl bg-brand-100 text-brand-700 dark:bg-brand-500/15 dark:text-brand-200">
                    <UploadCloud className="h-4 w-4" />
                  </span>
                  <span className="leading-tight">
                    <span className="block text-sm font-bold">Import {current.label.toLowerCase()} from a sheet</span>
                    <span className="block text-xs font-normal text-slate-500 dark:text-slate-400">{current.importer.description}</span>
                  </span>
                </span>
                <ChevronDown className={cn('h-5 w-5 text-slate-400 transition-transform duration-300', importOpen && 'rotate-180')} />
              </Button>
              {importOpen && (
                <div className="border-t border-slate-100 p-4 animate-fade-in dark:border-slate-800">
                  <CsvImporter importer={current.importer} />
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </AdminLayout>
  )
}
