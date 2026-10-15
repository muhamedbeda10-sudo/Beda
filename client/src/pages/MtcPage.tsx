// ============================================================================
// MTC — the coil register as a table, for everyone signed in; and, for whoever
// the administrator allowed, Upload MTC: Claude reads the mill's certificate,
// the person reviews every coil against the paper, then saves.
// ============================================================================

import { useEffect, useMemo, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { FileUp, Loader2, Package2, X } from 'lucide-react'
import { COIL_TABLE_SORTS, MTC_MAX_PDF_BYTES, type CoilTableSort, type MtcExtractResult } from '@qc/shared/mtc'
import { Button, Card, EmptyState } from '@/components/ui'
import { FilterBar, FilterSelect, HeaderStat, type FilterChip } from '@/components/ui/PageShell'
import { ScrollX } from '@/components/ui/ScrollX'
import { MtcReview } from '@/components/mtc/MtcReview'
import { readCertificate, useCoilTable, useCoilTableOptions } from '@/services/mtc'
import { useDebounced } from '@/services/queries'
import { usePersistedState } from '@/lib/usePersistedState'
import { useAuth } from '@/store/AuthContext'
import { useApp } from '@/store/AppContext'

const SORT_LABEL: Record<CoilTableSort, string> = { coilNumber: 'By coil number', newest: 'Newest first' }

const COLUMNS: { label: string; align?: 'right' }[] = [
  { label: 'Coil number' },
  { label: 'Grade' },
  { label: 'SM type' },
  { label: 'Supplier' },
  { label: 'Thickness', align: 'right' },
  { label: 'Width', align: 'right' },
  { label: 'Yield', align: 'right' },
  { label: 'Notes' },
]

export function MtcPage() {
  const { profile, reloadProfile } = useAuth()
  const { toast } = useApp()
  const queryClient = useQueryClient()
  const canUpload = profile?.mtcUpload === true

  const [term, setTerm] = usePersistedState('qc-mtc:term', '')
  const [supplier, setSupplier] = usePersistedState('qc-mtc:supplier', '')
  const [smType, setSmType] = usePersistedState('qc-mtc:sm-type', '')
  const [sort, setSort] = usePersistedState<CoilTableSort>('qc-mtc:sort', 'coilNumber')
  const search = useDebounced(term.trim())
  const query = useMemo(() => ({ search, supplier, smType, sort: COIL_TABLE_SORTS.includes(sort) ? sort : 'coilNumber' }), [search, supplier, smType, sort])
  const table = useCoilTable(query)
  const { data: options } = useCoilTableOptions()
  const rows = useMemo(() => table.data?.pages.flatMap((p) => p.rows) ?? [], [table.data])
  const total = table.data?.pages[0]?.total ?? 0

  // ---- Reading a certificate ----
  const fileInput = useRef<HTMLInputElement>(null)
  const [reading, setReading] = useState<{ name: string; abort: AbortController } | null>(null)
  const [result, setResult] = useState<MtcExtractResult | null>(null)
  const readingRef = useRef<AbortController | null>(null)

  // A reading under way is stopped when the page is left: it costs nothing more.
  useEffect(() => () => readingRef.current?.abort(), [])
  // The permission is the administrator's to give or take at any time: read again on opening, so Upload shows as it stands.
  useEffect(() => {
    void reloadProfile().catch(() => undefined)
  }, [reloadProfile])

  async function startReading(file: File) {
    if (file.size > MTC_MAX_PDF_BYTES) return toast(`A certificate may be at most ${MTC_MAX_PDF_BYTES / 1024 / 1024} MB. Split the PDF and upload the parts.`, 'error')
    const abort = new AbortController()
    readingRef.current = abort
    setReading({ name: file.name, abort })
    try {
      const read = await readCertificate(file, abort.signal)
      setResult(read)
    } catch (e) {
      if ((e as Error).name !== 'AbortError') toast(e instanceof Error ? e.message : 'The certificate could not be read.', 'error')
    } finally {
      readingRef.current = null
      setReading(null)
    }
  }

  const chips: FilterChip[] = []
  if (supplier) chips.push({ key: 'supplier', label: `Supplier: ${supplier}`, onRemove: () => setSupplier('') })
  if (smType) chips.push({ key: 'smType', label: `SM type: ${smType}`, onRemove: () => setSmType('') })

  if (result) {
    return (
      <MtcReview
        result={result}
        suppliers={options?.suppliers ?? []}
        onDone={(saved) => {
          setResult(null)
          if (saved) {
            // The coils just added are the first thing to see.
            setSort('newest')
            void queryClient.invalidateQueries({ queryKey: ['coils', 'table'] })
          }
        }}
      />
    )
  }

  return (
    <div className="space-y-3">
      <FilterBar
        search={{ value: term, onChange: setTerm, placeholder: 'Coil number, grade, supplier or certificate…', label: 'Search coils' }}
        filters={
          <>
            <FilterSelect label="Supplier" value={supplier} onChange={setSupplier}>
              <option value="">All suppliers</option>
              {(options?.suppliers ?? []).map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </FilterSelect>
            <FilterSelect label="SM type" value={smType} onChange={setSmType}>
              <option value="">All SM types</option>
              {(options?.smTypes ?? []).map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </FilterSelect>
            <FilterSelect label="Order" value={sort} onChange={(v) => setSort(v as CoilTableSort)}>
              {COIL_TABLE_SORTS.map((s) => (
                <option key={s} value={s}>
                  {SORT_LABEL[s]}
                </option>
              ))}
            </FilterSelect>
          </>
        }
        chips={chips}
        canReset={!!term || !!supplier || !!smType || sort !== 'coilNumber'}
        onReset={() => {
          setTerm('')
          setSupplier('')
          setSmType('')
          setSort('coilNumber')
        }}
        actions={
          canUpload ? (
            <>
              <input
                ref={fileInput}
                type="file"
                accept="application/pdf,.pdf"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0]
                  e.target.value = ''
                  if (file) void startReading(file)
                }}
              />
              <Button variant="primary" className="h-10 touch:h-11" disabled={reading !== null} onClick={() => fileInput.current?.click()}>
                <FileUp className="h-4 w-4" /> Upload MTC
              </Button>
            </>
          ) : undefined
        }
      />

      {reading && (
        <Card className="flex flex-wrap items-center gap-3 p-4" role="status" aria-live="polite">
          <Loader2 className="h-5 w-5 shrink-0 animate-spin text-brand-600" />
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold">Reading {reading.name}…</p>
            <p className="text-xs text-muted">Claude is reading every page. A long certificate takes a few minutes; keep this page open.</p>
          </div>
          <Button className="min-h-[44px]" onClick={() => reading.abort.abort()}>
            <X className="h-4 w-4" /> Cancel
          </Button>
        </Card>
      )}

      {table.isLoading ? (
        <Card className="flex items-center justify-center gap-2 p-10 text-sm text-muted">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading…
        </Card>
      ) : table.isError ? (
        <Card className="p-6 text-sm text-rose-700 dark:text-rose-300">{table.error instanceof Error ? table.error.message : 'The coils could not be loaded.'}</Card>
      ) : rows.length === 0 ? (
        <EmptyState
          icon={<Package2 className="h-10 w-10" />}
          title={search || supplier || smType ? 'No coils match' : 'No coils registered yet'}
          hint={search || supplier || smType ? 'Try another search or clear the filters.' : canUpload ? 'Upload a mill test certificate to add its coils.' : undefined}
        />
      ) : (
        <>
          <ScrollX className="rounded-2xl bg-white ring-1 ring-slate-200 dark:bg-slate-900 dark:ring-slate-800" innerClassName="rounded-2xl" label="Coils">
            <table className="w-full min-w-[56rem] text-sm">
              <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-muted dark:bg-slate-800/60">
                <tr>
                  {COLUMNS.map((c) => (
                    <th key={c.label} className={c.align === 'right' ? 'px-3 py-2.5 text-right font-bold' : 'px-3 py-2.5 font-bold'}>
                      {c.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {rows.map((c) => (
                  <tr key={c.id} className="hover:bg-slate-50/70 dark:hover:bg-slate-800/40">
                    <td className="whitespace-nowrap px-3 py-2 font-mono text-[13px] font-semibold">{c.coilNumber}</td>
                    <td className="whitespace-nowrap px-3 py-2">{c.grade ?? '—'}</td>
                    <td className="px-3 py-2">{c.smType ?? '—'}</td>
                    <td className="px-3 py-2">{c.supplier ?? '—'}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{c.thickness ?? '—'}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{c.width ?? '—'}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{c.yield ?? '—'}</td>
                    <td className="max-w-[16rem] truncate px-3 py-2 text-muted" title={c.notes}>
                      {c.notes ?? ''}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </ScrollX>
          <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-muted">
            <span>
              <HeaderStat value={rows.length} label={`of ${total.toLocaleString()} coil${total === 1 ? '' : 's'} shown`} />
            </span>
            {table.hasNextPage && (
              <Button className="min-h-[44px]" disabled={table.isFetchingNextPage} onClick={() => void table.fetchNextPage()}>
                {table.isFetchingNextPage && <Loader2 className="h-4 w-4 animate-spin" />}
                Load more
              </Button>
            )}
          </div>
        </>
      )}
    </div>
  )
}
