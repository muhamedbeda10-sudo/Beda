import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useQueryClient } from '@tanstack/react-query'
import { ScrollText, Search, Plus, Pencil, Trash2, RotateCcw, ShieldAlert, Download, Flame } from 'lucide-react'
import { Badge, Button, Card, Drawer, EmptyState, Input, Modal, Select, Stat } from '@/components/ui'
import { ScrollX } from '@/components/ui/ScrollX'
import { AdminLayout } from '@/components/admin/AdminLayout'
import { loadAuditAt, loadAuditMatches, loadAuditValues, loadOlderAudit, useAuditList, useAuditOptions, useAuditStats, useDebounced } from '@/services/queries'
import { purgeAudit } from '@/services/mutations'
import { usePersistedState } from '@/lib/usePersistedState'
import { PHONE, useMediaQuery } from '@/lib/media'
import { useAuth } from '@/store/AuthContext'
import { useApp } from '@/store/AppContext'
import { can } from '@/domain'
import { cn, downloadText, formatDate, formatFullTimestamp } from '@/lib/utils'
import { AUDIT_ACTIONS, type AuditAction, type AuditEntry } from '@qc/shared/types'
import type { AuditFilters } from '@qc/shared/api'
import { When } from '@/components/ui/Tooltip'
import { useServerColumns } from '@/components/ui/ColumnFilter'
import { FilterChips } from '@/components/ui/PageShell'

const ACTION_META: Record<AuditAction, { icon: typeof Plus; tone: string; label: string }> = {
  create: { icon: Plus, tone: 'text-emerald-500 bg-emerald-100 dark:bg-emerald-500/15', label: 'Create' },
  update: { icon: Pencil, tone: 'text-brand-500 bg-brand-100 dark:bg-brand-500/15', label: 'Update' },
  delete: { icon: Trash2, tone: 'text-rose-500 bg-rose-100 dark:bg-rose-500/15', label: 'Delete' },
  restore: { icon: RotateCcw, tone: 'text-sky-500 bg-sky-100 dark:bg-sky-500/15', label: 'Restore' },
  purge: { icon: Flame, tone: 'text-orange-500 bg-orange-100 dark:bg-orange-500/15', label: 'Purge' },
  acknowledge: { icon: ShieldAlert, tone: 'text-amber-500 bg-amber-100 dark:bg-amber-500/15', label: 'Acknowledge' },
}

/** How many entries one page holds. The log only grows; the filters below are
 *  answered over all of it, and older pages are fetched on request. A phone
 *  takes a quarter of a page at a time: 200 cards made a page 30,000 px tall. */
const PAGE = 200
const PAGE_PHONE = 50

/** The most the CSV export takes in one go. */
const EXPORT_CAP = 2000

/**
 * The log's table: the key the server filters and sorts by, the header, its
 * width, and how its values read. Every column has a width: the table is
 * laid out with table-fixed, where a column without one gets whatever the
 * others leave — on a tablet, nothing at all, and the log showed no values.
 * The table's minimum width (AUDIT_TABLE_MIN_PX) is their sum plus the
 * checkbox column, so the widths hold at every screen size and the frame
 * scrolls sideways under its sticky header.
 */
export const AUDIT_COLUMNS: { key: string; label: string; width: string; rem: number; day?: boolean }[] = [
  { key: 'at', label: 'When', width: 'w-[9.5rem]', rem: 9.5, day: true },
  { key: 'user', label: 'User', width: 'w-[9rem]', rem: 9 },
  { key: 'action', label: 'Action', width: 'w-[8.5rem]', rem: 8.5 },
  { key: 'entity', label: 'Entity', width: 'w-[10rem]', rem: 10 },
  { key: 'field', label: 'Field', width: 'w-[8rem]', rem: 8 },
  { key: 'oldValue', label: 'Old value', width: 'w-[16rem]', rem: 16 },
  { key: 'newValue', label: 'New value', width: 'w-[16rem]', rem: 16 },
  { key: 'order', label: 'Order', width: 'w-[10rem]', rem: 10 },
  { key: 'item', label: 'Item', width: 'w-[11rem]', rem: 11 },
  { key: 'machine', label: 'Machine', width: 'w-[6.5rem]', rem: 6.5 },
]
/** The checkbox column's width, in px, when the log may be purged. */
export const AUDIT_CHECK_PX = 48
/** The table's minimum width: the columns' sum (104.5 rem at 16 px) plus the checkbox column. */
export const AUDIT_TABLE_MIN_PX = 1720

