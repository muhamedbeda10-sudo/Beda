// ============================================================================
// §7.7 — the order sheet synced from the factory's Access database: how the
// last runs went, a "Sync now", the agent's keys, and the agent itself to
// download. The agent runs on a factory PC; this page only watches and asks.
// ============================================================================

import { Fragment, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, CheckCircle2, Copy, Download, KeyRound, Loader2, Plus, RefreshCw, XCircle } from 'lucide-react'
import type { CreateIntegrationKeyResponse, OrderSyncRun, OrderSyncStatus } from '@qc/shared/api'
import { Badge, Button, Card, Field, Input, Modal, type BadgeTone } from '@/components/ui'
import { useOrderSync } from '@/services/queries'
import { createIntegrationKey, requestOrderSync, revokeIntegrationKey } from '@/services/mutations'
import { useApp } from '@/store/AppContext'
import { cn, downloadText, formatDateTime, timeAgo } from '@/lib/utils'

const STATUS: Record<OrderSyncStatus, { label: string; tone: BadgeTone; icon: typeof CheckCircle2 }> = {
  running: { label: 'Running', tone: 'blue', icon: Loader2 },
  success: { label: 'Synced', tone: 'green', icon: CheckCircle2 },
  warning: { label: 'Synced, nothing retired', tone: 'amber', icon: AlertTriangle },
  failed: { label: 'Failed', tone: 'red', icon: XCircle },
}

/** The agent's files, served with the application. */
const AGENT_FILES = ['Sync-AccessOrders.ps1', 'Install-Task.ps1', 'README.txt']

function StatusBadge({ status }: { status: OrderSyncStatus }) {
  const s = STATUS[status]
  return (
    <Badge tone={s.tone} icon={<s.icon className={cn('h-3.5 w-3.5', status === 'running' && 'animate-spin')} />}>
      {s.label}
    </Badge>
  )
}

/** The config.json the agent reads, with the key filled in and the Access file left to set. */
function agentConfig(secret: string): string {
  return `${JSON.stringify(
    {
      apiUrl: window.location.origin,
      apiKey: secret,
      databasePath: '<full path of the .accdb file, e.g. \\\\SERVER\\Planning\\Orders.accdb>',
      table: 'Orders',
    },
    null,
    2,
  )}\n`
}

