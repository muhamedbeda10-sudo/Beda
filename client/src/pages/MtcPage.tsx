// ============================================================================
// MTC — the material registers as tables (coils, welding wire, mesh wire) and
// the delivery notes, for everyone signed in; and, for whoever the
// administrator allowed, Upload MTC: Claude reads the supplier's certificate,
// tells which register it belongs to, the person reviews every item against
// the paper, then saves. The coil register follows the factory's sheet: its
// PO and delivery date come from the delivery note, its certificate opens
// from MTC No., its yield, tensile and elongation show green within the
// grade's limits and red outside; a coil opens on its details and slitting.
// ============================================================================

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Cable, FileUp, Grid3x3, Loader2, Package2, Truck, X } from 'lucide-react'
import {
  MTC_ACCEPT,
  MTC_ADDED_COLUMN,
  MTC_KINDS,
  MTC_REGISTERS,
  MTC_TABLE_PAGE,
  isMtcKind,
  mtcIdField,
  type MtcExtractResult,
  type MtcKind,
  type MtcRegister,
  type MtcRegisterRow,
} from '@qc/shared/mtc'
import { Button, Card, EmptyState } from '@/components/ui'
import { FilterBar, Segmented } from '@/components/ui/PageShell'
import { ColumnPicker, GridFrame, GridHead, SkeletonRows, TableFooter, useResizableColumns, type ColumnDef } from '@/components/ui/ResizableColumns'
import { useServerColumns } from '@/components/ui/ColumnFilter'
import { MtcReview } from '@/components/mtc/MtcReview'
import { CoilDetailsDialog } from '@/components/mtc/CoilDetailsDialog'
import { DeliveryNotesView } from '@/components/mtc/DeliveryNotes'
import { MtcDocumentLink } from '@/components/mtc/MtcDocument'
import { JudgedValue, fieldText, isJudged } from '@/components/mtc/cells'
import { CertificateRejected, loadMtcValues, readCertificate, useMtcOptions, useMtcTable } from '@/services/mtc'
import { useAiMe, useDebounced } from '@/services/queries'
import { usePersistedState } from '@/lib/usePersistedState'
import { useApp } from '@/store/AppContext'
import { cn, formatDate } from '@/lib/utils'

const KIND_ICON = { coils: Package2, 'welding-wire': Cable, 'mesh-wire': Grid3x3 } as const

/** The page's tabs: the three registers, then the delivery notes. */
type MtcTab = MtcKind | 'delivery-notes'
const isMtcTab = (v: unknown): v is MtcTab => isMtcKind(v) || v === 'delivery-notes'

/** The switch between the registers and the delivery notes, the same on each. */
function TabSwitch({ value, onChange }: { value: MtcTab; onChange: (t: MtcTab) => void }) {
  return (
    <Segmented<MtcTab>
      label="Register"
      value={value}
      onChange={onChange}
      options={[
        ...MTC_KINDS.map((k) => {
          const KindIcon = KIND_ICON[k]
          return { value: k as MtcTab, label: MTC_REGISTERS[k].label, icon: <KindIcon className="h-4 w-4" /> }
        }),
        { value: 'delivery-notes', label: 'Delivery notes', icon: <Truck className="h-4 w-4" /> },
      ]}
    />
  )
}

