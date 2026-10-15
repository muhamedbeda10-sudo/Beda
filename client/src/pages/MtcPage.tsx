// ============================================================================
// MTC — the material registers as tables (coils, welding wire, mesh wire), for
// everyone signed in; and, for whoever the administrator allowed, Upload MTC:
// Claude reads the supplier's certificate, tells which register it belongs to,
// the person reviews every item against the paper, then saves.
// ============================================================================

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Cable, FileUp, Grid3x3, Loader2, Package2, X } from 'lucide-react'
import { MTC_ADDED_COLUMN, MTC_KINDS, MTC_MAX_PDF_BYTES, MTC_REGISTERS, MTC_TABLE_PAGE, isMtcKind, type MtcExtractResult, type MtcKind, type MtcRegister, type MtcRegisterRow } from '@qc/shared/mtc'
import { Button, Card, EmptyState } from '@/components/ui'
import { FilterBar, Segmented } from '@/components/ui/PageShell'
import { ColumnPicker, GridFrame, GridHead, SkeletonRows, TableFooter, useResizableColumns, type ColumnDef } from '@/components/ui/ResizableColumns'
import { useServerColumns } from '@/components/ui/ColumnFilter'
import { MtcReview } from '@/components/mtc/MtcReview'
import { loadMtcValues, readCertificate, useMtcOptions, useMtcTable } from '@/services/mtc'
import { useAiMe, useDebounced } from '@/services/queries'
import { usePersistedState } from '@/lib/usePersistedState'
import { useApp } from '@/store/AppContext'
import { cn, formatDate } from '@/lib/utils'

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

/** A register's columns for the grid: its fields at widths that suit them, then when each was registered (off until ticked). */
function columnsOf(register: MtcRegister): ColumnDef[] {
  const cols: ColumnDef[] = register.fields.map((f) => ({
    key: f.key,
    label: f.unit ? `${f.label} (${f.unit})` : f.label,
    width: f.key === 'notes' ? 220 : f.type === 'number' ? 120 : f.identifies ? 170 : f.choices ? 120 : 150,
    min: f.type === 'number' ? 80 : 90,
    align: f.type === 'number' ? 'right' : 'left',
    flex: f.key === 'notes',
    hideable: !f.identifies,
  }))
  cols.push({ key: MTC_ADDED_COLUMN, label: 'Added', width: 130, min: 100, defaultHidden: true })
  return cols
}