export function AccessSyncPanel() {
  const qc = useQueryClient()
  const { toast } = useApp()
  const { data, isLoading } = useOrderSync()
  const [asking, setAsking] = useState(false)
  const [newKeyOpen, setNewKeyOpen] = useState(false)
  const [keyName, setKeyName] = useState('')
  const [creating, setCreating] = useState(false)
  const [created, setCreated] = useState<CreateIntegrationKeyResponse | null>(null)
  const [revoking, setRevoking] = useState<{ id: string; name: string } | null>(null)
  const [openRun, setOpenRun] = useState<string | null>(null)

  const runs = data?.runs ?? []
  const last = runs.find((r) => r.status !== 'running') ?? null
  const running = runs.find((r) => r.status === 'running') ?? null
  const liveKeys = (data?.keys ?? []).filter((k) => !k.revokedAt)

  async function syncNow() {
    setAsking(true)
    try {
      await requestOrderSync(qc)
      toast('Asked for a sync. The agent picks it up within a minute.', 'success')
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not ask for a sync.', 'error')
    } finally {
      setAsking(false)
    }
  }

  async function makeKey() {
    setCreating(true)
    try {
      const res = await createIntegrationKey(qc, keyName.trim())
      setCreated(res)
      setNewKeyOpen(false)
      setKeyName('')
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not make the key.', 'error')
    } finally {
      setCreating(false)
    }
  }

  async function revoke() {
    if (!revoking) return
    try {
      await revokeIntegrationKey(qc, revoking.id)
      toast(`Key "${revoking.name}" revoked. An agent using it stops at once.`, 'success')
      setRevoking(null)
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not revoke the key.', 'error')
    }
  }

  const counts = (r: OrderSyncRun) => `${r.rowsReceived} rows · ${r.inserted} new · ${r.updated} updated · ${r.retired} retired${r.invalid ? ` · ${r.invalid} unreadable` : ''}`

  return (
    <div className="space-y-4">
      <Card className="space-y-3 p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 space-y-1">
            <h2 className="text-lg font-extrabold tracking-tight">Orders from Access</h2>
            <p className="max-w-3xl text-sm text-slate-500 dark:text-slate-400">
              An agent on a factory PC reads the Access orders table every {data?.intervalMinutes ?? 15} minutes and sends it here; the Access file is only read. A line that left the table is retired only when the whole table arrived and read cleanly, and never more than half the lines at once.
            </p>
          </div>
          <Button variant="primary" className="min-h-[44px]" onClick={() => void syncNow()} disabled={asking || !!data?.pendingRequest || liveKeys.length === 0}>
            <RefreshCw className={cn('h-4 w-4', asking && 'animate-spin')} /> Sync now
          </Button>
        </div>
        {isLoading ? (
          <div className="skeleton h-16" />
        ) : running ? (
          <p className="flex flex-wrap items-center gap-2 text-sm"><StatusBadge status="running" /> Started {timeAgo(running.startedAt)} from {running.source || 'the agent'} · {running.rowsReceived} rows so far</p>
        ) : last ? (
          <div className="space-y-1 text-sm">
            <p className="flex flex-wrap items-center gap-2">
              <StatusBadge status={last.status} /> <span className="font-semibold">{timeAgo(last.finishedAt ?? last.startedAt)}</span>
              <span className="text-slate-500">{counts(last)}</span>
            </p>
            {last.message && <p className="text-slate-500 dark:text-slate-400">{last.message}</p>}
          </div>
        ) : (
          <p className="text-sm text-slate-500">No sync yet. Make a key below, then set up the agent on the PC that can open the Access file.</p>
        )}
        {data?.pendingRequest && (
          <p className="rounded-xl bg-brand-50 px-3 py-2 text-sm text-brand-800 dark:bg-brand-500/10 dark:text-brand-100">
            Sync asked for by {data.pendingRequest.requestedByName} {timeAgo(data.pendingRequest.requestedAt)}; the agent picks it up within a minute when its PC is on.
          </p>
        )}
      </Card>

      <Card className="p-5">
        <h3 className="mb-2 font-bold">Recent runs</h3>
        {runs.length === 0 ? (
          <p className="py-4 text-sm text-slate-400">No run yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-[11px] uppercase tracking-wide text-slate-400">
                <tr>
                  <th className="px-2 py-1.5 font-semibold">Started</th>
                  <th className="px-2 py-1.5 font-semibold">Status</th>
                  <th className="px-2 py-1.5 text-right font-semibold">Rows</th>
                  <th className="px-2 py-1.5 text-right font-semibold">New</th>
                  <th className="px-2 py-1.5 text-right font-semibold">Updated</th>
                  <th className="px-2 py-1.5 text-right font-semibold">Retired</th>
                  <th className="px-2 py-1.5 text-right font-semibold">Unreadable</th>
                  <th className="px-2 py-1.5 font-semibold">From</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {runs.map((r) => {
                  const more = !!r.message || r.errors.length > 0 || r.unknownColumns.length > 0
                  const open = openRun === r.id
                  return (
                    <Fragment key={r.id}>
                      <tr className={cn(more && 'cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-800/50')} onClick={() => more && setOpenRun(open ? null : r.id)} aria-expanded={more ? open : undefined}>
                        <td className="whitespace-nowrap px-2 py-1.5">{formatDateTime(r.startedAt)}</td>
                        <td className="px-2 py-1.5"><StatusBadge status={r.status} /></td>
                        <td className="px-2 py-1.5 text-right tabular-nums">{r.rowsReceived}</td>
                        <td className="px-2 py-1.5 text-right tabular-nums">{r.inserted}</td>
                        <td className="px-2 py-1.5 text-right tabular-nums">{r.updated}</td>
                        <td className="px-2 py-1.5 text-right tabular-nums">{r.retired}</td>
                        <td className={cn('px-2 py-1.5 text-right tabular-nums', r.invalid > 0 && 'font-semibold text-amber-700 dark:text-amber-300')}>{r.invalid}</td>
                        <td className="px-2 py-1.5 text-slate-500">{r.source || r.keyName}</td>
                      </tr>
                      {open && (
                        <tr>
                          <td colSpan={8} className="space-y-2 bg-slate-50 px-3 py-2 text-xs dark:bg-slate-800/40">
                            {r.message && <p className="font-semibold">{r.message}</p>}
                            {r.unknownColumns.length > 0 && <p className="text-slate-500">Columns no field reads (ignored): {r.unknownColumns.join(', ')}</p>}
                            {r.errors.length > 0 && (
                              <ul className="space-y-0.5">
                                {r.errors.map((e, i) => (
                                  <li key={i}>
                                    Row {e.row}{e.lineKey ? ` (Order ID ${e.lineKey})` : ''}: {e.message}
                                  </li>
                                ))}
                                {r.invalid > r.errors.length && <li className="text-slate-400">…and {r.invalid - r.errors.length} more.</li>}
                              </ul>
                            )}
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card className="space-y-3 p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="font-bold">Agent keys</h3>
          <Button className="min-h-[40px]" onClick={() => setNewKeyOpen(true)}>
            <Plus className="h-4 w-4" /> New key
          </Button>
        </div>
        {(data?.keys ?? []).length === 0 ? (
          <p className="text-sm text-slate-400">No key yet. A key lets one agent send orders, and nothing else.</p>
        ) : (
          <ul className="divide-y divide-slate-100 dark:divide-slate-800">
            {(data?.keys ?? []).map((k) => (
              <li key={k.id} className={cn('flex flex-wrap items-center gap-3 py-2 text-sm', k.revokedAt && 'text-slate-400')}>
                <KeyRound className="h-4 w-4 shrink-0" />
                <span className="font-semibold">{k.name}</span>
                <code className="text-xs">{k.prefix}…</code>
                <span className="text-xs text-slate-500">made by {k.createdByName} {timeAgo(k.createdAt)} · {k.lastUsedAt ? `last used ${timeAgo(k.lastUsedAt)}` : 'never used'}</span>
                {k.revokedAt ? (
                  <Badge tone="neutral" className="ml-auto">Revoked {timeAgo(k.revokedAt)}</Badge>
                ) : (
                  <Button variant="ghost" className="ml-auto min-h-[36px] text-rose-600" onClick={() => setRevoking({ id: k.id, name: k.name })}>
                    Revoke
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
        <div className="flex flex-wrap items-center gap-2 border-t border-slate-100 pt-3 text-sm dark:border-slate-800">
          <span className="font-semibold">The agent:</span>
          {AGENT_FILES.map((f) => (
            <a key={f} href={`/agent/${f}`} download className="inline-flex items-center gap-1 rounded-lg px-2 py-1 font-semibold text-brand-700 ring-1 ring-slate-200 hover:bg-slate-50 dark:text-brand-300 dark:ring-slate-700 dark:hover:bg-slate-800">
              <Download className="h-3.5 w-3.5" /> {f}
            </a>
          ))}
          <span className="text-xs text-slate-400">README.txt has the steps, in English and Arabic.</span>
        </div>
      </Card>

      <Modal
        open={newKeyOpen}
        onClose={() => setNewKeyOpen(false)}
        title="New agent key"
        icon={<KeyRound className="h-5 w-5" />}
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => setNewKeyOpen(false)}>Cancel</Button>
            <Button variant="primary" disabled={keyName.trim() === '' || creating} onClick={() => void makeKey()}>
              {creating ? 'Making…' : 'Make the key'}
            </Button>
          </>
        }
      >
        <Field label="Name" hint="Where the agent runs, so the key can be told apart: e.g. Planning PC.">
          <Input autoFocus value={keyName} onChange={(e) => setKeyName(e.target.value.slice(0, 80))} className="min-h-[48px]" />
        </Field>
      </Modal>

      <Modal
        open={created !== null}
        onClose={() => setCreated(null)}
        title={`Key for ${created?.key.name ?? ''}`}
        icon={<KeyRound className="h-5 w-5" />}
        footer={<Button variant="primary" onClick={() => setCreated(null)}>I saved it</Button>}
      >
        {created && (
          <div className="space-y-3 text-sm">
            <p className="rounded-xl bg-amber-50 px-3 py-2 font-semibold text-amber-800 dark:bg-amber-500/10 dark:text-amber-200">
              This is the only time the key is shown. Download config.json now and put it next to the agent on the PC.
            </p>
            <code className="block break-all rounded-lg bg-slate-100 px-3 py-2 text-xs dark:bg-slate-800">{created.secret}</code>
            <div className="flex flex-wrap gap-2">
              <Button onClick={() => downloadText('config.json', agentConfig(created.secret), 'application/json')}>
                <Download className="h-4 w-4" /> Download config.json
              </Button>
              <Button
                variant="ghost"
                onClick={() => {
                  void navigator.clipboard?.writeText(created.secret).then(
                    () => toast('Key copied.', 'success'),
                    () => toast('Could not copy; select the key and copy it.', 'error'),
                  )
                }}
              >
                <Copy className="h-4 w-4" /> Copy the key
              </Button>
            </div>
            <p className="text-xs text-slate-500">In config.json set databasePath to the Access file and table to the orders table; see README.txt.</p>
          </div>
        )}
      </Modal>

      <Modal
        open={revoking !== null}
        onClose={() => setRevoking(null)}
        title="Revoke this key?"
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => setRevoking(null)}>Cancel</Button>
            <Button variant="danger" onClick={() => void revoke()}>Revoke</Button>
          </>
        }
      >
        <p className="text-sm">The agent using "{revoking?.name}" stops at once. The order lines it synced stay. A revoked key cannot be used again.</p>
      </Modal>
    </div>
  )
}
