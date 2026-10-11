// ============================================================================
// §24 — the ERP's production task record as an import source: what is stored
// now (one line), the importer itself, and the one way to take it all back —
// "Remove all", for a wrong file. The record is the child of the order sheet
// (joined on the Order ID), so the line says how many of its order lines the
// sheet knows. Nothing else in the app writes a row of it.
// ============================================================================

import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { AlertCircle, Factory, Loader2, Trash2 } from 'lucide-react'
import { Button, Card, Modal } from '@/components/ui'
import { CsvImporter } from '@/components/admin/CsvImporter'
import type { Importer } from '@/components/admin/importers'
import { countOf, describeProductionRecords } from '@/components/admin/productionRecords'
import { useProductionRecordsSummary } from '@/services/queries'
import { clearProductionRecords } from '@/services/mutations'
import { useApp } from '@/store/AppContext'

export function ProductionRecordsSource({ importer }: { importer: Importer }) {
  const queryClient = useQueryClient()
  const { toast } = useApp()
  const { data: summary, isLoading, isError } = useProductionRecordsSummary()
  const [confirmClear, setConfirmClear] = useState(false)
  const [clearing, setClearing] = useState(false)

  async function runClear() {
    setClearing(true)
    try {
      const { removed } = await clearProductionRecords(queryClient)
      toast(`${countOf(removed, 'production record')} marked deleted. Load the right export now.`, 'success')
      setConfirmClear(false)
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not remove the production records.', 'error')
    } finally {
      setClearing(false)
    }
  }

  return (
    <div className="space-y-4">
      {/* ---- What is stored now ---- */}
      <Card className="flex flex-wrap items-center justify-between gap-3 p-4 sm:p-5">
        <div className="flex min-w-0 items-start gap-3">
          <Factory className="mt-0.5 h-5 w-5 shrink-0 text-brand-600 dark:text-brand-400" />
          <div className="min-w-0">
            <h2 className="text-base font-bold">Stored now</h2>
            {isLoading ? (
              <div className="skeleton mt-1.5 h-4 w-72 max-w-full" />
            ) : isError || !summary ? (
              <p className="mt-0.5 flex items-start gap-1.5 text-sm text-rose-700 dark:text-rose-300">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" /> Could not read what is stored. The import still works.
              </p>
            ) : (
              <p className="mt-0.5 text-sm text-muted">{describeProductionRecords(summary)}</p>
            )}
          </div>
        </div>
        <Button variant="danger" className="min-h-[48px]" onClick={() => setConfirmClear(true)} disabled={summary?.rows === 0}>
          <Trash2 className="h-4 w-4" /> Remove all current production records
        </Button>
      </Card>

      <CsvImporter importer={importer} />

      <Modal
        open={confirmClear}
        onClose={() => {
          if (!clearing) setConfirmClear(false)
        }}
        title="Remove all current production records?"
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
          Every production record leaves the assistant's data. Nothing is erased: the records are marked deleted, the order sheet they hang
          off is untouched, and a record the next export still carries comes back when you import it. This action is written to the audit
          log with your name.
        </p>
      </Modal>
    </div>
  )
}