const RANGES = [
  { label: 'All time', days: 0 },
  { label: 'Last 7 days', days: 7 },
  { label: 'Last 30 days', days: 30 },
  { label: 'Last 90 days', days: 90 },
]

/** §11 — the audit browser. */
export function AuditPage() {
  const queryClient = useQueryClient()
  const { data: stats } = useAuditStats()
  const totalEvents = stats?.total ?? 0
  const { role } = useAuth()
  const { toast } = useApp()

  // Kept on this device, so a tab away and back finds the filters as left.
  const [term, setTerm] = usePersistedState('qc-audit:term', '')
  const [action, setAction] = usePersistedState<'all' | AuditAction>('qc-audit:action', 'all')
  const [user, setUser] = usePersistedState('qc-audit:user', 'all')
  const [entity, setEntity] = usePersistedState('qc-audit:entity', 'all')
  const [days, setDays] = usePersistedState('qc-audit:days', 0)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [purging, setPurging] = useState(false)
  /** The entry opened in full: every field, the values wrapped, the time to the second. */
  const [detail, setDetail] = useState<AuditEntry | null>(null)
  const phone = useMediaQuery(PHONE)
  const pageSize = phone ? PAGE_PHONE : PAGE

  // Every filter goes to the API, which applies it over the whole log — an
  // entry from last season is found as readily as one from this morning.
  const settledTerm = useDebounced(term.trim(), 300)
  const columnsView = useServerColumns()
  const filters = useMemo<AuditFilters>(() => {
    const f: AuditFilters = {}
    if (columnsView.cf) f.cf = columnsView.cf
    if (columnsView.sortParam) f.sort = columnsView.sortParam
    if (settledTerm) f.q = settledTerm
    if (action !== 'all') f.action = action
    if (user !== 'all') f.userName = user
    if (entity !== 'all') f.entity = entity
    if (days > 0) f.since = new Date(Date.now() - days * 86400000).toISOString()
    return f
  }, [settledTerm, action, user, entity, days, columnsView.cf, columnsView.sortParam])

  const { data, isLoading, isFetching } = useAuditList(filters, pageSize)
  const { data: options } = useAuditOptions()
  const users = options?.users ?? []
  const entities = options?.entities ?? []

  /** Pages walked back from the first, so an older entry is never out of reach. */
  const [older, setOlder] = useState<AuditEntry[]>([])
  const [olderHasMore, setOlderHasMore] = useState(false)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const [exporting, setExporting] = useState(false)

  const rows = useMemo(() => {
    const first = data?.entries ?? []
    const seen = new Set(first.map((e) => e.id))
    return [...first, ...older.filter((e) => !seen.has(e.id))]
  }, [data, older])
  /** How many match in the whole log — not how many have been fetched. */
  const matched = data?.total ?? rows.length
  const hasMore = older.length > 0 ? olderHasMore : (data?.hasMore ?? false)

  // Different filters are a different list: start again from its first page.
  useEffect(() => {
    setOlder([])
    setOlderHasMore(false)
  }, [filters])

  async function showOlder() {
    const last = rows[rows.length - 1]
    if (!last || loadingOlder) return
    setLoadingOlder(true)
    try {
      // Sorted by a column, the next page is the next position; otherwise the entries older than the last one.
      const page = filters.sort ? await loadAuditAt(filters, rows.length, pageSize) : await loadOlderAudit(filters, last.at, last.id, pageSize)
      setOlder((prev) => [...prev, ...page.entries])
      setOlderHasMore(page.hasMore)
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not load older entries.', 'error')
    } finally {
      setLoadingOlder(false)
    }
  }

  const allSelected = rows.length > 0 && rows.every((r) => selected.has(r.id))
  const canPurge = can(role, 'purge-audit-logs')
  const toggleOne = (id: string) =>
    setSelected((s) => {
      const n = new Set(s)
      if (n.has(id)) n.delete(id)
      else n.add(id)
      return n
    })
  const columnChips = columnsView.chips((key) => AUDIT_COLUMNS.find((c) => c.key === key)?.label ?? key)

  function toggleAll() {
    setSelected(allSelected ? new Set() : new Set(rows.map((r) => r.id)))
  }

  /** The export is of the match, not of the page on screen: it asks the API
   *  for every entry the filters find, up to a stated cap. */
  async function exportCsv() {
    if (exporting) return
    setExporting(true)
    try {
      const all = await loadAuditMatches(filters, EXPORT_CAP)
      const header = 'timestamp,user,action,entity,entityId,field,oldValue,newValue,order,item,workCenter'
      const esc = (v = '') => `"${String(v).replace(/"/g, '""')}"`
      const lines = all.entries.map((r) =>
        [r.at, esc(r.userName), r.action, r.entity, r.entityId, esc(r.field), esc(r.oldValue), esc(r.newValue), esc(r.orderNumber), esc(r.item), esc(r.workCenterCode)].join(','),
      )
      downloadText('audit-logs.csv', [header, ...lines].join('\n'))
      if (all.hasMore) toast(`More than ${EXPORT_CAP} entries match. The export holds the newest ${EXPORT_CAP} — narrow the filters for the rest.`, 'info')
      else toast(`Exported ${all.entries.length} entries.`, 'success')
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not build the export.', 'error')
    } finally {
      setExporting(false)
    }
  }

  /** Purging is restricted, and is itself audited (§11). A soft delete, not a
   *  removal: the entries stay in the database and stay recoverable. */
  async function purgeSelected() {
    if (selected.size === 0) return
    try {
      const marked = await purgeAudit(queryClient, { ids: Array.from(selected) })
      toast(`${marked} entries marked deleted. They remain in the database, and this was itself recorded.`, 'success')
      setSelected(new Set())
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not purge.', 'error')
    } finally {
      setPurging(false)
    }
  }

  return (
    <AdminLayout
      title="Audit log"
      needs="edit-closed-session"
      actions={
        <>
          <Button variant="secondary" className="min-h-[48px]" onClick={() => void exportCsv()} disabled={exporting}>
            <Download className="h-4 w-4" /> {exporting ? 'Building…' : 'Export'}
          </Button>
          {can(role, 'purge-audit-logs') && (
            <Button variant="danger" className="min-h-[48px]" disabled={selected.size === 0} onClick={() => setPurging(true)}>
              <Flame className="h-4 w-4" /> Purge {selected.size > 0 && `(${selected.size})`}
            </Button>
          )}
        </>
      }
    >
    <div className={cn('space-y-5', canPurge && selected.size > 0 && 'max-md:pb-16')}>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Total events" value={totalEvents} icon={<ScrollText className="h-5 w-5" />} />
        <Stat label="Updates" value={stats?.byAction.update ?? 0} tone="blue" icon={<Pencil className="h-5 w-5" />} />
        <Stat label="Deletions" value={stats?.byAction.delete ?? 0} tone="red" icon={<Trash2 className="h-5 w-5" />} />
        <Stat label="Overrides" value={stats?.byAction.acknowledge ?? 0} tone="amber" icon={<ShieldAlert className="h-5 w-5" />} />
      </div>

      <Card className="space-y-2 p-3">
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
          <Input value={term} onChange={(e) => setTerm(e.target.value)} placeholder="Search order, item, field or value…" className="min-h-[48px] pl-9" />
        </div>
        <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
          <Select value={action} onChange={(e) => setAction(e.target.value as 'all' | AuditAction)} className="min-h-[48px]">
            <option value="all">All actions</option>
            {AUDIT_ACTIONS.map((a) => (
              <option key={a} value={a}>
                {ACTION_META[a].label}
              </option>
            ))}
          </Select>
          <Select value={user} onChange={(e) => setUser(e.target.value)} className="min-h-[48px]">
            <option value="all">All users</option>
            {users.map((u) => (
              <option key={u} value={u}>
                {u}
              </option>
            ))}
          </Select>
          <Select value={entity} onChange={(e) => setEntity(e.target.value)} className="min-h-[48px]">
            <option value="all">All entities</option>
            {entities.map((x) => (
              <option key={x} value={x}>
                {x}
              </option>
            ))}
          </Select>
          <Select value={days} onChange={(e) => setDays(Number(e.target.value))} className="min-h-[48px]">
            {RANGES.map((r) => (
              <option key={r.days} value={r.days}>
                {r.label}
              </option>
            ))}
          </Select>
        </div>
        <p className="px-1 text-xs text-muted">
          {matched === totalEvents
            ? `All ${totalEvents} events. ${rows.length} on screen.`
            : `${matched} of ${totalEvents} events match. ${rows.length} on screen.`}
          {isFetching && !isLoading && ' Searching the whole log…'}
        </p>
        <FilterChips chips={columnChips} onReset={columnsView.clear} />
        {canPurge && rows.length > 0 && (
          <label className="flex min-h-[44px] cursor-pointer items-center gap-2 text-sm font-semibold text-slate-600 md:hidden dark:text-slate-300">
            <input type="checkbox" checked={allSelected} onChange={toggleAll} className="h-5 w-5 rounded accent-brand-600" />
            Select all {rows.length} shown
          </label>
        )}
      </Card>

      {isLoading ? (
        <Card className="p-10 text-center text-sm text-muted">Loading…</Card>
      ) : rows.length === 0 ? (
        <EmptyState icon={<ScrollText className="h-10 w-10" />} title="No matching activity" hint="Nothing in the whole log matches these filters." />
      ) : (
        <>
          {/* Phone: one card per entry; a tap on it opens the entry in full. */}
          <Card className="divide-y divide-slate-100 md:hidden dark:divide-slate-800">
            {rows.map((e) => {
              const meta = ACTION_META[e.action] ?? ACTION_META.update
              const Icon = meta.icon
              return (
                <div key={e.id} className={cn('flex items-start gap-1 py-2 pl-2 pr-4', selected.has(e.id) && 'bg-brand-50/60 dark:bg-brand-500/10')}>
                  {canPurge && (
                    <label className="grid h-11 w-11 shrink-0 cursor-pointer place-items-center">
                      <input type="checkbox" checked={selected.has(e.id)} onChange={() => toggleOne(e.id)} className="h-5 w-5 rounded accent-brand-600" aria-label="Select entry" />
                    </label>
                  )}
                  <button type="button" onClick={() => setDetail(e)} className="flex min-h-[44px] min-w-0 flex-1 items-start gap-3 py-1 text-left">
                    <span className={cn('grid h-9 w-9 shrink-0 place-items-center rounded-xl', meta.tone)}>
                      <Icon className="h-4 w-4" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-semibold">
                        {meta.label} · <span className="text-muted">{e.entity}</span>
                        {e.field && <span className="text-brand-600 dark:text-brand-400"> · {e.field}</span>}
                      </span>
                      {(e.oldValue || e.newValue) && (
                        <span dir="auto" className="mt-0.5 block break-words text-sm">
                          <span className="text-rose-600 line-through dark:text-rose-400">{e.oldValue || '(empty)'}</span>
                          {' → '}
                          <span className="font-semibold text-emerald-600 dark:text-emerald-400">{e.newValue || '(empty)'}</span>
                        </span>
                      )}
                      <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
                        <span className="font-medium text-muted">{e.userName}</span>
                        {e.orderNumber && <Badge tone="neutral">{e.orderNumber}</Badge>}
                        {e.item && <span>{e.item}</span>}
                        {e.workCenterCode && <span>Machine {e.workCenterCode}</span>}
                      </span>
                    </span>
                    <span className="shrink-0 whitespace-nowrap text-xs text-muted">
                      <When iso={e.at} time />
                    </span>
                  </button>
                </div>
              )
            })}
          </Card>

          {/* md+: the log as a table, one line per entry, each header with Excel's sort and filter over the whole log. The
              frame scrolls both ways under a header that stays put; a tap on a row opens the entry in full. */}
          <Card className="hidden md:block">
            <ScrollX className="rounded-2xl" innerClassName="max-h-[70vh] overflow-y-auto rounded-2xl" label="Audit log">
              <table className="w-full table-fixed text-sm" style={{ minWidth: AUDIT_TABLE_MIN_PX }}>
                <colgroup>
                  {canPurge && <col style={{ width: AUDIT_CHECK_PX }} />}
                  {AUDIT_COLUMNS.map((c) => (
                    <col key={c.key} className={c.width} />
                  ))}
                </colgroup>
                <thead>
                  <tr className="text-left text-[11px] uppercase tracking-wide text-muted">
                    {canPurge && (
                      <th className="sticky top-0 z-[2] bg-slate-50 px-1 py-1 dark:bg-slate-800">
                        <label className="grid h-11 w-11 cursor-pointer place-items-center">
                          <input type="checkbox" checked={allSelected} onChange={toggleAll} className="h-4 w-4 rounded accent-brand-600" aria-label={`Select all ${rows.length} shown`} />
                        </label>
                      </th>
                    )}
                    {AUDIT_COLUMNS.map((c) => (
                      <th key={c.key} className="sticky top-0 z-[2] bg-slate-50 px-3 py-2 font-semibold dark:bg-slate-800">
                        <span className="inline-flex max-w-full items-center gap-1">
                          <span className="truncate">{c.label}</span>
                          {columnsView.menu(c.key, c.label, (search) => loadAuditValues(filters, c.key, search), {
                            numeric: c.day,
                            formatValue: c.day ? (v) => formatDate(v) : c.key === 'action' ? (v) => ACTION_META[v as AuditAction]?.label ?? v : undefined,
                          })}
                        </span>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                  {rows.map((e) => {
                    const meta = ACTION_META[e.action] ?? ACTION_META.update
                    const Icon = meta.icon
                    const cell = 'truncate px-3'
                    return (
                      <tr
                        key={e.id}
                        onClick={(ev) => {
                          if (!(ev.target as HTMLElement).closest('button, input, label')) setDetail(e)
                        }}
                        className={cn('data-row cursor-pointer hover:bg-slate-50/70 dark:hover:bg-slate-800/40', selected.has(e.id) && 'bg-brand-50/60 dark:bg-brand-500/10')}
                      >
                        {canPurge && (
                          <td className="px-1 !py-0">
                            <label className="grid h-11 w-11 cursor-pointer place-items-center">
                              <input type="checkbox" checked={selected.has(e.id)} onChange={() => toggleOne(e.id)} className="h-4 w-4 rounded accent-brand-600" aria-label="Select entry" />
                            </label>
                          </td>
                        )}
                        <td className="whitespace-nowrap px-3 tabular-nums text-muted">
                          <When iso={e.at} time />
                        </td>
                        <td className={cn(cell, 'font-medium')} data-tip={e.userName} dir="auto">
                          {e.userName}
                        </td>
                        <td className="px-3">
                          <span className="inline-flex items-center gap-1.5">
                            <span className={cn('grid h-6 w-6 shrink-0 place-items-center rounded-lg', meta.tone)}>
                              <Icon className="h-3.5 w-3.5" />
                            </span>
                            {meta.label}
                          </span>
                        </td>
                        <td className={cn(cell, 'text-muted')} data-tip={e.entityId ? `${e.entity} · ${e.entityId}` : e.entity}>
                          {e.entity}
                        </td>
                        <td className={cn(cell, 'text-brand-600 dark:text-brand-400')} data-tip={e.field || undefined}>
                          {e.field ?? ''}
                        </td>
                        <td className={cn(cell, 'text-rose-600 dark:text-rose-400')} data-tip={e.oldValue || undefined} dir="auto">
                          {e.oldValue ?? ''}
                        </td>
                        <td className={cn(cell, 'font-semibold text-emerald-600 dark:text-emerald-400')} data-tip={e.newValue || undefined} dir="auto">
                          {e.newValue ?? ''}
                        </td>
                        <td className={cell} data-tip={e.orderNumber || undefined}>
                          {e.orderNumber ?? ''}
                        </td>
                        <td className={cn(cell, 'text-muted')} data-tip={e.item || undefined} dir="auto">
                          {e.item ?? ''}
                        </td>
                        <td className={cn(cell, 'text-muted')}>{e.workCenterCode ?? ''}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </ScrollX>
          </Card>

          {hasMore && (
            <div className="flex justify-center">
              <Button className="min-h-[48px]" onClick={() => void showOlder()} disabled={loadingOlder}>
                {loadingOlder ? 'Loading…' : filters.sort ? 'Show more entries' : 'Show older entries'}
              </Button>
            </div>
          )}
        </>
      )}

      {/* Below md the Purge button is at the top of a long list: while entries are ticked, it is at the foot of the screen too. */}
      {canPurge &&
        selected.size > 0 &&
        createPortal(
          <div
            role="toolbar"
            aria-label="Selected entries"
            className="fixed inset-x-0 bottom-0 z-40 flex items-center gap-2 border-t border-slate-200 bg-white/95 px-4 py-2 backdrop-blur safe-bottom md:hidden dark:border-slate-800 dark:bg-slate-900/95"
          >
            <span className="min-w-0 flex-1 truncate text-sm font-semibold">{selected.size} selected</span>
            <Button className="min-h-[44px]" onClick={() => setSelected(new Set())}>
              Clear
            </Button>
            <Button variant="danger" className="min-h-[44px]" onClick={() => setPurging(true)}>
              <Flame className="h-4 w-4" /> Purge
            </Button>
          </div>,
          document.body,
        )}

      <AuditEntryDrawer entry={detail} onClose={() => setDetail(null)} />

      <Modal
        open={purging}
        onClose={() => setPurging(false)}
        title="Mark audit entries deleted?"
        icon={<Flame className="h-5 w-5" />}
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => setPurging(false)}>
              Cancel
            </Button>
            <Button variant="danger" onClick={purgeSelected}>
              <Flame className="h-4 w-4" /> Purge {selected.size}
            </Button>
          </>
        }
      >
        <p className="text-sm text-slate-600 dark:text-slate-300">
          This marks {selected.size} audit {selected.size === 1 ? 'entry' : 'entries'} deleted and removes {selected.size === 1 ? 'it' : 'them'} from
          this browser. Nothing is destroyed: the {selected.size === 1 ? 'entry stays' : 'entries stay'} in the database and can be recovered. This
          action is itself recorded, naming you and the number affected. Inspection data is not affected.
        </p>
      </Modal>
    </div>
    </AdminLayout>
  )
}

/**
 * One entry in full, for a touch screen where the table's cells cut a long
 * value short and no tooltip helps: every field, the old and new values
 * wrapped in their own direction, the entity's id, and the time to the second.
 */
function AuditEntryDrawer({ entry, onClose }: { entry: AuditEntry | null; onClose: () => void }) {
  if (!entry) return null
  const meta = ACTION_META[entry.action] ?? ACTION_META.update
  const Icon = meta.icon
  const row = (label: string, value: ReactNode, className?: string) =>
    value === undefined || value === null || value === '' ? null : (
      <div key={label} className="grid grid-cols-[7rem_1fr] gap-3 py-2">
        <dt className="text-xs font-semibold uppercase tracking-wide text-muted">{label}</dt>
        <dd dir="auto" className={cn('min-w-0 break-words text-start text-sm', className)}>
          {value}
        </dd>
      </div>
    )
  return (
    <Drawer open onClose={onClose} title={`${meta.label} · ${entry.entity}`} subtitle={formatFullTimestamp(entry.at)} icon={<Icon className="h-5 w-5" />}>
      <dl className="divide-y divide-slate-100 dark:divide-slate-800">
        {row('When', formatFullTimestamp(entry.at), 'tabular-nums')}
        {row('User', entry.userName, 'font-medium')}
        {row('Action', meta.label)}
        {row('Entity', entry.entity)}
        {row('Entity id', entry.entityId, 'break-all font-mono text-xs')}
        {row('Field', entry.field, 'text-brand-600 dark:text-brand-400')}
        {row('Old value', entry.oldValue, 'whitespace-pre-wrap text-rose-600 dark:text-rose-400')}
        {row('New value', entry.newValue, 'whitespace-pre-wrap font-semibold text-emerald-600 dark:text-emerald-400')}
        {row('Order', entry.orderNumber)}
        {row('Item', entry.item)}
        {row('Machine', entry.workCenterCode)}
        {row('Session', entry.sessionId, 'break-all font-mono text-xs')}
        {row('Sample', entry.sampleId, 'break-all font-mono text-xs')}
      </dl>
    </Drawer>
  )
}
