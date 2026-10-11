import { useMemo, useState } from 'react'
import { usePersistedState } from '@/lib/usePersistedState'
import { Search, Package2, ArrowLeft, ChevronRight, Loader2 } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { Badge, Button, Card, EmptyState, Input } from '@/components/ui'
import { fetchSampleDetail, useCoilSearch, useCoilUsage } from '@/services/queries'
import { sampleDetailPath } from '@/lib/links'
import { useApp } from '@/store/AppContext'

/**
 * §4 — Coil Search. Used when an inspector needs to trace material back:
 * coil → sample → order → customer.
 */
export function CoilSearchPage() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { toast } = useApp()
  const [term, setTerm] = usePersistedState('qc-coils:term', '')

  // The coil catalogue is not loaded to find one. The API matches the term as
  // a prefix of the coil number, and of the grade and supplier once something
  // has been typed.
  const { data: results = [], isLoading } = useCoilSearch(term, 25)

  // Traceability is resolved only for the coils on screen.
  const coilNumbers = useMemo(() => results.map((c) => c.coilNumber), [results])
  const { data: usageRows = [] } = useCoilUsage(coilNumbers)

  /** Where each coil has been used — the traceability the search exists for. */
  const usage = useMemo(() => {
    const map = new Map<string, { sampleId: string; orderNumber: string; customer: string; sampleIndex: number }[]>()
    for (const u of usageRows) {
      const key = u.coilNumber.toLowerCase()
      const arr = map.get(key) ?? []
      arr.push({ sampleId: u.sampleId, orderNumber: u.orderNumber, customer: u.customer, sampleIndex: u.sampleIndex })
      map.set(key, arr)
    }
    return map
  }, [usageRows])

  // A usage opens the sample's full record in History, over its session: the rest of the trail. The usage names the
  // sample, not its session, so the record is read first — under the key History's view reads, so it opens filled.
  const [opening, setOpening] = useState<string | null>(null)
  async function openUsage(sampleId: string) {
    setOpening(sampleId)
    try {
      const { sample } = await fetchSampleDetail(queryClient, sampleId)
      navigate(sampleDetailPath(sample.sessionId, sampleId))
    } catch (e) {
      toast(e instanceof Error ? e.message : 'The sample could not be opened.', 'error')
    } finally {
      setOpening(null)
    }
  }

  return (
    <div className="space-y-4">
      <button
        onClick={() => navigate('/')}
        className="inline-flex min-h-[44px] items-center gap-1.5 text-sm font-semibold text-muted hover:text-brand-600"
      >
        <ArrowLeft className="h-4 w-4" /> Inspections
      </button>

      <div>
        <h1 className="text-2xl font-extrabold tracking-tight">Coil Search</h1>
      </div>

      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
        <Input
          autoFocus
          value={term}
          onChange={(e) => setTerm(e.target.value)}
          placeholder="Coil number, grade or supplier…"
          className="min-h-[52px] pl-9 text-base"
        />
      </div>

      {isLoading ? (
        <Card className="p-10 text-center text-sm text-muted">Loading…</Card>
      ) : results.length === 0 ? (
        <EmptyState
          icon={<Package2 className="h-10 w-10" />}
          title="No coils found"
          hint={term ? 'Try a different coil number or supplier.' : 'The coil catalogue is empty — import coils from Admin.'}
        />
      ) : (
        <div className="grid items-start gap-3 md:grid-cols-2 xl:grid-cols-3">
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
                {c.notes && <p className="mt-2 text-sm text-muted">{c.notes}</p>}

                <div className="mt-3 border-t border-slate-100 pt-3 dark:border-slate-800">
                  <p className="mb-1.5 text-xs font-bold uppercase text-muted">Used in</p>
                  {used.length === 0 ? (
                    <p className="text-sm text-muted">Not recorded against any sample yet.</p>
                  ) : (
                    <div className="flex flex-wrap gap-2">
                      {used.map((u, i) => (
                        <button
                          key={`${u.sampleId}-${i}`}
                          type="button"
                          onClick={() => void openUsage(u.sampleId)}
                          disabled={opening !== null}
                          aria-busy={opening === u.sampleId || undefined}
                          className="inline-flex items-center gap-1 rounded-lg bg-slate-100 py-1 pe-1.5 ps-2.5 text-start text-xs font-semibold transition-colors hover:bg-brand-50 hover:text-brand-700 disabled:cursor-wait dark:bg-slate-800 dark:hover:bg-brand-500/10 dark:hover:text-brand-300 touch:min-h-[44px]"
                        >
                          {u.orderNumber} · #{u.sampleIndex} · {u.customer}
                          {opening === u.sampleId ? <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" aria-hidden /> : <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted rtl:rotate-180" aria-hidden />}
                        </button>
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
      <dt className="text-xs font-semibold uppercase text-muted">{label}</dt>
      <dd className="font-semibold">{value ?? '—'}</dd>
    </div>
  )
}
