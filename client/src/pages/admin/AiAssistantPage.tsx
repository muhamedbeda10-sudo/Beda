// ============================================================================
// §20 — the AI assistant's settings, for its one owner (the server pins the
// account; nobody else, administrators included, sees them or their data),
// opened from the gear in the assistant's popup (AiPopup: /admin/ai):
// the Anthropic API key (set here, verified with Anthropic before it is kept,
// stored encrypted and never shown again), the switch and the app-wide
// monthly cap, who may use it and with what, and what it cost by day, by
// person and by automation (§21: scheduled reports' summaries), this month or
// the last — and Activity: each question, word for word, and what it cost.
// The figures at a glance sit on top; the sections, one at a time, under them. Amounts live here alone: the chat and the Automations pages show
// none, to anyone.
// ============================================================================

import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Activity, Bot, ChevronDown, Coins, Eye, EyeOff, Hash, KeyRound, Loader2, MessageSquareText, Save, SlidersHorizontal, Trash2, Zap } from 'lucide-react'
import { AI_MAX_MONTHLY_CAP_USD, AI_STANDARD_MODEL, type AiKeyState, type AiSettingsResponse, type AiStatusResponse, type AiUsageResponse } from '@qc/shared/ai'
import { CAP_RANGE_TEXT, parseCapUsd } from '@/components/ai/access'
import { AiAccessSection } from '@/components/ai/AiAccessSection'
import { AiActivitySection } from '@/components/ai/AiActivitySection'
import { AiSlowQueriesSection } from '@/components/ai/AiSlowQueriesSection'
import { Notice, UnavailableNotice } from '@/components/ai/AiNotice'
import { AiSwitch } from '@/components/ai/AiSwitch'
import { formatCap, formatMonth, formatTokens, formatUsd, formatUtcDay, spendBarClass, spendShare, utcMonth } from '@/components/ai/format'
import { Badge, Button, Card, Field, Input, Modal, Stat } from '@/components/ui'
import { Segmented } from '@/components/ui/PageShell'
import { ApiError } from '@/lib/api'
import { cn, formatDateTime } from '@/lib/utils'
import { removeAiKey, saveAiSettings, setAiKey } from '@/services/mutations'
import { useAiAccess, useAiMe, useAiSettings, useAiUsage } from '@/services/queries'
import { usePersistedState } from '@/lib/usePersistedState'
import { useApp } from '@/store/AppContext'

/** The server's own rule for a key: an Anthropic API key, nothing else. */
const KEY_PATTERN = /^sk-ant-[A-Za-z0-9_-]+$/

export function AiSettings() {
  // The popup lets only the owner in; asked again here so nothing is fetched for anyone else, whatever the route does.
  const { data: me } = useAiMe()
  const owner = me?.owner ?? false
  const { data, isLoading, isError, refetch } = useAiSettings(owner)
  const [tab, setTab] = usePersistedState<SettingsTab>('qc-ai-settings-tab', 'settings')
  const shown: SettingsTab = SETTINGS_TABS.some((t) => t.value === tab) ? tab : 'settings'

  if (!owner) return null
  return (
    <div className="mx-auto max-w-[88rem] space-y-4">
      <SettingsHeading data={data} />

      {isLoading && (
        <p className="flex items-center gap-2 text-sm text-muted">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading…
        </p>
      )}
      {isError && !data && (
        <Notice tone="red" action={<Button className="h-8 min-h-0 px-3 py-0 text-xs" onClick={() => void refetch()}>Try again</Button>}>
          The assistant's settings could not be loaded.
        </Notice>
      )}
      {data && !data.status.available && <StatusLine status={data.status} />}

      {data && <OverviewStrip status={data.status} />}

      <Segmented label="Settings section" value={shown} onChange={setTab} options={SETTINGS_TABS} />

      {shown === 'settings' && data && (
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
          <KeyCard data={data} />
          <SettingsCard data={data} />
        </div>
      )}
      {shown === 'people' && <AiAccessSection appCapUsd={data?.settings.monthlyCapUsd} chatModel={AI_STANDARD_MODEL} />}
      {shown === 'usage' && <UsageSection enabled={owner} />}
      {shown === 'activity' && <AiActivitySection enabled={owner} />}
      {shown === 'slow' && <AiSlowQueriesSection enabled={owner} />}
    </div>
  )
}

