// ============================================================================
// The Share panel of one of the person's own reports (AiReportView): whom it
// is shared with — people, and everyone holding a role, now and later — with
// a person or a role added or taken off at once, and who of them ran it and
// when. Whoever it is shared with finds it on their Reports page, the
// assistant or not, and runs it over the data its owner may read; never its
// SQL. Each change is audited, and the bell tells whoever it newly reaches.
// The same change the assistant makes when asked (share_report).
// ============================================================================

import { useMemo, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Loader2, Share2, X } from 'lucide-react'
import { REPORT_SHARE_MAX_TARGETS, shareKey, type ReportShareRunner, type ReportShareTarget, type ReportShareView } from '@qc/shared/reportShares'
import type { Role } from '@qc/shared/types'
import { Select } from '@/components/ui'
import { cn, formatFullTimestamp } from '@/lib/utils'
import { useApp } from '@/store/AppContext'
import { ROLE_RECIPIENT_LABEL, roleName } from '@/components/automations/wording'
import { changeReportShares, useReportShares } from '@/services/reportShares'
import { groupByRole } from './access'
import { Notice } from './AiNotice'

/** "2 runs, 1 export" — what a recipient did with the report. */
export function runnerLine(r: Pick<ReportShareRunner, 'runs' | 'exports'>): string {
  const runs = `${r.runs.toLocaleString('en-US')} ${r.runs === 1 ? 'run' : 'runs'}`
  return r.exports > 0 ? `${runs}, ${r.exports.toLocaleString('en-US')} ${r.exports === 1 ? 'export' : 'exports'} to Excel` : runs
}

/** The people and roles not yet in the list, to add: people grouped by role, by name. */
export function shareChoices<P extends { id: string; name: string; role: string }>(people: readonly P[], roles: readonly Role[], shares: readonly ReportShareView[]) {
  const taken = new Set(shares.map(shareKey))
  return {
    groups: groupByRole(people.filter((p) => !taken.has(shareKey({ kind: 'user', userId: p.id })))),
    roles: roles.filter((r) => !taken.has(shareKey({ kind: 'role', role: r }))),
  }
}

