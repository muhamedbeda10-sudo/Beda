import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Factory, Layers, Loader2, RefreshCw, Table2, Trash2 } from 'lucide-react'
import { AdminLayout } from '@/components/admin/AdminLayout'
import { CsvImporter } from '@/components/admin/CsvImporter'
import { AccessSyncPanel } from '@/components/admin/AccessSyncPanel'
import { ProductionRecordsSource } from '@/components/admin/ProductionRecordsSource'
import { COILS_IMPORTER, ORDERS_IMPORTER, PRODUCTION_RECORDS_IMPORTER } from '@/components/admin/importers'
import { Button, Card, Modal } from '@/components/ui'
import { clearOrders } from '@/services/mutations'
import { useApp } from '@/store/AppContext'
import { cn } from '@/lib/utils'

/**
 * §7.7 — the three ERP exports that change every day: production order lines,
 * the coil register and the production record written against the orders
 * (§24), and the orders synced from Access on their own. Configuration
 * sheets live with their sections.
 */
const SOURCES = [
  { key: 'orders', label: 'Production orders', short: 'Orders', icon: Layers, importer: ORDERS_IMPORTER },
  { key: 'coils', label: 'Coils', short: 'Coils', icon: Table2, importer: COILS_IMPORTER },
  { key: 'production-records', label: 'Production record', short: 'Production', icon: Factory, importer: PRODUCTION_RECORDS_IMPORTER },
  { key: 'access', label: 'Access sync', short: 'Access', icon: RefreshCw, importer: null },
] as const

export function DataImportPage() {
  const queryClient = useQueryClient()
  const { toast } = useApp()
  const [which, setWhich] = useState<(typeof SOURCES)[number]['key']>('orders')
  const [confirmClear, setConfirmClear] = useState(false)
  const [clearing, setClearing] = useState(false)
  const source = SOURCES.find((s) => s.key === which) ?? SOURCES[0]

  async function runClear() {
    setClearing(true)
    try {
      const { removed } = await clearOrders(queryClient)
      toast(`${removed} order line${removed === 1 ? '' : 's'} marked deleted. Load the new export now.`, 'success')
      setConfirmClear(false)
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not clear the orders.', 'error')
    } finally {
      setClearing(false)
    }
  }

  return (
    <AdminLayout title="Data import" needs="manage-admin-data">
      <div className="space-y-4">
        {/* The source switch: two by two on a phone, each cell the full width of its half, under short names; one row
            of the full names from 640 px. The icons keep their size whatever the label does. */}
        <div role="tablist" aria-label="Source" className="grid w-full grid-cols-2 gap-1 rounded-2xl bg-slate-100/80 p-1 ring-1 ring-slate-200/70 dark:bg-slate-800/70 dark:ring-slate-700/70 sm:inline-flex sm:w-auto">
          {SOURCES.map((s) => {
            const active = which === s.key
            return (
              <button
                key={s.key}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => setWhich(s.key)}
                className={cn(
                  'group inline-flex min-h-[44px] items-center justify-center gap-2 rounded-xl px-3 text-sm font-semibold transition-[background-color,color,box-shadow] duration-200 sm:px-4',
                  active
                    ? 'bg-white text-brand-800 shadow-card ring-1 ring-slate-200/80 dark:bg-slate-900 dark:text-white dark:ring-slate-700'
                    : 'text-muted hover:text-brand-700',
                )}
              >
                <s.icon className="h-4 w-4 shrink-0 transition-transform duration-200 group-hover:scale-110" />
                <span className="truncate sm:hidden">{s.short}</span>
                <span className="hidden whitespace-nowrap sm:inline">{s.label}</span>
              </button>
            )
          })}
        </div>
        <div key={source.key} className="animate-page-in space-y-4">
          {source.key === 'production-records' ? (
            <ProductionRecordsSource importer={source.importer} />
          ) : source.importer ? (
            <CsvImporter importer={source.importer} />
          ) : (
            <AccessSyncPanel />
          )}
          {/* Orders only: starting from an empty sheet. Below the importer and quiet, so the page's first control is
              not the one that removes everything; the confirmation stays. */}
          {source.key === 'orders' && (
            <Card className="flex flex-wrap items-center justify-between gap-3 p-4 sm:p-5">
              <div className="min-w-0 flex-1 basis-full sm:basis-0">
                <h3 className="text-base font-bold">Starting from an empty sheet</h3>
                <p className="mt-0.5 text-sm text-muted">
                  Loading a fresh export that no longer carries old lines? Remove the current order lines first. They are marked deleted, not
                  erased, and any line the new export still carries comes back when it is imported.
                </p>
              </div>
              <Button className="min-h-[44px] hover:text-rose-600" onClick={() => setConfirmClear(true)}>
                <Trash2 className="h-4 w-4" /> Remove all current order lines…
              </Button>
            </Card>
          )}
        </div>
      </div>

      <Modal
        open={confirmClear}
        onClose={() => {
          if (!clearing) setConfirmClear(false)
        }}
        title="Remove all current order lines?"
        icon={<Trash2 className="h-5 w-5" />}
        size="sm"
        footer={
          <>
            <Button className="min-h-[48px]" onClick={() => setConfirmClear(false)} disabled={clearing}>
              Keep them
            </Button>
            <Button variant="danger" className="min-h-[48px]" onClick={() => void runClear()} disabled={clearing}>
              {clearing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
              Remove all
            </Button>
          </>
        }
      >
        <p className="text-sm text-slate-600 dark:text-slate-300">
          Every order line disappears from New inspection and the importers. Nothing is erased: the lines are marked deleted, sessions
          already recorded against them keep their history, and a line the new export still carries comes back when you import it. This
          action is written to the audit log with your name.
        </p>
      </Modal>
    </AdminLayout>
  )
}