type SettingsTab = 'settings' | 'people' | 'usage' | 'activity' | 'slow'

/** The page's sections, one at a time under the figures: the setup, the people, what it cost, what was asked, what was slow. */
const SETTINGS_TABS: { value: SettingsTab; label: string }[] = [
  { value: 'settings', label: 'Key and cap' },
  { value: 'people', label: 'Who can use it' },
  { value: 'usage', label: 'Usage' },
  { value: 'activity', label: 'Activity' },
  { value: 'slow', label: 'Slow queries' },
]

const INTRO =
  "Only you see this page. The people you choose ask about the factory's record in plain words, in English or Arabic; Claude answers by running read-only queries over curated views of the record, and every query is shown with its rows and can be taken to Excel. It cannot change anything. You decide who may ask, about which data, and up to what each may spend a month; every question runs on Claude Sonnet at high effort, or on Claude Opus when it needs heavy work (a root cause, an FMEA), as Claude decides, and Activity shows which and why. The app-wide cap stops everyone before the bill runs away. Nobody sees a price or an amount in the chat — the figures are here alone."

/** The heading: what this is, whether the assistant is answering, who changed its settings last; what it is, folded. */
function SettingsHeading({ data }: { data: AiSettingsResponse | undefined }) {
  const state = !data ? null : !data.settings.enabled ? { tone: 'neutral' as const, text: 'Off' } : data.status.available ? { tone: 'green' as const, text: 'Open to the team' } : { tone: 'amber' as const, text: 'Not answering' }
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
        <div className="flex min-w-0 items-center gap-2">
          <Bot aria-hidden className="h-5 w-5 shrink-0 text-brand-700 dark:text-brand-300" />
          <h3 className="text-lg font-extrabold tracking-tight">AI settings</h3>
          {state && <Badge tone={state.tone}>{state.text}</Badge>}
        </div>
        {data?.updatedByName && (
          <p className="text-xs text-muted">
            Last change by {data.updatedByName}
            {data.updatedAt ? `, ${formatDateTime(data.updatedAt)}` : ''}
          </p>
        )}
      </div>
      <details className="group rounded-xl bg-white/60 ring-1 ring-slate-200/70 dark:bg-slate-900/60 dark:ring-slate-800">
        <summary className="flex min-h-[40px] cursor-pointer list-none items-center gap-2 px-3 text-13 font-semibold text-slate-600 dark:text-slate-300 touch:min-h-[44px] [&::-webkit-details-marker]:hidden">
          <ChevronDown className="h-4 w-4 shrink-0 text-muted transition-transform group-open:rotate-180" /> About the assistant and this page
        </summary>
        <p className="px-3 pb-3 text-sm text-muted">{INTRO}</p>
      </details>
    </div>
  )
}

/**
 * The figures at a glance, side by side: today, this month against the cap, the month's questions, last month, and
 * the people given the assistant. Today's and the month's spend are the server's, as the cap reads them.
 */
function OverviewStrip({ status }: { status: AiStatusResponse }) {
  const thisMonth = utcMonth(0)
  const { data: now } = useAiUsage(thisMonth, true)
  const { data: last } = useAiUsage(utcMonth(-1), true)
  const { data: access } = useAiAccess(true)
  const today = now?.byDay.find((d) => d.day === new Date().toISOString().slice(0, 10))
  const share = spendShare(status.spentUsd, status.capUsd)
  const people = access?.people.filter((p) => p.enabled).length
  const cells: { label: string; value: ReactNode; sub: ReactNode }[] = [
    { label: 'Today', value: formatUsd(today?.costUsd ?? 0), sub: `${today?.questions ?? 0} question${today?.questions === 1 ? '' : 's'}` },
    {
      label: 'This month',
      value: formatUsd(status.spentUsd),
      sub: (
        <>
          <span className="mt-1 block h-1.5 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
            <span className={cn('block h-full rounded-full', spendBarClass(status.spentUsd, status.capUsd))} style={{ width: `${Math.min(100, share * 100)}%` }} />
          </span>
          <span className="mt-1 block">of {formatCap(status.capUsd)} cap · {Math.round(share * 100)}%</span>
        </>
      ),
    },
    {
      label: 'Questions this month',
      value: now ? now.questions.toLocaleString() : '—',
      sub: now && now.questions > 0 ? `${formatUsd(now.spentUsd / now.questions)} each` : 'None asked yet',
    },
    { label: 'Last month', value: last ? formatUsd(last.spentUsd) : '—', sub: last ? `${last.questions.toLocaleString()} questions` : ' ' },
    { label: 'People', value: people ?? '—', sub: 'with the assistant' },
  ]
  return (
    <Card className="grid grid-cols-2 divide-slate-100 overflow-hidden sm:grid-cols-3 xl:grid-cols-5 xl:divide-x dark:divide-slate-800">
      {cells.map((c, i) => (
        <div key={c.label} className={cn('min-w-0 p-4', i < cells.length - 1 && 'border-b border-slate-100 dark:border-slate-800 xl:border-b-0')}>
          <p className="text-[11px] font-bold uppercase tracking-[0.12em] text-muted">{c.label}</p>
          <p className="mt-1 text-2xl font-extrabold tabular-nums tracking-tight">{c.value}</p>
          <div className="text-xs text-muted">{c.sub}</div>
        </div>
      ))}
    </Card>
  )
}