export function ReportSharePanel({ reportId }: { reportId: string }) {
  const qc = useQueryClient()
  const { toast } = useApp()
  const data = useReportShares(reportId, true)
  const [busy, setBusy] = useState(false)
  const shares = useMemo(() => data.data?.shares ?? [], [data.data])
  const { groups, roles } = useMemo(() => shareChoices(data.data?.people ?? [], data.data?.roles ?? [], shares), [data.data, shares])
  const full = shares.length >= REPORT_SHARE_MAX_TARGETS

  const change = async (body: { add?: ReportShareTarget[]; remove?: ReportShareTarget[] }, done: string) => {
    setBusy(true)
    try {
      await changeReportShares(qc, reportId, body)
      toast(done, 'success')
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not change whom the report is shared with.', 'error')
    } finally {
      setBusy(false)
    }
  }
  const target = (s: ReportShareView): ReportShareTarget => (s.kind === 'user' ? { kind: 'user', userId: s.userId } : { kind: 'role', role: s.role })

  return (
    <section aria-label="Share" className="space-y-2.5 rounded-xl bg-slate-50 px-3 py-2.5 ring-1 ring-slate-200/70 dark:bg-slate-800/50 dark:ring-slate-800">
      <div className="flex items-start gap-2">
        <Share2 className="mt-0.5 h-4 w-4 shrink-0 text-brand-600 dark:text-brand-300" aria-hidden />
        <p className="text-xs leading-snug text-slate-600 dark:text-slate-300">
          Whoever you share it with finds it on their <span className="font-semibold">Reports</span> page — with or without the assistant — fills in what it asks for and runs it over the data <span className="font-semibold">you</span> may read. They never see its queries and cannot change it; the bell tells them it is there.
        </p>
      </div>

      {data.isError ? (
        <Notice tone="red">{data.error instanceof Error ? data.error.message : 'Could not read whom it is shared with.'}</Notice>
      ) : !data.data ? (
        <p className="flex items-center gap-2 text-xs text-muted">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading…
        </p>
      ) : (
        <>
          {shares.length === 0 ? (
            <p className="rounded-lg border border-dashed border-slate-300 px-3 py-2.5 text-center text-xs text-muted dark:border-slate-700">Shared with nobody yet.</p>
          ) : (
            <ul className="flex flex-wrap gap-1.5" aria-label="Shared with">
              {shares.map((s) => (
                <li
                  key={shareKey(s)}
                  className={cn(
                    'inline-flex max-w-full items-center gap-1 rounded-lg py-1 pe-1 ps-2 text-xs font-semibold ring-1 ring-inset',
                    s.inactive ? 'bg-rose-50 text-rose-700 ring-rose-200 dark:bg-rose-500/10 dark:text-rose-300 dark:ring-rose-500/25' : 'bg-white text-slate-700 ring-slate-200 dark:bg-slate-900 dark:text-slate-200 dark:ring-slate-700',
                  )}
                  data-tip={s.inactive ? 'No longer an active account: it reaches nobody' : `Shared ${formatFullTimestamp(s.sharedAt)}${s.sharedByName ? ` by ${s.sharedByName}` : ''}`}
                >
                  <span dir="auto" className={cn('truncate', s.inactive && 'line-through decoration-rose-400')}>
                    {s.label}
                  </span>
                  {/* 28 px under a mouse; with a finger 36 px drawn and a 44 px target around it. */}
                  <button
                    type="button"
                    onClick={() => void change({ remove: [target(s)] }, `No longer shared with ${s.label}.`)}
                    disabled={busy}
                    aria-label={`Stop sharing with ${s.label}`}
                    className="relative grid h-7 w-7 shrink-0 place-items-center rounded-md hover:bg-black/5 disabled:opacity-50 dark:hover:bg-white/10 touch:h-9 touch:w-9 touch:before:absolute touch:before:-inset-1"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </li>
              ))}
            </ul>
          )}

          <div className="grid gap-2 sm:grid-cols-2">
            <Select
              aria-label="Share with a person"
              value=""
              disabled={busy || full}
              onChange={(e) => {
                const id = e.target.value
                const person = data.data?.people.find((p) => p.id === id)
                if (person) void change({ add: [{ kind: 'user', userId: id }] }, `Shared with ${person.name}.`)
              }}
              className="min-h-[44px]"
            >
              <option value="">Share with a person…</option>
              {groups.map(([role, list]) => (
                <optgroup key={role} label={roleName(role)}>
                  {list.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name} ({p.username})
                    </option>
                  ))}
                </optgroup>
              ))}
            </Select>
            <Select
              aria-label="Share with everyone who holds a role"
              value=""
              disabled={busy || full || roles.length === 0}
              onChange={(e) => {
                const role = e.target.value as Role
                if (role) void change({ add: [{ kind: 'role', role }] }, `Shared with ${ROLE_RECIPIENT_LABEL[role].toLowerCase()}.`)
              }}
              className="min-h-[44px]"
            >
              <option value="">Share with a role…</option>
              {roles.map((r) => (
                <option key={r} value={r}>
                  {ROLE_RECIPIENT_LABEL[r]}
                </option>
              ))}
            </Select>
          </div>

          {data.data.runners.length > 0 && (
            <div className="space-y-1">
              <p className="text-[11px] font-bold uppercase tracking-wide text-muted">Who ran it</p>
              <ul className="divide-y divide-slate-200/70 rounded-lg bg-white ring-1 ring-slate-200/70 dark:divide-slate-800 dark:bg-slate-900 dark:ring-slate-800">
                {data.data.runners.map((r) => (
                  <li key={r.userId} className="flex flex-wrap items-baseline justify-between gap-x-3 px-2.5 py-1.5 text-xs">
                    <span dir="auto" className="min-w-0 truncate font-semibold text-slate-700 dark:text-slate-200">
                      {r.name || 'A removed account'}
                    </span>
                    <span className="tabular-nums text-muted">
                      {runnerLine(r)} · last <time dateTime={r.lastRunAt}>{formatFullTimestamp(r.lastRunAt)}</time>
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </section>
  )
}
