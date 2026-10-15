// ============================================================================
// MTC — the material registers as tables (coils, welding wire, mesh wire), for
// everyone signed in; and, for whoever the administrator allowed, Upload MTC:
// Claude reads the supplier's certificate, tells which register it belongs to,
// the person reviews every item against the paper, then saves.
// ============================================================================

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Cable, FileUp, Grid3x3, Loader2, Package2, X } from 'lucide-react'
import { MTC_KINDS, MTC_MAX_PDF_BYTES, MTC_REGISTERS, MTC_TABLE_SORTS, isMtcKind, type MtcExtractResult, type MtcKind, type MtcRegister, type MtcTableSort } from '@qc/shared/mtc'
import { Button, Card, EmptyState } from '@/components/ui'
import { FilterBar, FilterSelect, HeaderStat, Segmented, type FilterChip } from '@/components/ui/PageShell'
import { ScrollX } from '@/components/ui/ScrollX'
import { MtcReview } from '@/components/mtc/MtcReview'
import { readCertificate, useMtcOptions, useMtcTable } from '@/services/mtc'
import { useAiMe, useDebounced } from '@/services/queries'
import { usePersistedState } from '@/lib/usePersistedState'
import { useApp } from '@/store/AppContext'
import { cn } from '@/lib/utils'

const SORT_LABEL = (register: MtcRegister): Record<MtcTableSort, string> => ({ key: `By ${register.fields[0].label.toLowerCase()}`, newest: 'Newest first' })
const KIND_ICON = { coils: Package2, 'welding-wire': Cable, 'mesh-wire': Grid3x3 } as const

export function MtcPage() {
  const { toast } = useApp()
  const queryClient = useQueryClient()
  // Given by the AI assistant's owner with the rest of a person's AI settings; the server checks it again on every request.
  const aiMe = useAiMe()
  const canUpload = aiMe.data?.mtc === true

  const [storedKind, setKind] = usePersistedState<MtcKind>('qc-mtc:kind', 'coils')
  const kind: MtcKind = isMtcKind(storedKind) ? storedKind : 'coils'

  // ---- Reading a certificate ----
  const fileInput = useRef<HTMLInputElement>(null)
  const [reading, setReading] = useState<{ name: string; abort: AbortController } | null>(null)
  const [result, setResult] = useState<MtcExtractResult | null>(null)
  const readingRef = useRef<AbortController | null>(null)

  // A reading under way is stopped when the page is left: it costs nothing more.
  useEffect(() => () => readingRef.current?.abort(), [])
  // The permission is the owner's to give or take at any time: read again on opening, so Upload shows as it stands.
  const refetchMe = aiMe.refetch
  useEffect(() => {
    void refetchMe()
  }, [refetchMe])

  async function startReading(file: File) {
    if (file.size > MTC_MAX_PDF_BYTES) return toast(`A certificate may be at most ${MTC_MAX_PDF_BYTES / 1024 / 1024} MB. Split the PDF and upload the parts.`, 'error')
    const abort = new AbortController()
    readingRef.current = abort
    setReading({ name: file.name, abort })
    try {
      const read = await readCertificate(file, abort.signal)
      if (!read.kind) {
        toast(read.problem ? `Nothing was read: ${read.problem}` : 'This document is not a certificate of coils, welding wire or mesh wire: nothing was read.', 'error')
      } else {
        // The certificate decides the register: its tab is the one open under the review.
        setKind(read.kind)
        setResult(read)
      }
    } catch (e) {
      if ((e as Error).name !== 'AbortError') toast(e instanceof Error ? e.message : 'The certificate could not be read.', 'error')
    } finally {
      readingRef.current = null
      setReading(null)
    }
  }

  const { data: options } = useMtcOptions(kind)

  if (result?.kind) {
    const reviewed = result.kind
    return (
      <MtcReview
        key={`${reviewed}:${result.fileName}`}
        register={MTC_REGISTERS[reviewed]}
        result={result}
        suppliers={options?.suppliers ?? []}
        onDone={(saved) => {
          setResult(null)
          if (saved) void queryClient.invalidateQueries({ queryKey: reviewed === 'coils' ? ['coils'] : [reviewed] })
        }}
      />
    )
  }

  return (
    <RegisterTable
      key={kind}
      register={MTC_REGISTERS[kind]}
      onKind={setKind}
      options={options}
      canUpload={canUpload}
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
      reading={
        reading && (
          <Card className="flex flex-wrap items-center gap-3 p-4" role="status" aria-live="polite">
            <Loader2 className="h-5 w-5 shrink-0 animate-spin text-brand-600" />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold">Reading {reading.name}…</p>
              <p className="text-xs text-muted">
                Claude is reading every page and telling coils, welding wire and mesh wire apart. A long certificate takes a few minutes; keep this page open.
              </p>
            </div>
            <Button className="min-h-[44px]" onClick={() => reading.abort.abort()}>
              <X className="h-4 w-4" /> Cancel
            </Button>
          </Card>
        )
      }
    />
  )
}