function StatusLine({ status }: { status: AiStatusResponse }) {
  if (!status.available) return <UnavailableNotice reason={status.reason ?? 'reader-unavailable'} />
  return (
    <p role="status" className="flex flex-wrap items-center gap-2 rounded-xl bg-emerald-50 px-3 py-2 text-13 text-emerald-800 ring-1 ring-inset ring-emerald-200 dark:bg-emerald-500/10 dark:text-emerald-300 dark:ring-emerald-500/25">
      <span className="h-2 w-2 shrink-0 rounded-full bg-emerald-500" aria-hidden />
      <span>
        Answering. {formatUsd(status.spentUsd)} of the app-wide {formatCap(status.capUsd)} spent this month, by everyone together.
      </span>
    </p>
  )
}

// ---- The API key ----------------------------------------------------------------

function KeyCard({ data }: { data: AiSettingsResponse }) {
  const qc = useQueryClient()
  const { toast } = useApp()
  // The key typed in: held only until it is saved, never read back from the server.
  const [value, setValue] = useState('')
  const [show, setShow] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirm, setConfirm] = useState(false)
  const [removing, setRemoving] = useState(false)
  const key = data.key

  const save = async () => {
    const apiKey = value.trim()
    if (apiKey.length < 20 || apiKey.length > 300 || !KEY_PATTERN.test(apiKey)) {
      setError('That is not an Anthropic API key: it starts with sk-ant- and has only letters, digits, - and _.')
      return
    }
    setError(null)
    setSaving(true)
    try {
      await setAiKey(qc, apiKey)
      setValue('')
      setShow(false)
      toast('Key verified with Anthropic and saved.', 'success')
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not save the key.')
    } finally {
      setSaving(false)
    }
  }

  const remove = async () => {
    setRemoving(true)
    try {
      const res = await removeAiKey(qc)
      toast(
        res.key.source === 'environment'
          ? "The key set here is removed. The server's own key keeps the assistant answering."
          : 'Key removed. The assistant cannot answer until a new one is set.',
        'success',
      )
      setConfirm(false)
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not remove the key.', 'error')
    } finally {
      setRemoving(false)
    }
  }

  const { state, tone, badge, stored, removable } = describeKey(key)

  return (
    <Card className="space-y-4 p-4 sm:p-5">
      <div className="flex items-start gap-3">
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-brand-100 text-brand-700 dark:bg-brand-500/15 dark:text-brand-200">
          <KeyRound className="h-5 w-5" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-base font-bold">Anthropic API key</h3>
            <Badge tone={tone}>{badge}</Badge>
          </div>
          <p className="mt-0.5 text-sm text-muted">{state}</p>
        </div>
      </div>

      <div className="space-y-3">
        <Field
          label={key.source === 'environment' ? (stored ? 'Replace the key kept for when the server has none' : 'A key for when the server has none') : key.set ? 'Replace the key' : 'Key'}
          hint="Tried with Anthropic before it is kept, then stored encrypted. It is never shown again, here or anywhere."
        >
          <div className="relative">
            <Input
              type={show ? 'text' : 'password'}
              value={value}
              onChange={(e) => {
                setValue(e.target.value)
                setError(null)
              }}
              onKeyDown={(e) => e.key === 'Enter' && value.trim() && void save()}
              placeholder="sk-ant-…"
              dir="ltr"
              name="anthropic-api-key"
              autoComplete="off"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              data-1p-ignore
              data-lpignore="true"
              disabled={saving}
              className="pr-12 font-mono"
            />
            <button
              type="button"
              onClick={() => setShow((s) => !s)}
              aria-label={show ? 'Hide the key' : 'Show the key'}
              data-tip={show ? 'Hide' : 'Show'}
              className="absolute right-0.5 top-1/2 grid h-11 w-11 -translate-y-1/2 place-items-center rounded-lg text-muted hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-800 dark:hover:text-slate-200"
            >
              {show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </button>
          </div>
        </Field>
        {error && <p className="rounded-xl bg-rose-50 px-3 py-2 text-sm font-medium text-rose-700 dark:bg-rose-500/10 dark:text-rose-300">{error}</p>}
        <div className="flex flex-wrap gap-2">
          <Button variant="primary" className="min-h-[44px]" onClick={() => void save()} disabled={saving || !value.trim()}>
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />} {saving ? 'Checking with Anthropic…' : 'Save key'}
          </Button>
          {removable && (
            <Button className="min-h-[44px] hover:text-rose-600" onClick={() => setConfirm(true)} disabled={saving}>
              <Trash2 className="h-4 w-4" /> {stored ? 'Remove the key set here' : 'Remove'}
            </Button>
          )}
        </div>
      </div>

      {confirm && (
        <Modal
          open
          onClose={() => !removing && setConfirm(false)}
          size="sm"
          title={stored ? 'Remove the key set here?' : 'Remove the API key?'}
          footer={
            <>
              <Button onClick={() => setConfirm(false)} disabled={removing}>
                Keep it
              </Button>
              <Button variant="danger" onClick={() => void remove()} disabled={removing}>
                {removing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />} Remove
              </Button>
            </>
          }
        >
          <p className="text-sm text-slate-600 dark:text-slate-300">
            {stored
              ? "The server's own key (ANTHROPIC_API_KEY) keeps the assistant answering. Without the key set here, nothing takes over if the server's key is ever removed. The change is in the audit log."
              : 'The assistant stops answering until a new key is set. Conversations and their costs stay. The change is in the audit log.'}
          </p>
        </Modal>
      )}
    </Card>
  )
}

