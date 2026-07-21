import { useMemo, useState } from 'react'
import {
  ScrollText,
  Search,
  Plus,
  Pencil,
  Trash2,
  Lock,
  Unlock,
  Upload,
  LogIn,
  Download,
} from 'lucide-react'
import { useDB } from '@/store/db'
import { Badge, Card, Input, Select, Stat, EmptyState, Button } from '@/components/ui'
import { formatDateTime, cn, downloadText } from '@/lib/utils'
import type { AuditAction } from '@/types'

const ACTION_META: Record<AuditAction, { icon: React.ElementType; tone: string; label: string }> = {
  create: { icon: Plus, tone: 'text-emerald-500 bg-emerald-100 dark:bg-emerald-500/15', label: 'Create' },
  update: { icon: Pencil, tone: 'text-brand-500 bg-brand-100 dark:bg-brand-500/15', label: 'Update' },
  delete: { icon: Trash2, tone: 'text-rose-500 bg-rose-100 dark:bg-rose-500/15', label: 'Delete' },
  close: { icon: Lock, tone: 'text-slate-500 bg-slate-100 dark:bg-slate-700', label: 'Close' },
  reopen: { icon: Unlock, tone: 'text-amber-500 bg-amber-100 dark:bg-amber-500/15', label: 'Reopen' },
  import: { icon: Upload, tone: 'text-violet-500 bg-violet-100 dark:bg-violet-500/15', label: 'Import' },
  login: { icon: LogIn, tone: 'text-slate-500 bg-slate-100 dark:bg-slate-700', label: 'Login' },
}

export function AuditPage() {
  const db = useDB()
  const [q, setQ] = useState('')
  const [action, setAction] = useState<'all' | AuditAction>('all')
  const [user, setUser] = useState('all')

  const users = useMemo(() => Array.from(new Set(db.audit.map((a) => a.user))).sort(), [db.audit])

  const rows = useMemo(() => {
    const term = q.trim().toLowerCase()
    return db.audit
      .filter((a) => action === 'all' || a.action === action)
      .filter((a) => user === 'all' || a.user === user)
      .filter(
        (a) =>
          !term ||
          a.summary.toLowerCase().includes(term) ||
          a.entity.toLowerCase().includes(term) ||
          a.entityRef.toLowerCase().includes(term) ||
          a.user.toLowerCase().includes(term),
      )
      .sort((a, b) => (a.at < b.at ? 1 : -1))
  }, [db.audit, q, action, user])

  function exportCsv() {
    const header = 'timestamp,user,action,entity,reference,summary'
    const lines = rows.map((r) =>
      [r.at, r.user, r.action, r.entity, r.entityRef, `"${r.summary.replace(/"/g, '""')}"`].join(','),
    )
    downloadText('audit-logs.csv', [header, ...lines].join('\n'))
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-extrabold tracking-tight">
            <ScrollText className="h-6 w-6 text-brand-600" /> Audit Logs
          </h1>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
            Full activity trail — who did what, when, for review and compliance.
          </p>
        </div>
        <Button variant="secondary" onClick={exportCsv}>
          <Download className="h-4 w-4" /> Export CSV
        </Button>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Total events" value={db.audit.length} icon={<ScrollText className="h-5 w-5" />} />
        <Stat label="Creates" value={db.audit.filter((a) => a.action === 'create').length} tone="green" icon={<Plus className="h-5 w-5" />} />
        <Stat label="Updates" value={db.audit.filter((a) => a.action === 'update').length} tone="blue" icon={<Pencil className="h-5 w-5" />} />
        <Stat label="Closures" value={db.audit.filter((a) => a.action === 'close').length} tone="neutral" icon={<Lock className="h-5 w-5" />} />
      </div>

      {/* Filters */}
      <Card className="p-3">
        <div className="flex flex-col gap-2 sm:flex-row">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search activity…" className="pl-9" />
          </div>
          <Select value={action} onChange={(e) => setAction(e.target.value as 'all' | AuditAction)} className="sm:w-44">
            <option value="all">All actions</option>
            {(Object.keys(ACTION_META) as AuditAction[]).map((a) => (
              <option key={a} value={a}>
                {ACTION_META[a].label}
              </option>
            ))}
          </Select>
          <Select value={user} onChange={(e) => setUser(e.target.value)} className="sm:w-52">
            <option value="all">All users</option>
            {users.map((u) => (
              <option key={u} value={u}>
                {u}
              </option>
            ))}
          </Select>
        </div>
      </Card>

      {rows.length === 0 ? (
        <EmptyState icon={<ScrollText className="h-10 w-10" />} title="No matching activity" hint="Adjust the filters to see more." />
      ) : (
        <Card className="divide-y divide-slate-100 dark:divide-slate-800">
          {rows.slice(0, 300).map((a) => {
            const meta = ACTION_META[a.action]
            const Icon = meta.icon
            return (
              <div key={a.id} className="flex items-start gap-3 px-4 py-3">
                <span className={cn('grid h-9 w-9 shrink-0 place-items-center rounded-xl', meta.tone)}>
                  <Icon className="h-4 w-4" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold" dir="auto">
                    {a.summary}
                  </p>
                  <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-slate-400">
                    <span className="font-medium text-slate-500 dark:text-slate-400">{a.user}</span>
                    <span>·</span>
                    <Badge tone="neutral">{a.entity}</Badge>
                    <span className="font-mono">{a.entityRef}</span>
                  </div>
                </div>
                <span className="shrink-0 whitespace-nowrap text-xs text-slate-400">{formatDateTime(a.at)}</span>
              </div>
            )
          })}
          {rows.length > 300 && (
            <p className="px-4 py-3 text-center text-xs text-slate-400">Showing first 300 of {rows.length} events.</p>
          )}
        </Card>
      )}
    </div>
  )
}
