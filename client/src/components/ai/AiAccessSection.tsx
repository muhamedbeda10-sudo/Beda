// ============================================================================
// §20 — Who can use it, on the owner's page: the people the owner gave the
// assistant to, each with the data they may ask about, the model and effort
// their questions use, and their own monthly cap against what they spent of
// it this month, whether they may create automations (§21), and whether they
// may have it write notices (§23: administrators only — the switch says so
// for anyone else). Add a person (any active account, any role), change what
// one has, or take it away.
// Nobody but the owner ever sees this: the server answers anyone else 404,
// and the page is not even listed for them.
// ============================================================================

import { useEffect, useMemo, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { BellRing, Loader2, Pencil, Save, Trash2, UserPlus, UsersRound, Zap } from 'lucide-react'
import { AI_DOMAINS, AI_EFFORTS, AI_MAX_MONTHLY_CAP_USD, AI_MODELS, type AiAccess } from '@qc/shared/ai'
import { Badge, Button, Card, Drawer, Field, Input, Modal, Select, type BadgeTone } from '@/components/ui'
import { ScrollX } from '@/components/ui/ScrollX'
import { STICKY_TH, clickedControl } from '@/components/admin/MasterDataPanel'
import { ApiError } from '@/lib/api'
import { PHONE, useMediaQuery } from '@/lib/media'
import { cn, formatDateTime } from '@/lib/utils'
import { removeAiAccess, saveAiAccess } from '@/services/mutations'
import { useAiAccess, useAiPeople } from '@/services/queries'
import { useApp } from '@/store/AppContext'
import {
  AI_DOMAIN_SHORT,
  AI_NEW_PERSON_CAP_USD,
  NOTICES_ADMIN_ONLY,
  accessChanged,
  accessLive,
  accessRequest,
  capFitsModel,
  checkAccessDraft,
  describeModelPrice,
  domainTip,
  draftFromAccess,
  effortName,
  groupByRole,
  isAdministrator,
  minCapUsd,
  modelName,
  newAccessDraft,
  noticesAccessView,
  noticesSwitchHint,
  orderDomains,
  parseCapUsd,
  roleLabel,
  sortAccess,
  toggleDomain,
  type AccessDraft,
} from './access'
import { Notice } from './AiNotice'
import { AiSwitch } from './AiSwitch'
import { formatCap, formatUsd, spendBarClass, spendShare } from './format'

/** The same tones as the Users page: administrators stand out, supervisors a little. */
const ROLE_TONE: Record<string, BadgeTone> = { viewer: 'neutral', inspector: 'neutral', supervisor: 'blue', admin: 'violet' }

const ROW_BTN = 'grid h-11 w-11 place-items-center rounded-xl text-muted transition-colors'

type Editing = { kind: 'add' } | { kind: 'edit'; row: AiAccess }

export function AiAccessSection({ appCapUsd }: { appCapUsd: number | undefined }) {
  const { data, isLoading, isError, refetch } = useAiAccess(true)
  const [editing, setEditing] = useState<Editing | null>(null)
  const [removing, setRemoving] = useState<AiAccess | null>(null)
  const people = useMemo(() => sortAccess(data?.people ?? []), [data])

  return (
    <Card className="space-y-4 p-4 sm:p-5" role="region" aria-labelledby="ai-access-title">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-brand-100 text-brand-700 dark:bg-brand-500/15 dark:text-brand-200">
            <UsersRound className="h-5 w-5" />
          </span>
          <div className="min-w-0">
            <h3 id="ai-access-title" className="text-base font-bold">
              Who can use it
            </h3>
            <p className="mt-0.5 text-sm text-muted">
              Only the people listed here see the assistant. Each asks with the data, the model and the effort you give them, up to their own monthly cap — and the
              app-wide cap stays on top. A change applies from their next question. They never see a price or an amount.
            </p>
          </div>
        </div>
        <Button variant="primary" className="min-h-[44px]" onClick={() => setEditing({ kind: 'add' })} disabled={!data}>
          <UserPlus className="h-4 w-4" /> Add person
        </Button>
      </div>

      {isLoading && (
        <p className="flex items-center gap-2 text-sm text-muted">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading…
        </p>
      )}
      {isError && !data && (
        <Notice tone="red" action={<Button className="h-8 min-h-0 px-3 py-0 text-xs" onClick={() => void refetch()}>Try again</Button>}>
          The list of people could not be loaded.
        </Notice>
      )}
      {data &&
        (people.length === 0 ? (
          <p className="rounded-2xl border border-dashed border-slate-300 px-4 py-8 text-center text-sm text-muted dark:border-slate-700">
            Nobody has the assistant yet — you included. Add the first person.
          </p>
        ) : (
          <AccessTable people={people} onEdit={(row) => setEditing({ kind: 'edit', row })} onRemove={setRemoving} />
        ))}

      {editing && (
        <AccessEditor key={editing.kind === 'edit' ? editing.row.userId : 'add'} editing={editing} appCapUsd={appCapUsd} onClose={() => setEditing(null)} />
      )}
      {removing && <RemoveAccess row={removing} onClose={() => setRemoving(null)} />}
    </Card>
  )
}

// ---- The table -----------------------------------------------------------------------

/**
 * The list alone, drawn from the people as sorted (sortAccess). On a phone a
 * card per person; from 640 px the table, its actions kept in view while the
 * rest scrolls under them, Model and Effort shown from a wide screen only
 * (the editor names them), and a tap on a row opening the editor.
 */
export function AccessTable({ people, onEdit, onRemove }: { people: AiAccess[]; onEdit: (row: AiAccess) => void; onRemove: (row: AiAccess) => void }) {
  const th = 'px-3 py-2.5 font-bold'
  const phone = useMediaQuery(PHONE)
  if (phone) {
    return (
      <ul className="space-y-2">
        {people.map((p) => (
          <AccessCard key={p.userId} row={p} onEdit={() => onEdit(p)} onRemove={() => onRemove(p)} />
        ))}
      </ul>
    )
  }
  return (
    <ScrollX className="rounded-2xl ring-1 ring-slate-200 dark:ring-slate-800" innerClassName="rounded-2xl" shadows="start">
      <table className="table-sticky-last w-full min-w-[52rem] text-sm xl:min-w-[66rem]">
        <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-muted dark:bg-slate-800/60">
          <tr>
            <th className={th}>Person</th>
            <th className={th}>Role</th>
            <th className={th}>Access</th>
            <th className={th}>Automations</th>
            <th className={th}>Notices</th>
            <th className={th}>Data</th>
            <th className={cn(th, 'hidden xl:table-cell')}>Model</th>
            <th className={cn(th, 'hidden xl:table-cell')}>Effort</th>
            <th className={th}>This month</th>
            <th className={cn(th, STICKY_TH, 'text-right')}>
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
          {people.map((p) => (
            <AccessRow key={p.userId} row={p} onEdit={() => onEdit(p)} onRemove={() => onRemove(p)} />
          ))}
        </tbody>
      </table>
    </ScrollX>
  )
}

/** Change and Remove for one person: 44 px each. */
function RowActions({ row, onEdit, onRemove }: { row: AiAccess; onEdit: () => void; onRemove: () => void }) {
  return (
    <>
      <button type="button" onClick={onEdit} aria-label={`Change ${row.name}'s access`} data-tip="Change" className={cn(ROW_BTN, 'hover:bg-slate-100 hover:text-brand-600 dark:hover:bg-slate-800')}>
        <Pencil className="h-4 w-4" />
      </button>
      <button type="button" onClick={onRemove} aria-label={`Take the assistant from ${row.name}`} data-tip="Remove" className={cn(ROW_BTN, 'hover:bg-rose-50 hover:text-rose-600 dark:hover:bg-rose-500/10')}>
        <Trash2 className="h-4 w-4" />
      </button>
    </>
  )
}

/** The person's name, with their standing (the owner, an account that cannot sign in) beside it. */
function PersonName({ row }: { row: AiAccess }) {
  return (
    <span className="flex flex-wrap items-center gap-1.5">
      <span dir="auto" className="font-semibold text-slate-800 dark:text-slate-100">
        {row.name}
      </span>
      {row.owner && (
        <Badge tone="blue" tip="You: the assistant's owner">
          You
        </Badge>
      )}
      {!row.active && (
        <Badge tone="red" tip="This account cannot sign in, so it cannot ask, whatever is set here">
          Account off
        </Badge>
      )}
    </span>
  )
}

/** What the person may ask about, as badges; or that they cannot ask at all. */
function DomainBadges({ domains }: { domains: AiAccess['domains'] }) {
  if (domains.length === 0) return <span className="text-xs text-muted">None: cannot ask</span>
  return (
    <span className="flex max-w-[16rem] flex-wrap gap-1">
      {domains.map((d) => (
        <Badge key={d} tone="neutral" tip={domainTip(d)}>
          {AI_DOMAIN_SHORT[d]}
        </Badge>
      ))}
    </span>
  )
}

function AccessCard({ row, onEdit, onRemove }: { row: AiAccess; onEdit: () => void; onRemove: () => void }) {
  const domains = orderDomains(row.domains)
  const live = accessLive(row)
  const notices = noticesAccessView(row)
  return (
    <li className={cn('rounded-2xl p-3 ring-1 ring-slate-200 dark:ring-slate-800', !live && 'opacity-70')}>
      <button type="button" onClick={onEdit} aria-label={`Change ${row.name}'s access`} className="-my-1 flex min-h-[44px] w-full flex-col justify-center text-left">
        <PersonName row={row} />
        <span className="block font-mono text-xs text-muted">{row.username}</span>
      </button>
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <Badge tone={ROLE_TONE[row.role] ?? 'neutral'}>{row.role}</Badge>
        <Badge tone={row.enabled ? 'green' : 'neutral'}>{row.enabled ? 'On' : 'Off'}</Badge>
        {(row.owner || row.automations) && (
          <Badge tone="blue" icon={<Zap className="h-3 w-3" />}>
            Automations
          </Badge>
        )}
        {notices.key === 'can' && (
          <Badge tone="blue" icon={<BellRing className="h-3 w-3" />}>
            Notices
          </Badge>
        )}
        {notices.key === 'held' && <span className="text-xs font-medium text-amber-700 dark:text-amber-300">Notices allowed, not in effect</span>}
      </div>
      <div className="mt-2">
        <DomainBadges domains={domains} />
      </div>
      <p className="mt-2 text-xs text-muted">
        {modelName(row.model)} · {effortName(row.effort)} effort
      </p>
      <div className="mt-2 flex items-end justify-between gap-3">
        <div className="min-w-0">
          <SpendBar spent={row.spentUsd} cap={row.monthlyCapUsd} />
          {!capFitsModel(row.monthlyCapUsd, row.model) && (
            <span className="mt-1 block text-xs font-medium text-rose-700 dark:text-rose-300">Under the {formatCap(minCapUsd(row.model))} one call may cost: cannot ask</span>
          )}
        </div>
        <span className="flex shrink-0 gap-0.5">
          <RowActions row={row} onEdit={onEdit} onRemove={onRemove} />
        </span>
      </div>
    </li>
  )
}

function AccessRow({ row, onEdit, onRemove }: { row: AiAccess; onEdit: () => void; onRemove: () => void }) {
  const domains = orderDomains(row.domains)
  // A row that cannot ask now (switched off, no data, an account that cannot sign in) is drawn quieter.
  const live = accessLive(row)
  const notices = noticesAccessView(row)
  return (
    <tr
      onClick={(e) => {
        if (!clickedControl(e)) onEdit()
      }}
      className={cn('cursor-pointer align-top hover:bg-slate-50/70 dark:hover:bg-slate-800/40', !live && 'opacity-70')}
    >
      <td className="px-3 py-2.5">
        <PersonName row={row} />
        <span className="block font-mono text-xs text-muted">{row.username}</span>
      </td>
      <td className="px-3 py-2.5">
        <Badge tone={ROLE_TONE[row.role] ?? 'neutral'}>{row.role}</Badge>
      </td>
      <td className="px-3 py-2.5">
        <Badge tone={row.enabled ? 'green' : 'neutral'}>{row.enabled ? 'On' : 'Off'}</Badge>
      </td>
      <td className="px-3 py-2.5">
        {row.owner || row.automations ? (
          <Badge tone="blue" icon={<Zap className="h-3 w-3" />} tip={row.owner ? 'You always can, as the assistant’s owner' : 'May ask the assistant to set up watches and scheduled reports'}>
            Can create
          </Badge>
        ) : (
          <span className="text-xs text-muted">No</span>
        )}
      </td>
      <td className="px-3 py-2.5">
        {notices.key === 'can' ? (
          <Badge tone="blue" icon={<BellRing className="h-3 w-3" />} tip={notices.tip}>
            Can manage
          </Badge>
        ) : notices.key === 'held' ? (
          <span className="text-xs font-medium text-amber-700 dark:text-amber-300" data-tip={notices.tip}>
            Allowed, not in effect
          </span>
        ) : (
          <span className="text-xs text-muted" data-tip={notices.tip}>
            No
          </span>
        )}
      </td>
      <td className="px-3 py-2.5">
        <DomainBadges domains={domains} />
      </td>
      <td className="hidden whitespace-nowrap px-3 py-2.5 xl:table-cell" data-tip={describeModelPrice(row.model)}>
        {modelName(row.model)}
      </td>
      <td className="hidden whitespace-nowrap px-3 py-2.5 xl:table-cell">{effortName(row.effort)}</td>
      <td className="px-3 py-2.5">
        <SpendBar spent={row.spentUsd} cap={row.monthlyCapUsd} />
        {/* Below one call's cost they are told every month that the month's limit is reached: say why here. */}
        {!capFitsModel(row.monthlyCapUsd, row.model) && (
          <span className="mt-1 block max-w-[12rem] text-xs font-medium text-rose-700 dark:text-rose-300">
            Under the {formatCap(minCapUsd(row.model))} one call may cost: cannot ask
          </span>
        )}
      </td>
      <td className="whitespace-nowrap px-2 py-1.5 text-right">
        <span className="inline-flex gap-0.5">
          <RowActions row={row} onEdit={onEdit} onRemove={onRemove} />
        </span>
      </td>
    </tr>
  )
}

/** Spent this month against the person's own cap, with a bar that turns amber, then red, as it fills. */
function SpendBar({ spent, cap }: { spent: number; cap: number }) {
  const share = spendShare(spent, cap)
  return (
    <div className="min-w-[9rem]" data-tip={`${Math.round(share * 100)}% of their cap, this calendar month (UTC)`}>
      <p className="text-xs tabular-nums">
        <span className="font-semibold">{formatUsd(spent)}</span> <span className="text-muted">of {formatCap(cap)}</span>
      </p>
      <span aria-hidden className="mt-1 block h-1.5 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
        <span className={cn('block h-full rounded-full', spendBarClass(spent, cap))} style={{ width: `${Math.min(100, share * 100)}%` }} />
      </span>
    </div>
  )
}

// ---- Adding a person, or changing what one has ------------------------------------------

const OPTION = 'flex cursor-pointer items-start gap-3 rounded-xl border p-3 transition-colors has-[:disabled]:cursor-default'
/** A row with a switch at its end: the whole row is the switch's label, so a tap on its words toggles it too. */
const SWITCH_ROW = 'flex cursor-pointer items-center justify-between gap-4 rounded-xl border border-slate-200 p-4 dark:border-slate-800 has-[:disabled]:cursor-default'
const optionTone = (on: boolean) =>
  on ? 'border-brand-300 bg-brand-50/60 dark:border-brand-500/40 dark:bg-brand-500/10' : 'border-slate-200 hover:bg-slate-50 dark:border-slate-800 dark:hover:bg-slate-800/50'

function AccessEditor({ editing, appCapUsd, onClose }: { editing: Editing; appCapUsd: number | undefined; onClose: () => void }) {
  const qc = useQueryClient()
  const { toast } = useApp()
  const row = editing.kind === 'edit' ? editing.row : null
  const candidates = useAiPeople(!row)
  const [personId, setPersonId] = useState('')
  const [draft, setDraft] = useState<AccessDraft>(() => (row ? draftFromAccess(row) : newAccessDraft(appCapUsd ?? AI_NEW_PERSON_CAP_USD)))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const errorRef = useRef<HTMLParagraphElement>(null)

  // The error is written under the last field, next to Save: brought into view if the drawer was scrolled up.
  useEffect(() => {
    if (error) errorRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [error])

  const patch = (p: Partial<AccessDraft>) => {
    setDraft((d) => ({ ...d, ...p }))
    setError(null)
  }

  const groups = useMemo(() => groupByRole(candidates.data ?? []), [candidates.data])
  const person = row ? null : (candidates.data?.find((p) => p.id === personId) ?? null)
  // §23 — notices through the assistant are an administrator's: the switch turns on only for one (the server holds it too,
  // and a stored permission applies only while the role is one). Left on from before, it can still be turned off.
  const admin = isAdministrator(row?.role ?? person?.role ?? '')
  const noticesLocked = saving || !!row?.owner || (!admin && !row?.notices)
  const cap = parseCapUsd(draft.cap)
  const minCap = minCapUsd(draft.model)
  // An app-wide cap under one call's cost on their model holds every question of theirs back, whatever their own cap.
  const appCapTooLow = draft.enabled && appCapUsd !== undefined && !capFitsModel(appCapUsd, draft.model)
  // A personal cap above the app-wide one is allowed (the app-wide cap may be raised later), but worth a word.
  const appCapBelow = !appCapTooLow && cap !== null && appCapUsd !== undefined && cap > appCapUsd ? appCapUsd : null
  const ready = row ? accessChanged(row, draft) : person !== null

  const save = async () => {
    const userId = row?.userId ?? person?.id
    if (!userId) {
      setError('Choose who to give the assistant to.')
      return
    }
    const why = checkAccessDraft(draft)
    if (why) {
      setError(why)
      return
    }
    setError(null)
    setSaving(true)
    try {
      const saved = await saveAiAccess(qc, userId, accessRequest(draft))
      toast(
        row
          ? `Saved: ${saved.name}'s next question uses it. The change is in the audit log.`
          : saved.enabled
            ? `${saved.name} can use the assistant now. The change is in the audit log.`
            : `${saved.name} is listed, switched off. The change is in the audit log.`,
        'success',
      )
      onClose()
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not save.')
      setSaving(false)
    }
  }

  return (
    <Drawer
      open
      onClose={() => !saving && onClose()}
      icon={row ? <Pencil className="h-5 w-5" /> : <UserPlus className="h-5 w-5" />}
      title={row ? row.name : 'Give someone the assistant'}
      subtitle={
        row ? (
          <>
            <span className="font-mono">{row.username}</span> · {row.role}
            {row.updatedAt ? ` · changed ${formatDateTime(row.updatedAt)}${row.updatedByName ? ` by ${row.updatedByName}` : ''}` : ''}
          </>
        ) : (
          'Any active account, whatever its role.'
        )
      }
      footer={
        <>
          <Button onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void save()} disabled={saving || !ready}>
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : row ? <Save className="h-4 w-4" /> : <UserPlus className="h-4 w-4" />}{' '}
            {saving ? 'Saving…' : row ? 'Save' : 'Give access'}
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        {!row && (
          <div className="space-y-2">
            <Field label="Person" hint="Every active account not listed yet.">
              <Select
                className="min-h-[48px]"
                value={personId}
                onChange={(e) => {
                  const next = candidates.data?.find((p) => p.id === e.target.value)
                  setPersonId(e.target.value)
                  // Turned on for an administrator, then another person chosen: it goes with the administrator.
                  if (!next || !isAdministrator(next.role)) setDraft((d) => (d.notices ? { ...d, notices: false } : d))
                  setError(null)
                }}
                disabled={saving || !candidates.data || candidates.data.length === 0}
              >
                <option value="">{candidates.isLoading ? 'Loading…' : 'Choose a person'}</option>
                {groups.map(([role, list]) => (
                  <optgroup key={role} label={roleLabel(role)}>
                    {list.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name} ({p.username})
                      </option>
                    ))}
                  </optgroup>
                ))}
              </Select>
            </Field>
            {candidates.data?.length === 0 && <Notice tone="neutral">Everyone with an active account is listed already.</Notice>}
            {candidates.isError && !candidates.data && (
              <Notice tone="red" action={<Button className="h-8 min-h-0 px-3 py-0 text-xs" onClick={() => void candidates.refetch()}>Try again</Button>}>
                The accounts could not be loaded.
              </Notice>
            )}
          </div>
        )}

        {/* Each switch sits in a label: a tap anywhere on its row toggles it, not only on the 48 px switch. */}
        <label className={SWITCH_ROW}>
          <div className="min-w-0">
            <p id="ai-access-enabled" className="font-semibold">
              Can use the assistant
            </p>
            <p className="mt-0.5 text-xs text-muted">Off: its button disappears for them at once. Their conversations and reports stay, out of reach until it is back on.</p>
          </div>
          <AiSwitch on={draft.enabled} onChange={(on) => patch({ enabled: on })} labelledBy="ai-access-enabled" disabled={saving} />
        </label>

        <label className={SWITCH_ROW}>
          <div className="min-w-0">
            <p id="ai-access-automations" className="font-semibold">
              Can create automations
            </p>
            <p className="mt-0.5 text-xs text-muted">
              {row?.owner
                ? 'You always can, as the assistant’s owner.'
                : 'They may ask the assistant to watch for cases and send scheduled reports: alerts, chat messages and follow-ups only, never a change to the record. Nothing runs until they press Activate, and each runs with the data they have then; a report’s summary counts toward their cap. Off: theirs stop until it is back on.'}
            </p>
          </div>
          <AiSwitch on={draft.automations} onChange={(on) => patch({ automations: on })} labelledBy="ai-access-automations" disabled={saving || !!row?.owner} />
        </label>

        <label className={cn(SWITCH_ROW, !admin && 'bg-slate-50/70 dark:bg-slate-800/30')}>
          <div className="min-w-0">
            <p id="ai-access-notices" className={cn('font-semibold', !admin && 'text-muted')}>
              Can manage notices
            </p>
            <p className="mt-0.5 text-xs text-muted">{noticesSwitchHint({ admin, owner: !!row?.owner, stored: !!row?.notices })}</p>
          </div>
          <span data-tip={!admin && !row?.notices ? NOTICES_ADMIN_ONLY : undefined}>
            <AiSwitch on={draft.notices} onChange={(on) => patch({ notices: on })} labelledBy="ai-access-notices" disabled={noticesLocked} />
          </span>
        </label>

        <fieldset className="space-y-2" disabled={saving}>
          <legend className="label">Data they may ask about</legend>
          <p className="text-xs text-muted">
            Held by the database itself, not by the model: the rest is closed to their questions. A new conversation describes only what is ticked; one already
            started keeps what it began with, and a question on data taken away fails.
          </p>
          <div className="grid gap-2 sm:grid-cols-2">
            {AI_DOMAINS.map((d) => {
              const on = draft.domains.includes(d.id)
              return (
                <label key={d.id} className={cn(OPTION, 'min-h-[44px]', optionTone(on))}>
                  <input
                    type="checkbox"
                    checked={on}
                    onChange={(e) => patch({ domains: toggleDomain(draft.domains, d.id, e.target.checked) })}
                    className="mt-0.5 h-4 w-4 shrink-0 accent-brand-600"
                  />
                  <span className="min-w-0">
                    <span className="block text-sm font-semibold">{d.name}</span>
                    <span className="block text-xs text-muted">{d.note}</span>
                  </span>
                </label>
              )
            })}
          </div>
        </fieldset>

        <fieldset className="space-y-2" disabled={saving}>
          <legend className="label">Model</legend>
          <p className="text-xs text-muted">
            Prices per million tokens of the question read and the answer written, as Anthropic bills them (what the prompt cache reads back costs far less). Fixed
            by you: they cannot change it.
          </p>
          <div className="grid gap-2">
            {AI_MODELS.map((m) => {
              const on = draft.model === m.id
              return (
                <label key={m.id} className={cn(OPTION, optionTone(on))}>
                  <input type="radio" name="ai-access-model" checked={on} onChange={() => patch({ model: m.id })} className="mt-0.5 h-4 w-4 shrink-0 accent-brand-600" />
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-semibold">{m.name}</span>
                    <span className="block text-xs text-muted">{m.note}</span>
                    <span className="mt-1 block text-xs font-medium tabular-nums text-slate-600 dark:text-slate-300">{describeModelPrice(m.id)}</span>
                  </span>
                </label>
              )
            })}
          </div>
        </fieldset>

        <fieldset className="space-y-2" disabled={saving}>
          <legend className="label">Effort</legend>
          <p className="text-xs text-muted">How much thought each answer gets: more is slower and costs more. Fixed by you as well.</p>
          <div className="grid gap-2 sm:grid-cols-2">
            {AI_EFFORTS.map((e) => {
              const on = draft.effort === e.id
              return (
                <label key={e.id} className={cn(OPTION, 'py-2.5', optionTone(on))}>
                  <input type="radio" name="ai-access-effort" checked={on} onChange={() => patch({ effort: e.id })} className="mt-0.5 h-4 w-4 shrink-0 accent-brand-600" />
                  <span className="min-w-0">
                    <span className="block text-sm font-semibold">{e.name}</span>
                    <span className="block text-xs text-muted">{e.note}</span>
                  </span>
                </label>
              )
            })}
          </div>
        </fieldset>

        <div className="space-y-2">
          <Field
            label="Their monthly cap (USD)"
            hint={`Theirs alone, per calendar month (UTC), from ${formatCap(minCap)} to ${formatCap(AI_MAX_MONTHLY_CAP_USD)}: one call to ${modelName(draft.model)} may cost up to ${formatCap(minCap)}, and a question goes ahead only while that much is left. Once reached, they are told this month's limit is reached, without an amount.${row ? ` Spent so far this month: ${formatUsd(row.spentUsd)}, ${Math.round(spendShare(row.spentUsd, row.monthlyCapUsd) * 100)}% of the cap set now.` : ''}`}
          >
            <Input
              type="number"
              inputMode="decimal"
              min={draft.enabled ? minCap : 0}
              max={AI_MAX_MONTHLY_CAP_USD}
              step="0.01"
              value={draft.cap}
              onChange={(e) => patch({ cap: e.target.value })}
              disabled={saving}
              className="max-w-[12rem] tabular-nums"
            />
          </Field>
          {appCapTooLow && appCapUsd !== undefined && (
            <Notice tone="amber">
              The app-wide cap of {formatCap(appCapUsd)} is under the {formatCap(minCap)} one call to {modelName(draft.model)} may cost: they cannot ask until it is
              raised.
            </Notice>
          )}
          {appCapBelow !== null && (
            <Notice tone="neutral">
              Above the app-wide cap of {formatCap(appCapBelow)}: everyone's questions together stop there first.
            </Notice>
          )}
        </div>

        {error && (
          <p ref={errorRef} role="alert" className="rounded-xl bg-rose-50 px-3 py-2 text-sm font-medium text-rose-700 dark:bg-rose-500/10 dark:text-rose-300">
            {error}
          </p>
        )}
      </div>
    </Drawer>
  )
}