/**
 * What the key card says of the key, by where it comes from. With the
 * server's key in use, a key set here is not used, but kept — it becomes the
 * live key the day the server's goes — so it is shown, and can be removed.
 */
export function describeKey(key: AiKeyState): {
  state: ReactNode
  tone: 'green' | 'amber' | 'red' | 'blue'
  badge: string
  stored: NonNullable<AiKeyState['stored']> | null
  removable: boolean
} {
  const ending = key.last4 ? <span className="font-mono">…{key.last4}</span> : null
  const stored = key.source === 'environment' ? (key.stored ?? null) : null
  const removable = key.source === 'app' || !!key.unreadable || !!stored
  if (key.unreadable) {
    return { tone: 'red', badge: 'Unreadable', stored, removable, state: <>A key is saved but can no longer be read — the server's secret has changed since. Set it again.</> }
  }
  if (key.source === 'environment') {
    const state = (
      <>
        From the server's environment (ANTHROPIC_API_KEY){ending && <>, ending {ending}</>}. It wins over a key set here.
        {stored && (
          <>
            {' '}
            A key set here (ending <span className="font-mono">…{stored.last4}</span>, changed {formatDateTime(stored.updatedAt)}
            {stored.updatedByName ? ` by ${stored.updatedByName}` : ''}) is kept for when the server has none
            {stored.unreadable ? <>, but it can no longer be read — the server's secret has changed since. Set it again, or remove it.</> : '.'}
          </>
        )}
      </>
    )
    return { tone: 'blue', badge: 'From the server', stored, removable, state }
  }
  if (key.set) {
    const state = (
      <>
        Set{ending && <>, ending {ending}</>}.{key.updatedAt ? ` Changed ${formatDateTime(key.updatedAt)}${key.updatedByName ? ` by ${key.updatedByName}` : ''}.` : ''}
      </>
    )
    return { tone: 'green', badge: 'Set', stored, removable, state }
  }
  return { tone: 'amber', badge: 'Not set', stored, removable, state: <>No key yet. The assistant cannot answer until one is set.</> }
}

// ---- The switch and the cap ----------------------------------------------------------

function SettingsCard({ data }: { data: AiSettingsResponse }) {
  const qc = useQueryClient()
  const { toast } = useApp()
  const [enabled, setEnabled] = useState(data.settings.enabled)
  const [cap, setCap] = useState(String(data.settings.monthlyCapUsd))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // The server's values replace the draft only when they change, not on every refetch.
  const serverEnabled = data.settings.enabled
  const serverCap = data.settings.monthlyCapUsd
  useEffect(() => {
    setEnabled(serverEnabled)
    setCap(String(serverCap))
  }, [serverEnabled, serverCap])

  const dirty = enabled !== serverEnabled || cap.trim() !== String(serverCap)

  const save = async () => {
    const n = parseCapUsd(cap)
    if (n === null) {
      setError(CAP_RANGE_TEXT)
      return
    }
    setError(null)
    setSaving(true)
    try {
      await saveAiSettings(qc, { enabled, monthlyCapUsd: n })
      toast('Settings saved. The change is in the audit log.', 'success')
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not save the settings.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Card className="space-y-4 p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-brand-100 text-brand-700 dark:bg-brand-500/15 dark:text-brand-200">
            <SlidersHorizontal className="h-5 w-5" />
          </span>
          <div className="min-w-0">
            <h3 className="text-base font-bold">Switch and app-wide monthly cap</h3>
            <p className="mt-0.5 text-sm text-muted">
              Counted per calendar month in UTC, as Anthropic bills.
              {data.updatedAt ? ` Last changed ${formatDateTime(data.updatedAt)}${data.updatedByName ? ` by ${data.updatedByName}` : ''}.` : ' Using the defaults.'}
            </p>
          </div>
        </div>
      </div>

      {error && <p className="rounded-xl bg-rose-50 px-3 py-2 text-sm font-medium text-rose-700 dark:bg-rose-500/10 dark:text-rose-300">{error}</p>}

      {/* The whole row is the switch's label: a tap on its words toggles it too. */}
      <label className="flex cursor-pointer items-center justify-between gap-4 rounded-xl border border-slate-200 p-4 has-[:disabled]:cursor-default dark:border-slate-800">
        <div className="min-w-0">
          <p id="ai-enabled-label" className="font-semibold">
            Assistant on
          </p>
          <p className="mt-0.5 text-xs text-muted">Off, nobody can ask — you included — whatever the key and the caps. Conversations stay.</p>
        </div>
        <AiSwitch on={enabled} onChange={setEnabled} labelledBy="ai-enabled-label" disabled={saving} />
      </label>

      <Field
        label="App-wide monthly cap (USD)"
        hint={`0 to ${formatCap(AI_MAX_MONTHLY_CAP_USD)}, for everyone's questions together; each person's own cap applies under it. Once reached, nobody can ask until the 1st. No call to the model is made that could go past it.`}
      >
        <Input
          type="number"
          inputMode="decimal"
          min={0}
          max={AI_MAX_MONTHLY_CAP_USD}
          step="0.01"
          value={cap}
          onChange={(e) => {
            setCap(e.target.value)
            setError(null)
          }}
          disabled={saving}
          className="max-w-[12rem] tabular-nums"
        />
      </Field>

      {/* Saved together, under what is saved: the switch and the cap are one change in the audit log. */}
      <div className="flex justify-end border-t border-slate-100 pt-4 dark:border-slate-800">
        <Button variant="primary" className="min-h-[44px]" onClick={() => void save()} disabled={saving || !dirty}>
          <Save className="h-4 w-4" /> {saving ? 'Saving…' : 'Save'}
        </Button>
      </div>
    </Card>
  )
}

// ---- Usage -------------------------------------------------------------------------------

function UsageSection({ enabled }: { enabled: boolean }) {
  const [which, setWhich] = useState<'this' | 'last'>('this')
  const month = utcMonth(which === 'this' ? 0 : -1)
  const { data, isLoading, isError, isPlaceholderData, refetch } = useAiUsage(month, enabled)

  return (
    <section className="space-y-3" aria-label="Usage">
      <div className="flex flex-wrap items-center justify-between gap-2 pt-2">
        <h2 className="text-lg font-bold">Usage · {formatMonth(month)}</h2>
        <Segmented
          label="Month"
          value={which}
          onChange={setWhich}
          options={[
            { value: 'this', label: 'This month' },
            { value: 'last', label: 'Last month' },
          ]}
        />
      </div>
      {isLoading && (
        <p className="flex items-center gap-2 text-sm text-muted">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading…
        </p>
      )}
      {isError && !data && (
        <Notice tone="red" action={<Button className="h-8 min-h-0 px-3 py-0 text-xs" onClick={() => void refetch()}>Try again</Button>}>
          The usage could not be loaded.
        </Notice>
      )}
      {data && <Usage data={data} stale={isPlaceholderData} />}
    </section>
  )
}

function Usage({ data, stale }: { data: AiUsageResponse; stale: boolean }) {
  const share = spendShare(data.spentUsd, data.capUsd)
  const days = useMemo(() => [...data.byDay].sort((a, b) => b.day.localeCompare(a.day)), [data.byDay])
  const people = useMemo(() => [...data.byUser].sort((a, b) => b.costUsd - a.costUsd), [data.byUser])
  const automations = useMemo(() => [...(data.byAutomation ?? [])].sort((a, b) => b.costUsd - a.costUsd || a.name.localeCompare(b.name)), [data.byAutomation])
  const dayMax = Math.max(0, ...days.map((d) => d.costUsd))

  return (
    <div className={cn('space-y-4 transition-opacity', stale && 'opacity-60')}>
      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        <Stat
          label="Spent"
          value={formatUsd(data.spentUsd)}
          icon={<Coins className="h-5 w-5" />}
          tone={share >= 0.9 ? 'red' : share >= 0.7 ? 'amber' : 'green'}
          sub={
            <>
              <span className="block">
                of {formatCap(data.capUsd)} cap · {Math.round(share * 100)}%
              </span>
              <span className="mt-1.5 block h-1.5 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
                <span className={cn('block h-full origin-left rounded-full animate-grow-x', spendBarClass(data.spentUsd, data.capUsd))} style={{ width: `${Math.min(100, share * 100)}%` }} />
              </span>
            </>
          }
        />
        <Stat label="Questions" value={data.questions.toLocaleString()} icon={<MessageSquareText className="h-5 w-5" />} sub={data.questions > 0 ? `${formatUsd(data.spentUsd / data.questions)} each on average` : 'None asked'} />
        <Stat label="Calls to the model" value={data.calls.toLocaleString()} icon={<Activity className="h-5 w-5" />} tone="violet" sub="A question takes one or more" />
        <Stat
          label="Tokens"
          value={formatTokens(data.inputTokens + data.outputTokens)}
          icon={<Hash className="h-5 w-5" />}
          tone="neutral"
          sub={`${formatTokens(data.inputTokens)} in · ${formatTokens(data.outputTokens)} out · ${formatTokens(data.cacheReadTokens)} from cache · ${formatTokens(data.cacheWriteTokens)} cached`}
        />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card className="overflow-hidden">
          <h3 className="border-b border-slate-100 px-4 py-3 text-sm font-bold dark:border-slate-800">By day (UTC)</h3>
          {days.length === 0 ? (
            <p className="px-4 py-8 text-center text-sm text-muted">Nothing was asked in {formatMonth(data.month)}.</p>
          ) : (
            <div className="max-h-96 overflow-auto">
              <table className="w-full text-sm">
                <thead className="text-left text-xs uppercase tracking-wide text-muted">
                  <tr>
                    <th className="sticky top-0 bg-slate-50 px-4 py-2 font-bold dark:bg-slate-800">Day</th>
                    <th className="sticky top-0 bg-slate-50 px-4 py-2 text-right font-bold dark:bg-slate-800">Calls</th>
                    <th className="sticky top-0 bg-slate-50 px-4 py-2 text-right font-bold dark:bg-slate-800">Cost</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                  {days.map((d) => (
                    <tr key={d.day} className="data-row">
                      <td className="px-4 whitespace-nowrap">{formatUtcDay(d.day)}</td>
                      <td className="px-4 text-right tabular-nums">{d.calls.toLocaleString()}</td>
                      <td className="px-4 text-right tabular-nums">
                        <span className="inline-flex items-center justify-end gap-2">
                          <span className="hidden h-1.5 w-16 overflow-hidden rounded-full bg-slate-100 sm:block dark:bg-slate-800">
                            <span className="block h-full rounded-full bg-brand-500" style={{ width: `${dayMax > 0 ? (d.costUsd / dayMax) * 100 : 0}%` }} />
                          </span>
                          {formatUsd(d.costUsd)}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        <Card className="overflow-hidden">
          <h3 className="border-b border-slate-100 px-4 py-3 text-sm font-bold dark:border-slate-800">By person</h3>
          {people.length === 0 ? (
            <p className="px-4 py-8 text-center text-sm text-muted">Nobody asked in {formatMonth(data.month)}.</p>
          ) : (
            <div className="max-h-96 overflow-auto">
              <table className="w-full text-sm">
                <thead className="text-left text-xs uppercase tracking-wide text-muted">
                  <tr>
                    <th className="sticky top-0 bg-slate-50 px-4 py-2 font-bold dark:bg-slate-800">Name</th>
                    <th className="sticky top-0 bg-slate-50 px-4 py-2 text-right font-bold dark:bg-slate-800">Questions</th>
                    <th className="sticky top-0 bg-slate-50 px-4 py-2 text-right font-bold dark:bg-slate-800">Cost</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                  {people.map((p) => (
                    <tr key={p.userId} className="data-row">
                      <td className="px-4 font-semibold" dir="auto">
                        {p.userName}
                      </td>
                      <td className="px-4 text-right tabular-nums">{p.questions.toLocaleString()}</td>
                      <td className="px-4 text-right tabular-nums">{formatUsd(p.costUsd)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        <UsageByAutomation rows={automations} month={data.month} />
      </div>
    </div>
  )
}

/**
 * §21 — what scheduled reports' summaries cost, by automation: the one model
 * call each run makes for its summary (the sections themselves cost nothing).
 * Counted in the days above and in each creator's line too. Here alone.
 */
export function UsageByAutomation({ rows, month }: { rows: AiUsageResponse['byAutomation']; month: string }) {
  return (
    <Card className="overflow-hidden lg:col-span-2">
      <h3 className="border-b border-slate-100 px-4 py-3 text-sm font-bold dark:border-slate-800">
        <span className="flex items-center gap-2">
          <Zap className="h-4 w-4 shrink-0 text-muted" /> By automation
        </span>
        <span className="block text-xs font-normal text-muted">Scheduled reports’ summaries, also counted above</span>
      </h3>
      {rows.length === 0 ? (
        <p className="px-4 py-8 text-center text-sm text-muted">No scheduled report was summarised in {formatMonth(month)}.</p>
      ) : (
        <div className="max-h-96 overflow-auto">
          <table className="w-full min-w-[32rem] text-sm">
            <thead className="text-left text-xs uppercase tracking-wide text-muted">
              <tr>
                <th className="sticky top-0 bg-slate-50 px-4 py-2 font-bold dark:bg-slate-800">Automation</th>
                <th className="sticky top-0 bg-slate-50 px-4 py-2 font-bold dark:bg-slate-800">Creator</th>
                <th className="sticky top-0 bg-slate-50 px-4 py-2 text-right font-bold dark:bg-slate-800">Runs</th>
                <th className="sticky top-0 bg-slate-50 px-4 py-2 text-right font-bold dark:bg-slate-800">Cost</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {rows.map((a) => (
                <tr key={a.automationId} className="data-row">
                  {/* Aligned as the header is; the name itself keeps its own direction. */}
                  <td className="px-4 text-left font-semibold">
                    <span dir="auto">{a.name}</span>
                  </td>
                  <td className="px-4 text-left">
                    <span dir="auto">{a.creatorName}</span>
                  </td>
                  <td className="px-4 text-right tabular-nums">{a.runs.toLocaleString()}</td>
                  <td className="px-4 text-right tabular-nums">{formatUsd(a.costUsd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  )
}