export function MtcPage() {
  const { toast } = useApp()
  const queryClient = useQueryClient()
  // Given by the AI assistant's owner with the rest of a person's AI settings; the server checks it again on every request.
  const aiMe = useAiMe()
  const canUpload = aiMe.data?.mtc === true

  const [storedTab, setKind] = usePersistedState<MtcTab>('qc-mtc:kind', 'coils')
  const tab: MtcTab = isMtcTab(storedTab) ? storedTab : 'coils'
  const kind: MtcKind = isMtcKind(tab) ? tab : 'coils'

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

  /** One certificate: its PDF, photos of its pages (in the order picked), or its spreadsheet. */
  async function startReading(files: File[]) {
    if (files.length === 0) return
    const abort = new AbortController()
    readingRef.current = abort
    setReading({ name: files.length === 1 ? files[0].name : `${files[0].name} and ${files.length - 1} more`, abort })
    try {
      const read = await readCertificate(files, abort.signal)
      if (!read.kind) {
        toast(read.problem ? `Nothing was read: ${read.problem}` : 'This document is not a certificate of coils, welding wire or mesh wire: nothing was read.', 'error')
      } else {
        // The certificate decides the register: its tab is the one open under the review.
        setKind(read.kind)
        setResult(read)
      }
    } catch (e) {
      if (e instanceof CertificateRejected) toast(e.message, 'error')
      else if ((e as Error).name !== 'AbortError') toast(e instanceof Error ? e.message : 'The certificate could not be read.', 'error')
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

  if (tab === 'delivery-notes') return <DeliveryNotesView leading={<TabSwitch value={tab} onChange={setKind} />} canUpload={canUpload} />

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
              accept={MTC_ACCEPT}
              multiple
              className="hidden"
              onChange={(e) => {
                const files = Array.from(e.target.files ?? [])
                e.target.value = ''
                void startReading(files)
              }}
            />
            <Button
              variant="primary"
              className="h-10 touch:h-11"
              disabled={reading !== null}
              data-tip="The certificate’s PDF, photos of its pages, or its Excel sheet"
              onClick={() => fileInput.current?.click()}
            >
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
    // The coil register has sixteen columns: each as narrow as its values allow, so more of them fit a screen.
    width: f.key === 'notes' ? 220 : f.type === 'number' ? 118 : f.type === 'date' ? 120 : f.identifies ? 170 : f.choices ? 115 : 140,
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
  onKind: (k: MtcTab) => void
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
  // A coil opens on its details: where it came from, its certificate against its grade, its slitting.
  const [openCoil, setOpenCoil] = useState<string | null>(null)
  const opens = kind === 'coils'
  const labelOf = (key: string) => columns.find((c) => c.key === key)?.label ?? key
  const columnMenu = (c: ColumnDef) => {
    const field = register.fields.find((f) => f.key === c.key)
    return columnsView.menu(c.key, c.label, (s) => loadMtcValues(kind, query, c.key, s), {
      numeric: field?.type === 'number',
      align: c.align === 'right' ? 'right' : 'left',
      formatValue: c.key === MTC_ADDED_COLUMN ? (v) => formatDate(v) : field ? (v) => fieldText(field, v) || v : undefined,
    })
  }

  /** A value as the table shows it: a type by its name, a strength green or red, the certificate's number opening it. */
  const valueOf = (field: MtcRegister['fields'][number], row: MtcRegisterRow) => {
    const v = row.values[field.key]
    if (v !== undefined && row.documentId && (field.certificate || (field.key === 'notes' && !register.fields.some((f) => f.certificate)))) {
      return (
        <MtcDocumentLink id={row.documentId} title={field.certificate ? `MTC ${v}` : String(v)}>
          {String(v)}
        </MtcDocumentLink>
      )
    }
    if (isJudged(field.key) && row.standard) return <JudgedValue field={field} value={v} standard={row.standard} />
    return fieldText(field, v) || '—'
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
    const shown = fieldText(field, row.values[c.key])
    return (
      <td
        key={c.key}
        data-tip={isJudged(field.key) && row.standard ? undefined : shown || undefined}
        className={cn(
          'truncate px-3 py-3',
          field.type === 'number' && 'text-right tabular-nums',
          field.mono && 'font-mono text-[13px]',
          field.identifies && 'font-semibold',
          field.key === 'notes' && 'text-muted',
        )}
      >
        {valueOf(field, row)}
      </td>
    )
  }

  return (
    <div className="space-y-3">
      {/* No title row: the tab names the page. The register switch, the search and the actions share one row, as History's. */}
      <FilterBar
        leading={<TabSwitch value={kind} onChange={onKind} />}
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
              <Card
                key={row.id}
                className={cn('min-w-0 p-4', opens && 'cursor-pointer')}
                {...(opens ? { role: 'button', tabIndex: 0, onClick: () => setOpenCoil(row.id), onKeyDown: (e) => e.key === 'Enter' && e.target === e.currentTarget && setOpenCoil(row.id) } : {})}
              >
                <p className={cn('truncate font-bold', mtcIdField(register).mono && 'font-mono')}>{register.fields.filter((f) => f.identifies).map((f) => row.values[f.key] ?? '—').join(' · ')}</p>
                <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1.5 text-sm">
                  {register.fields
                    .filter((f) => !f.identifies && row.values[f.key] !== undefined)
                    .map((f) => (
                      <div key={f.key} className={cn('min-w-0', f.key === 'notes' && 'col-span-2')}>
                        <dt className="text-xs font-semibold uppercase text-muted">{f.unit ? `${f.label} (${f.unit})` : f.label}</dt>
                        <dd className="truncate">{valueOf(f, row)}</dd>
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
                    <tr
                      key={row.id}
                      className={cn('data-row bg-white transition-colors hover:bg-slate-50 dark:bg-slate-900 dark:hover:bg-[#17202f]', opens && 'cursor-pointer')}
                      {...(opens
                        ? {
                            tabIndex: 0,
                            'aria-label': `Coil ${row.values.coilNumber ?? ''}: open its details and slitting`,
                            onClick: () => setOpenCoil(row.id),
                            onKeyDown: (e: React.KeyboardEvent) => e.key === 'Enter' && e.target === e.currentTarget && setOpenCoil(row.id),
                          }
                        : {})}
                    >
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
      {openCoil && <CoilDetailsDialog coilId={openCoil} onClose={() => setOpenCoil(null)} />}
    </div>
  )
}
