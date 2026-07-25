import { useMemo, useState } from 'react'
import {
  ScrollText,
  Search,
  Plus,
  Pencil,
  Trash2,
  RotateCcw,
  ShieldAlert,
  Download,
  Upload,
  Flame,
} from 'lucide-react'
import { Badge, Button, Card, EmptyState, Input, Modal, Select, Stat } from '@/components/ui'
import { useCount, useRecent } from '@/services/useCollection'
import { COL } from '@/services/repository'
import { getDb } from '@/lib/firebase'
import { writeBatch, doc, where } from 'firebase/firestore'
import { useAuth } from '@/store/AuthContext'
import { useApp } from '@/store/AppContext'
import { can } from '@/domain/rules'
import { auditEvent } from '@/domain/audit'
import { cn, downloadText, formatDateTime, uid } from '@/lib/utils'
import type { AuditAction, AuditEntry } from '@/domain/types'

const ACTION_META: Record<AuditAction, { icon: typeof Plus; tone: string; label: string }> = {
  create: { icon: Plus, tone: 'text-emerald-500 bg-emerald-100 dark:bg-emerald-500/15', label: 'Create' },
  update: { icon: Pencil, tone: 'text-brand-500 bg-brand-100 dark:bg-brand-500/15', label: 'Update' },
  delete: { icon: Trash2, tone: 'text-rose-500 bg-rose-100 dark:bg-rose-500/15', label: 'Delete' },
  restore: { icon: RotateCcw, tone: 'text-sky-500 bg-sky-100 dark:bg-sky-500/15', label: 'Restore' },
  purge: { icon: Flame, tone: 'text-orange-500 bg-orange-100 dark:bg-orange-500/15', label: 'Purge' },
  acknowledge: { icon: ShieldAlert, tone: 'text-amber-500 bg-amber-100 dark:bg-amber-500/15', label: 'Acknowledge' },
}

/** How many entries the browser holds. The log only grows, so it is a window. */
const WINDOW = 500

const RANGES = [
  { label: 'All time', days: 0 },
  { label: 'Last 7 days', days: 7 },
  { label: 'Last 30 days', days: 30 },
  { label: 'Last 90 days', days: 90 },
]

