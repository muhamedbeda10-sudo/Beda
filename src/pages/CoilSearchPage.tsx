import { useMemo, useState } from 'react'
import { Search, Package2, ArrowLeft } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { Badge, Button, Card, EmptyState, Input } from '@/components/ui'
import { useDocsByIds, usePrefixSearch, useWhereIn } from '@/services/useCollection'
import { COL } from '@/services/repository'
import type { Coil, InspectionSample, ProductionOrder, SampleCoil } from '@/domain/types'

/**
 * §4 — Coil Search. Used when an inspector needs to trace material back:
 * coil → sample → order → customer.
 */
export function CoilSearchPage() {
  const navigate = useNavigate()
  const [term, setTerm] = useState('')
  const t = term.trim()

  // 30,000 coils are not loaded to find one. Each field an inspector might type
  // is matched as a prefix on the server; the grade and supplier queries only
  // run once something has been typed.
  const { rows: byNumber, loading } = usePrefixSearch<Coil>(COL.coils, 'coilNumber', t, 25)
  const { rows: byGrade } = usePrefixSearch<Coil>(COL.coils, 'grade', t, 25, { enabled: t.length > 0 })
  const { rows: bySupplier } = usePrefixSearch<Coil>(COL.coils, 'supplier', t, 25, { enabled: t.length > 0 })

  const results = useMemo(() => {
    const byId = new Map<string, Coil>()
    for (const c of [...byNumber, ...byGrade, ...bySupplier]) byId.set(c.id, c)
    return Array.from(byId.values())
      .sort((a, b) => a.coilNumber.localeCompare(b.coilNumber))
      .slice(0, 25)
  }, [byNumber, byGrade, bySupplier])

  // Traceability is resolved only for the coils on screen: their usage rows,
  // then the samples those name, then the orders behind those samples.
  const coilNumbers = useMemo(() => results.map((c) => c.coilNumber), [results])
  const { rows: sampleCoils } = useWhereIn<SampleCoil>(COL.sampleCoils, 'coilNumber', coilNumbers)
  const sampleIds = useMemo(() => sampleCoils.map((sc) => sc.sampleId), [sampleCoils])
  const { rows: samples } = useDocsByIds<InspectionSample>(COL.samples, sampleIds)
  const orderIds = useMemo(() => samples.map((s) => s.orderId), [samples])
  const { rows: orders } = useDocsByIds<ProductionOrder>(COL.orders, orderIds)

  /** Where each coil has been used — the traceability the search exists for. */
  const usage = useMemo(() => {
    const sampleById = new Map(samples.map((s) => [s.id, s]))
    const orderById = new Map(orders.map((o) => [o.id, o]))
    const map = new Map<string, { orderNumber: string; customer: string; sampleIndex: number }[]>()
    for (const sc of sampleCoils) {
      const sample = sampleById.get(sc.sampleId)
      const order = sample ? orderById.get(sample.orderId) : undefined
      if (!sample || !order) continue
      const key = sc.coilNumber.toLowerCase()
      const arr = map.get(key) ?? []
      arr.push({ orderNumber: order.orderNumber, customer: order.customer, sampleIndex: sample.index })
      map.set(key, arr)
    }
    return map
  }, [sampleCoils, samples, orders])

  return (
    <div className="space-y-4">
      <button
        onClick={() => navigate('/')}
        className="inline-flex min-h-[44px] items-center gap-1.5 text-sm font-semibold text-slate-500 hover:text-brand-600 dark:text-slate-400"
      >
        <ArrowLeft className="h-4 w-4" /> Inspections
      </button>

      <div>
        <h1 className="text-2xl font-extrabold tracking-tight">Coil Search</h1>
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
          Trace raw material back: coil → sample → order → customer.
        </p>
      </div>

      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
        <Input
          autoFocus
          value={term}
          onChange={(e) => setTerm(e.target.value)}
          placeholder="Coil number, grade or supplier…"
          className="min-h-[52px] pl-9 text-base"
        />
      </div>

      {loading ? (
        <Card className="p-10 text-center text-sm text-slate-400">Loading…</Card>
      ) : results.length === 0 ? (
        <EmptyState
          icon={<Package2 className="h-10 w-10" />}
          title="No coils found"
          hint={term ? 'Try a different coil number or supplier.' : 'The coil catalogue is empty — import coils from Admin.'}
        />
      ) : (
        <div className="space-y-3">
          {results.map((c) => {
            const used = usage.get(c.coilNumber.toLowerCase()) ?? []
            return (
              <Card key={c.id} className="p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-lg font-bold">{c.coilNumber}</span>
                  {c.grade && <Badge tone="blue">{c.grade}</Badge>}
                  {c.smType && <Badge tone="neutral">{c.smType}</Badge>}
                </div>
                <dl className="mt-3 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
                  <Attr label="Supplier" value={c.supplier} />
                  <Attr label="Thickness" value={c.thickness} />
                  <Attr label="Width" value={c.width} />
                  <Attr label="Yield" value={c.yield} />
                </dl>
                {c.notes && <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">{c.notes}</p>}

                <div className="mt-3 border-t border-slate-100 pt-3 dark:border-slate-800">
                  <p className="mb-1.5 text-xs font-bold uppercase text-slate-400">Used in</p>
                  {used.length === 0 ? (
                    <p className="text-sm text-slate-400">Not recorded against any sample yet.</p>
                  ) : (
                    <div className="flex flex-wrap gap-2">
                      {used.map((u, i) => (
                        <span
                          key={i}
                          className="rounded-lg bg-slate-100 px-2.5 py-1 text-xs font-semibold dark:bg-slate-800"
                        >
                          {u.orderNumber} · #{u.sampleIndex} · {u.customer}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              </Card>
            )
          })}
        </div>
      )}
    </div>
  )
}

function Attr({ label, value }: { label: string; value?: string | number }) {
  return (
    <div>
      <dt className="text-xs font-semibold uppercase text-slate-400">{label}</dt>
      <dd className="font-semibold">{value ?? '—'}</dd>
    </div>
  )
}
