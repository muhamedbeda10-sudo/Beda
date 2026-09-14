import { useEffect, useMemo, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { ScrollText, Search, Plus, Pencil, Trash2, RotateCcw, ShieldAlert, Download, Flame } from 'lucide-react'
import { Badge, Button, Card, EmptyState, Input, Modal, Select, Stat } from '@/components/ui'
import { AdminLayout } from '@/components/admin/AdminLayout'
import { loadAuditMatches, loadOlderAudit, useAuditList, useAuditOptions, useAuditStats, useDebounced } from '@/services/queries'
import { purgeAudit } from '@/services/mutations'
import { useAuth } from '@/store/AuthContext'
import { useApp } from '@/store/AppContext'
import { can } from '@/domain'
import { cn, downloadText, formatDateTime } from '@/lib/utils'
import { AUDIT_ACTIONS, type AuditAction, type AuditEntry } from '@qc/shared/types'
import type { AuditFilters } from '@qc/shared/api'

const ACTION_META: Record<AuditAction, { icon: typeof Plus; tone: string; label: string }> = {
  create: { icon: Plus, tone: 'text-emerald-500 bg-emerald-100 dark:bg-emerald-500/15', label: 'Create' },
  update: { icon: Pencil, tone: 'text-brand-500 bg-brand-100 dark:bg-brand-500/15', label: 'Update' },
  delete: { icon: Trash2, tone: 'text-rose-500 bg-rose-100 dark:bg-rose-500/15', label: 'Delete' },
  restore: { icon: RotateCcw, tone: 'text-sky-500 bg-sky-100 dark:bg-sky-500/15', label: 'Restore' },
  purge: { icon: Flame, tone: 'text-orange-500 bg-orange-100 dark:bg-orange-500/15', label: 'Purge' },
  acknowledge: { icon: ShieldAlert, tone: 'text-amber-500 bg-amber-100 dark:bg-amber-500/15', label: 'Acknowledge' },
}

/** How many entries one page holds. The log only grows; the filters below are
 *  answered over all of it, and older pages are fetched on request. */
const PAGE = 200

/** The most the CSV export takes in one go. */
const EXPORT_CAP = 2000

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

  const [term, setTerm] = useState('')
  const [action, setAction] = useState<'all' | AuditAction>('all')
  const [user, setUser] = useState('all')
  const [entity, setEntity] = useState('all')
  const [days, setDays] = useState(0)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [purging, setPurging] = useState(false)

  // Every filter goes to the API, which applies it over the whole log — an
  // entry from last season is found as readily as one from this morning.
  const settledTerm = useDebounced(term.trim(), 300)
  const filters = useMemo<AuditFilters>(() => {
    const f: AuditFilters = {}
    if (settledTerm) f.q = settledTerm
    if (action !== 'all') f.action = action
    if (user !== 'all') f.userName = user
    if (entity !== 'all') f.entity = entity
    if (days > 0) f.since = new Date(Date.now() - days * 86400000).toISOString()
    return f
  }, [settledTerm, action, user, entity, days])

  const { data, isLoading, isFetching } = useAuditList(filters, PAGE)
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
      const page = await loadOlderAudit(filters, last.at, last.id)
      setOlder((prev) => [...prev, ...page.entries])
      setOlderHasMore(page.hasMore)
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not load older entries.', 'error')
    } finally {
      setLoadingOlder(false)
    }
  }

  const allSelected = rows.length > 0 && rows.every((r) => selected.has(r.id))

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
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Total events" value={totalEvents} icon={<ScrollText className="h-5 w-5" />} />
        <Stat label="Updates" value={stats?.byAction.update ?? 0} tone="blue" icon={<Pencil className="h-5 w-5" />} />
        <Stat label="Deletions" value={stats?.byAction.delete ?? 0} tone="red" icon={<Trash2 className="h-5 w-5" />} />
        <Stat label="Overrides" value={stats?.byAction.acknowledge ?? 0} tone="amber" icon={<ShieldAlert className="h-5 w-5" />} />
      </div>

      <Card className="space-y-2 p-3">
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
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
        <p className="px-1 text-xs text-slate-400">
          {matched === totalEvents
            ? `All ${totalEvents} events. ${rows.length} on screen.`
            : `${matched} of ${totalEvents} events match. ${rows.length} on screen.`}
          {isFetching && !isLoading && ' Searching the whole log…'}
        </p>
        {can(role, 'purge-audit-logs') && rows.length > 0 && (
          <label className="flex min-h-[44px] cursor-pointer items-center gap-2 text-sm font-semibold text-slate-600 dark:text-slate-300">
            <input type="checkbox" checked={allSelected} onChange={toggleAll} className="h-5 w-5 rounded accent-brand-600" />
            Select all {rows.length} shown
          </label>
        )}
      </Card>

      {isLoading ? (
        <Card className="p-10 text-center text-sm text-slate-400">Loading…</Card>
      ) : rows.length === 0 ? (
        <EmptyState icon={<ScrollText className="h-10 w-10" />} title="No matching activity" hint="Nothing in the whole log matches these filters." />
      ) : (
        <Card className="divide-y divide-slate-100 dark:divide-slate-800">
          {rows.map((e) => {
            const meta = ACTION_META[e.action] ?? ACTION_META.update
            const Icon = meta.icon
            return (
              <div key={e.id} className="flex items-start gap-3 px-4 py-3">
                {can(role, 'purge-audit-logs') && (
                  <input
                    type="checkbox"
                    checked={selected.has(e.id)}
                    onChange={() =>
                      setSelected((s) => {
                        const n = new Set(s)
                        n.has(e.id) ? n.delete(e.id) : n.add(e.id)
                        return n
                      })
                    }
                    className="mt-2 h-5 w-5 shrink-0 rounded accent-brand-600"
                    aria-label="Select entry"
                  />
                )}
                <span className={cn('grid h-9 w-9 shrink-0 place-items-center rounded-xl', meta.tone)}>
                  <Icon className="h-4 w-4" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold">
                    {meta.label} · <span className="text-slate-500 dark:text-slate-400">{e.entity}</span>
                    {e.field && <span className="text-brand-600 dark:text-brand-400"> · {e.field}</span>}
                  </p>
                  {(e.oldValue || e.newValue) && (
                    <p dir="auto" className="mt-0.5 break-words text-sm">
                      <span className="text-rose-600 line-through dark:text-rose-400">{e.oldValue || '(empty)'}</span>
                      {' → '}
                      <span className="font-semibold text-emerald-600 dark:text-emerald-400">{e.newValue || '(empty)'}</span>
                    </p>
                  )}
                  <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-400">
                    <span className="font-medium text-slate-500 dark:text-slate-400">{e.userName}</span>
                    {e.orderNumber && <Badge tone="neutral">{e.orderNumber}</Badge>}
                    {e.item && <span>{e.item}</span>}
                    {e.workCenterCode && <span>Machine {e.workCenterCode}</span>}
                  </div>
                </div>
                <span className="shrink-0 whitespace-nowrap text-xs text-slate-400">{formatDateTime(e.at)}</span>
              </div>
            )
          })}
          {hasMore && (
            <div className="flex justify-center px-4 py-3">
              <Button className="min-h-[48px]" onClick={() => void showOlder()} disabled={loadingOlder}>
                {loadingOlder ? 'Loading…' : 'Show older entries'}
              </Button>
            </div>
          )}
        </Card>
      )}

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