/** One register's table, its search and filters remembered per register on this device. */
function RegisterTable({
  register,
  onKind,
  options,
  actions,
  reading,
  canUpload,
}: {
  register: MtcRegister
  onKind: (k: MtcKind) => void
  options?: { suppliers: string[]; filterValues: string[] }
  actions?: ReactNode
  reading?: ReactNode
  canUpload: boolean
}) {
  const kind = register.kind
  const [term, setTerm] = usePersistedState(`qc-mtc:${kind}:term`, '')
  const [supplier, setSupplier] = usePersistedState(`qc-mtc:${kind}:supplier`, '')
  const [filter, setFilter] = usePersistedState(`qc-mtc:${kind}:filter`, '')
  const [sort, setSort] = usePersistedState<MtcTableSort>(`qc-mtc:${kind}:sort`, 'key')
  const search = useDebounced(term.trim())
  const query = useMemo(() => ({ search, supplier, filter, sort: MTC_TABLE_SORTS.includes(sort) ? sort : ('key' as const) }), [search, supplier, filter, sort])
  const table = useMtcTable(kind, query)
  const rows = useMemo(() => table.data?.pages.flatMap((p) => p.rows) ?? [], [table.data])
  const total = table.data?.pages[0]?.total ?? 0
  const filterField = register.fields.find((f) => f.key === register.filter)!
  const sortLabel = SORT_LABEL(register)
  const filtered = !!search || !!supplier || !!filter
  const Icon = KIND_ICON[kind]

  const chips: FilterChip[] = []
  if (supplier) chips.push({ key: 'supplier', label: `Supplier: ${supplier}`, onRemove: () => setSupplier('') })
  if (filter) chips.push({ key: 'filter', label: `${filterField.label}: ${filter}`, onRemove: () => setFilter('') })

  return (
    <div className="space-y-3">
      <FilterBar
        leading={
          <Segmented
            label="Register"
            value={kind}
            onChange={onKind}
            options={MTC_KINDS.map((k) => {
              const KindIcon = KIND_ICON[k]
              return { value: k, label: MTC_REGISTERS[k].label, icon: <KindIcon className="h-4 w-4" /> }
            })}
          />
        }
        search={{ value: term, onChange: setTerm, placeholder: `Search ${register.plural}, suppliers or certificates…`, label: `Search ${register.plural}` }}
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
            <FilterSelect label={filterField.label} value={filter} onChange={setFilter}>
              <option value="">{filterField.label}: any</option>
              {(options?.filterValues ?? []).map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </FilterSelect>
            <FilterSelect label="Order" value={sort} onChange={(v) => setSort(v as MtcTableSort)}>
              {MTC_TABLE_SORTS.map((s) => (
                <option key={s} value={s}>
                  {sortLabel[s]}
                </option>
              ))}
            </FilterSelect>
          </>
        }
        chips={chips}
        canReset={filtered || sort !== 'key'}
        onReset={() => {
          setTerm('')
          setSupplier('')
          setFilter('')
          setSort('key')
        }}
        actions={actions}
      />

      {reading}

      {table.isLoading ? (
        <Card className="flex items-center justify-center gap-2 p-10 text-sm text-muted">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading…
        </Card>
      ) : table.isError ? (
        <Card className="p-6 text-sm text-rose-700 dark:text-rose-300">{table.error instanceof Error ? table.error.message : 'The register could not be loaded.'}</Card>
      ) : rows.length === 0 ? (
        <EmptyState
          icon={<Icon className="h-10 w-10" />}
          title={filtered ? `No ${register.plural} match` : `No ${register.plural} registered yet`}
          hint={filtered ? 'Try another search or clear the filters.' : canUpload ? 'Upload a certificate to add them.' : undefined}
        />
      ) : (
        <>
          <ScrollX className="rounded-2xl bg-white ring-1 ring-slate-200 dark:bg-slate-900 dark:ring-slate-800" innerClassName="rounded-2xl" label={register.label}>
            <table className="w-full min-w-[56rem] text-sm">
              <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-muted dark:bg-slate-800/60">
                <tr>
                  {register.fields.map((f) => (
                    <th key={f.key} className={cn('whitespace-nowrap px-3 py-2.5 font-bold', f.type === 'number' && 'text-right')}>
                      {f.unit ? `${f.label} (${f.unit})` : f.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {rows.map((r) => (
                  <tr key={r.id} className="hover:bg-slate-50/70 dark:hover:bg-slate-800/40">
                    {register.fields.map((f, i) => {
                      const v = r.values[f.key]
                      if (f.key === 'notes') {
                        return (
                          <td key={f.key} className="max-w-[16rem] truncate px-3 py-2 text-muted" title={v === undefined ? undefined : String(v)}>
                            {v ?? ''}
                          </td>
                        )
                      }
                      return (
                        <td
                          key={f.key}
                          className={cn('whitespace-nowrap px-3 py-2', f.type === 'number' && 'text-right tabular-nums', f.mono && 'font-mono text-[13px]', i === 0 && 'font-semibold')}
                        >
                          {v ?? '—'}
                        </td>
                      )
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </ScrollX>
          <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-muted">
            <span>
              <HeaderStat value={rows.length} label={`of ${total.toLocaleString()} ${total === 1 ? register.singular : register.plural} shown`} />
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
