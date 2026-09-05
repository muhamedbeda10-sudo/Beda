import { useState } from 'react'
import { Layers, Table2 } from 'lucide-react'
import { AdminLayout } from '@/components/admin/AdminLayout'
import { CsvImporter } from '@/components/admin/CsvImporter'
import { COILS_IMPORTER, ORDERS_IMPORTER } from '@/components/admin/importers'
import { cn } from '@/lib/utils'

/**
 * §7.7 — the two ERP exports that change every day: production order lines
 * and the coil register. Configuration sheets live with their sections.
 */
const SOURCES = [
  { key: 'orders', label: 'Production orders', icon: Layers, importer: ORDERS_IMPORTER },
  { key: 'coils', label: 'Coils', icon: Table2, importer: COILS_IMPORTER },
] as const

export function DataImportPage() {
  const [which, setWhich] = useState<(typeof SOURCES)[number]['key']>('orders')
  const source = SOURCES.find((s) => s.key === which) ?? SOURCES[0]

  return (
    <AdminLayout
      title="Data import"
      description="Load the ERP's order lines and coil register. Preview first; nothing is written until you press Import, and importing the same file twice updates rather than duplicates."
      needs="manage-admin-data"
    >
      <div className="space-y-4">
        <div className="inline-flex rounded-2xl bg-slate-100/80 p-1 ring-1 ring-slate-200/70 dark:bg-slate-800/70 dark:ring-slate-700/70">
          {SOURCES.map((s) => {
            const active = which === s.key
            return (
              <button
                key={s.key}
                type="button"
                onClick={() => setWhich(s.key)}
                aria-current={active ? 'true' : undefined}
                className={cn(
                  'group inline-flex min-h-[44px] items-center gap-2 rounded-xl px-4 text-sm font-semibold transition-[background-color,color,box-shadow] duration-200',
                  active
                    ? 'bg-white text-brand-800 shadow-card ring-1 ring-slate-200/80 dark:bg-slate-900 dark:text-white dark:ring-slate-700'
                    : 'text-slate-500 hover:text-brand-700 dark:text-slate-400',
                )}
              >
                <s.icon className="h-4 w-4 transition-transform duration-200 group-hover:scale-110" />
                {s.label}
              </button>
            )
          })}
        </div>
        <div key={source.key} className="animate-page-in">
          <CsvImporter importer={source.importer} />
        </div>
      </div>
    </AdminLayout>
  )
}