/** §11 — the audit browser. */
export function AuditPage() {
  // The newest WINDOW entries. The filters below narrow that window; they do
  // not scan the whole log, which grows with every save the factory makes.
  const { rows: entries, loading } = useRecent<AuditEntry & { id: string }>(COL.audit, 'at', WINDOW)
  const { count: totalEvents } = useCount(COL.audit, [], ['audit-total'])
  const { count: updateCount } = useCount(COL.audit, [where('action', '==', 'update')], ['audit-update'])
  const { count: deleteCount } = useCount(COL.audit, [where('action', '==', 'delete')], ['audit-delete'])
  const { count: ackCount } = useCount(COL.audit, [where('action', '==', 'acknowledge')], ['audit-ack'])
  const { profile, role } = useAuth()
  const { toast } = useApp()

  const [term, setTerm] = useState('')
  const [action, setAction] = useState<'all' | AuditAction>('all')
  const [user, setUser] = useState('all')
  const [entity, setEntity] = useState('all')
  const [days, setDays] = useState(0)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [purging, setPurging] = useState(false)

  const users = useMemo(() => Array.from(new Set(entries.map((e) => e.userName))).sort(), [entries])
  const entities = useMemo(() => Array.from(new Set(entries.map((e) => e.entity))).sort(), [entries])

  const rows = useMemo(() => {
    const t = term.trim().toLowerCase()
    const since = days > 0 ? Date.now() - days * 86400000 : 0
    return entries
      .filter((e) => action === 'all' || e.action === action)
      .filter((e) => user === 'all' || e.userName === user)
      .filter((e) => entity === 'all' || e.entity === entity)
      .filter((e) => !since || new Date(e.at).getTime() >= since)
      .filter(
        (e) =>
          !t ||
          (e.orderNumber ?? '').toLowerCase().includes(t) ||
          (e.item ?? '').toLowerCase().includes(t) ||
          (e.field ?? '').toLowerCase().includes(t) ||
          (e.oldValue ?? '').toLowerCase().includes(t) ||
          (e.newValue ?? '').toLowerCase().includes(t) ||
          e.entity.toLowerCase().includes(t) ||
          e.userName.toLowerCase().includes(t),
      )
      .sort((a, b) => (a.at < b.at ? 1 : -1))
  }, [entries, term, action, user, entity, days])

  const allSelected = rows.length > 0 && rows.every((r) => selected.has(r.id))

  function toggleAll() {
    setSelected(allSelected ? new Set() : new Set(rows.map((r) => r.id)))
  }

  function exportCsv() {
    const header = 'timestamp,user,action,entity,entityId,field,oldValue,newValue,order,item,workCenter'
    const esc = (v = '') => `"${String(v).replace(/"/g, '""')}"`
    const lines = rows.map((r) =>
      [
        r.at,
        esc(r.userName),
        r.action,
        r.entity,
        r.entityId,
        esc(r.field),
        esc(r.oldValue),
        esc(r.newValue),
        esc(r.orderNumber),
        esc(r.item),
        esc(r.workCenterCode),
      ].join(','),
    )
    downloadText('audit-logs.csv', [header, ...lines].join('\n'))
  }

  /** Purging is restricted, and is itself audited (§11). */
  async function purgeSelected() {
    if (!profile || selected.size === 0) return
    try {
      const ids = Array.from(selected)
      const at = new Date().toISOString()
      const batch = writeBatch(getDb())
      // A soft delete, not a removal. An admin quietly erasing audit entries is
      // the thing §11 exists to prevent, and the rules now deny `delete` on this
      // collection outright — only deletedAt may be set. The entries stay in the
      // database and stay recoverable; they simply leave this browser.
      for (const id of ids) {
        batch.update(doc(getDb(), COL.audit, id), {
          deletedAt: at,
          deletedByUid: profile.uid,
          deletedByName: profile.name,
        })
      }
      const record = auditEvent(
        'purge',
        {
          userUid: profile.uid,
          userName: profile.name,
          entity: 'AuditLog',
          entityId: `${ids.length} entries`,
        },
        new Date().toISOString(),
        uid('aud_purge'),
        { newValue: `Marked ${ids.length} audit entries deleted` },
      )
      batch.set(doc(getDb(), COL.audit, record.id), { ...record })
      await batch.commit()
      toast(
        `${ids.length} entries marked deleted. They remain in the database, and this was itself recorded.`,
        'success',
      )
      setSelected(new Set())
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not purge.', 'error')
    } finally {
      setPurging(false)
    }
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-extrabold tracking-tight">
            <ScrollText className="h-6 w-6 text-brand-600" /> Audit Logs
          </h1>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
            Every change to inspection data after its first save — who, when, and what changed.
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="secondary" className="min-h-[48px]" onClick={exportCsv}>
            <Download className="h-4 w-4" /> Export
          </Button>
          {can(role, 'purge-audit-logs') && (
            <Button
              variant="danger"
              className="min-h-[48px]"
              disabled={selected.size === 0}
              onClick={() => setPurging(true)}
            >
              <Flame className="h-4 w-4" /> Purge {selected.size > 0 && `(${selected.size})`}
            </Button>
          )}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Total events" value={totalEvents} icon={<ScrollText className="h-5 w-5" />} />
        <Stat label="Updates" value={updateCount} tone="blue" icon={<Pencil className="h-5 w-5" />} />
        <Stat label="Deletions" value={deleteCount} tone="red" icon={<Trash2 className="h-5 w-5" />} />
        <Stat label="Overrides" value={ackCount} tone="amber" icon={<ShieldAlert className="h-5 w-5" />} />
      </div>

      <Card className="space-y-2 p-3">
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <Input
            value={term}
            onChange={(e) => setTerm(e.target.value)}
            placeholder="Search order, item, field or value…"
            className="min-h-[48px] pl-9"
          />
        </div>
        <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
          <Select value={action} onChange={(e) => setAction(e.target.value as 'all' | AuditAction)} className="min-h-[48px]">
            <option value="all">All actions</option>
            {(Object.keys(ACTION_META) as AuditAction[]).map((a) => (
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
        {totalEvents > entries.length && (
          <p className="px-1 text-xs text-slate-400">
            Showing the {entries.length} most recent of {totalEvents} events. The filters and the
            export apply to these.
          </p>
        )}
        {can(role, 'purge-audit-logs') && rows.length > 0 && (
          <label className="flex min-h-[44px] cursor-pointer items-center gap-2 text-sm font-semibold text-slate-600 dark:text-slate-300">
            <input type="checkbox" checked={allSelected} onChange={toggleAll} className="h-5 w-5 rounded accent-brand-600" />
            Select all {rows.length} shown
          </label>
        )}
      </Card>

      {loading ? (
        <Card className="p-10 text-center text-sm text-slate-400">Loading…</Card>
      ) : rows.length === 0 ? (
        <EmptyState icon={<ScrollText className="h-10 w-10" />} title="No matching activity" hint="Adjust the filters to see more." />
      ) : (
        <Card className="divide-y divide-slate-100 dark:divide-slate-800">
          {rows.slice(0, 400).map((e) => {
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
                    {e.workCenterCode && <span>WC {e.workCenterCode}</span>}
                  </div>
                </div>
                <span className="shrink-0 whitespace-nowrap text-xs text-slate-400">{formatDateTime(e.at)}</span>
              </div>
            )
          })}
          {rows.length > 400 && (
            <p className="px-4 py-3 text-center text-xs text-slate-400">
              Showing the most recent 400 of {rows.length} entries. Narrow the filters to see older ones.
            </p>
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
          This marks {selected.size} audit {selected.size === 1 ? 'entry' : 'entries'} deleted and removes{' '}
          {selected.size === 1 ? 'it' : 'them'} from this browser. Nothing is destroyed: the{' '}
          {selected.size === 1 ? 'entry stays' : 'entries stay'} in the database and can be recovered. This
          action is itself recorded, naming you and the number affected. Inspection data is not affected.
        </p>
      </Modal>
    </div>
  )
}