/** One register's table, as History's: resizable columns, Excel's filter and sort in each header, the page's footer. */
function RegisterTable({
  register,
  onKind,
  actions,
  reading,
  canUpload,
}: {
  register: MtcRegister
  onKind: (k: MtcKind) => void
  actions?: ReactNode
  reading?: ReactNode
  canUpload: boolean
}) {
  const kind = register.kind
  const [term, setTerm] = usePersistedState(`qc-mtc:${kind}:term`, '')
  const [pageSize, setPageSize] = usePersistedState<number>('qc-mtc:page-size', MTC_TABLE_PAGE)
  const search = useDebounced(term.trim())
  // Excel's filter and sort on every column, answered over the whole register.
  const columnsView = useServerColumns()
  const query = useMemo(() => ({ search, cf: columnsView.cf, sort: columnsView.sortParam }), [search, columnsView.cf, columnsView.sortParam])
  const table = useMtcTable(kind, query, pageSize)
  const rows = useMemo(() => table.data?.pages.flatMap((p) => p.rows) ?? [], [table.data])
  const total = table.data?.pages[0]?.total ?? null
  const columns = useMemo(() => columnsOf(register), [register])
  const grid = useResizableColumns(`qc-mtc:${kind}:grid`, columns)
  const filtered = !!search || columnsView.active
  const Icon = KIND_ICON[kind]
  const labelOf = (key: string) => columns.find((c) => c.key === key)?.label ?? key
  const columnMenu = (c: ColumnDef) => {
    const field = register.fields.find((f) => f.key === c.key)
    return columnsView.menu(c.key, c.label, (s) => loadMtcValues(kind, query, c.key, s), {
      numeric: field?.type === 'number',
      align: c.align === 'right' ? 'right' : 'left',
      formatValue: c.key === MTC_ADDED_COLUMN ? (v) => formatDate(v) : undefined,
    })
  }

  const cell = (c: ColumnDef, row: MtcRegisterRow) => {
    if (c.key === MTC_ADDED_COLUMN) {
      return (
        <td key={c.key} className="truncate px-3 py-3 text-muted">
          {row.createdAt ? formatDate(row.createdAt) : '—'}
        </td>
      )
    }
    const field = register.fields.find((f) => f.key === c.key)!
    const v = row.values[c.key]
    const shown = v === undefined || v === '' ? '' : String(v)
    return (
      <td
        key={c.key}
        data-tip={shown || undefined}
        className={cn(
          'truncate px-3 py-3',
          field.type === 'number' && 'text-right tabular-nums',
          field.mono && 'font-mono text-[13px]',
          field.identifies && 'font-semibold',
          field.key === 'notes' && 'text-muted',
        )}
      >
        {shown || '—'}
      </td>
    )
  }

  return (
    <div className="space-y-3">
      {/* No title row: the tab names the page. The register switch, the search and the actions share one row, as History's. */}
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
        actionsInline
        actions={
          <>
            <span className="hidden md:inline-flex">
              <ColumnPicker grid={grid} />
            </span>
            {actions}
          </>
        }
        search={{ value: term, onChange: setTerm, placeholder: `Search ${register.plural}, suppliers or certificates…`, label: `Search ${register.plural}` }}
        chips={columnsView.chips(labelOf)}
        canReset={filtered}
        onReset={() => {
          setTerm('')
          columnsView.clear()
        }}
      />

      {reading}

      {table.isError && !table.data ? (
        <Card className="p-6">
          <EmptyState icon={<Icon className="h-10 w-10" />} title="The register could not be loaded" hint="Check the connection and try again." action={<Button onClick={() => void table.refetch()}>Try again</Button>} />
        </Card>
      ) : table.isLoading ? (
        <Card className="overflow-hidden">
          <GridFrame>
            <table className="sticky-first w-full text-sm" style={grid.tableStyle}>
              {grid.colgroup}
              <GridHead grid={grid} menu={columnMenu} />
              <SkeletonRows grid={grid} />
            </table>
          </GridFrame>
        </Card>
      ) : rows.length === 0 ? (
        <EmptyState
          icon={<Icon className="h-10 w-10" />}
          title={filtered ? `No ${register.plural} match` : `No ${register.plural} registered yet`}
          hint={filtered ? 'Nothing in the whole register matches these filters — clear the search or a column’s filter.' : canUpload ? 'Upload a certificate to add them.' : undefined}
        />
      ) : (
        <>
          {/* Phone — one card per item: its identifier, then the rest of its fields. */}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 md:hidden">
            {rows.map((row) => (
              <Card key={row.id} className="min-w-0 p-4">
                <p className={cn('truncate font-bold', register.fields[0].mono && 'font-mono')}>{register.fields.filter((f) => f.identifies).map((f) => row.values[f.key] ?? '—').join(' · ')}</p>
                <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1.5 text-sm">
                  {register.fields
                    .filter((f) => !f.identifies && row.values[f.key] !== undefined)
                    .map((f) => (
                      <div key={f.key} className={cn('min-w-0', f.key === 'notes' && 'col-span-2')}>
                        <dt className="text-xs font-semibold uppercase text-muted">{f.label}</dt>
                        <dd className="truncate">
                          {row.values[f.key]}
                          {f.unit ? ` ${f.unit}` : ''}
                        </dd>
                      </div>
                    ))}
                </dl>
              </Card>
            ))}
          </div>

          {/* md+ — the same rows as History's table: the columns are the person's to size, choose, filter and sort. */}
          <Card className="hidden overflow-hidden md:block">
            <GridFrame>
              <table ref={grid.tableRef} className={cn('sticky-first w-full text-sm', !grid.enabled && 'min-w-[720px]')} style={grid.tableStyle}>
                {grid.colgroup}
                <GridHead grid={grid} menu={columnMenu} />
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                  {rows.map((row) => (
                    <tr key={row.id} className="data-row bg-white transition-colors hover:bg-slate-50 dark:bg-slate-900 dark:hover:bg-[#17202f]">
                      {grid.visible.map((c) => cell(c, row))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </GridFrame>
          </Card>

          <TableFooter
            shown={rows.length}
            total={total}
            noun={total === 1 ? register.singular : register.plural}
            hasMore={!!table.hasNextPage}
            loadingMore={table.isFetchingNextPage}
            onMore={() => void table.fetchNextPage()}
            pageSize={pageSize}
            onPageSize={setPageSize}
            extra={table.isFetching && !table.isFetchingNextPage ? <span className="text-xs">Searching the whole register…</span> : undefined}
          />
        </>
      )}
    </div>
  )
}
