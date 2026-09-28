import { useNavigate } from 'react-router-dom'
import { ArrowLeft } from 'lucide-react'
import { PdiList } from '@/components/pdi/PdiList'

/** §4 — Pre-Delivery Inspection: photo documentation of the items of an order that ship. */
export function PDIPage() {
  const navigate = useNavigate()
  return (
    <div className="space-y-4">
      <button
        onClick={() => navigate('/')}
        className="inline-flex min-h-[44px] items-center gap-1.5 text-sm font-semibold text-slate-500 hover:text-brand-600 dark:text-slate-400"
      >
        <ArrowLeft className="h-4 w-4" /> Inspections
      </button>
      <h1 className="text-2xl font-extrabold tracking-tight">PDI Documents</h1>
      <PdiList allowCreate />
    </div>
  )
}