// ---- Taking it away ------------------------------------------------------------------------

function RemoveAccess({ row, onClose }: { row: AiAccess; onClose: () => void }) {
  const qc = useQueryClient()
  const { toast } = useApp()
  const [busy, setBusy] = useState(false)

  const remove = async () => {
    setBusy(true)
    try {
      await removeAiAccess(qc, row.userId)
      toast(row.owner ? 'You no longer have the assistant. This page stays yours.' : `${row.name} no longer has the assistant. The change is in the audit log.`, 'success')
      onClose()
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not take the assistant away.', 'error')
      setBusy(false)
    }
  }

  return (
    <Modal
      open
      onClose={() => !busy && onClose()}
      size="sm"
      title={row.owner ? 'Take the assistant from yourself?' : `Take the assistant from ${row.name}?`}
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            Keep it
          </Button>
          <Button variant="danger" onClick={() => void remove()} disabled={busy}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />} Remove
          </Button>
        </>
      }
    >
      <p className="text-sm text-slate-600 dark:text-slate-300">
        {row.owner
          ? "Its button disappears for you until you add yourself again; this page, the key, the caps and the usage stay yours. What you spent stays in the month's usage."
          : "Its button disappears for them at once. Their conversations and saved reports stay theirs, out of reach until you give the assistant back. What they spent stays in the month's usage."}{' '}
        The change is in the audit log.
      </p>
    </Modal>
  )
}
