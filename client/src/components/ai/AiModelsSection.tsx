// ============================================================================
// §20 — Models, on the assistant's settings page, for its owner alone: which
// model and effort each kind of work runs on. A chat question is given a
// level first — by the cheapest model reading it (Auto), or always the level
// chosen here — and a question with files has a level of its own; the other
// actions (a certificate, a title, a report's template, a scheduled summary)
// each run on their own line. "Auto" is the recommended choice, shown beside
// it. Saved together; every change is in the audit log.
// ============================================================================

import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Cpu, RotateCcw, Save } from 'lucide-react'
import {
  AI_ACTIONS,
  AI_CHAT_TIERS,
  AI_EFFORTS,
  AI_MODELS,
  AI_MTC_REREAD_MODEL,
  AI_MTC_REREAD_SHARE,
  AI_ROUTER_MODEL,
  AI_ACTION_INFO,
  AI_DEFAULT_SETTINGS,
  isAiEffort,
  isAiModel,
  resolveAiAction,
  type AiAction,
  type AiActionInfo,
  type AiActionSetting,
  type AiChatMode,
  type AiSettings,
  type AiSettingsResponse,
} from '@qc/shared/ai'
import { Button, Card, Select } from '@/components/ui'
import { ApiError } from '@/lib/api'
import { cn } from '@/lib/utils'
import { saveAiSettings } from '@/services/mutations'
import { useApp } from '@/store/AppContext'
import { describeModelPrice, effortName, modelName } from './access'
import { AiSwitch } from './AiSwitch'
import { Notice } from './AiNotice'

type Draft = Pick<AiSettings, 'chatMode' | 'actions' | 'mtcReread'>

const CHAT_ACTIONS = AI_ACTIONS.filter((a) => a.id.startsWith('chat-'))
const OTHER_ACTIONS = AI_ACTIONS.filter((a) => !a.id.startsWith('chat-'))

const CHAT_MODES: { value: AiChatMode; label: string; note: string }[] = [
  {
    value: 'auto',
    label: 'Auto: Claude decides',
    note: `Before each question, ${modelName(AI_ROUTER_MODEL)} reads it (a fraction of a cent, about a second) and gives it a level; Activity shows which, and why.`,
  },
  ...AI_CHAT_TIERS.map((t) => ({ value: t as AiChatMode, label: `Always: ${AI_ACTION_INFO[t].name}`, note: `Every question without files runs as ${AI_ACTION_INFO[t].name.toLowerCase()}.` })),
]

const draftOf = (s: AiSettings): Draft => ({ chatMode: s.chatMode, actions: { ...s.actions }, mtcReread: s.mtcReread })
const sameDraft = (a: Draft, b: Draft) => JSON.stringify(a) === JSON.stringify(b)

export function AiModelsSection({ data }: { data: AiSettingsResponse }) {
  const qc = useQueryClient()
  const { toast } = useApp()
  const saved = useMemo(() => draftOf(data.settings), [data.settings])
  const [draft, setDraft] = useState<Draft>(saved)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // The server's values replace the draft only when they change, not on every refetch.
  useEffect(() => setDraft(saved), [saved])
  const dirty = !sameDraft(draft, saved)
  const recommended = draftOf(AI_DEFAULT_SETTINGS)

  const setAction = (id: AiAction, change: Partial<AiActionSetting>) => {
    setDraft((d) => ({ ...d, actions: { ...d.actions, [id]: { ...d.actions[id], ...change } } }))
    setError(null)
  }

  const save = async () => {
    setSaving(true)
    setError(null)
    try {
      await saveAiSettings(qc, { enabled: data.settings.enabled, monthlyCapUsd: data.settings.monthlyCapUsd, ...draft })
      toast('Models saved. The change is in the audit log.', 'success')
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not save the models.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-4">
      <Card className="space-y-4 p-4 sm:p-5">
        <div className="flex min-w-0 items-start gap-3">
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-brand-100 text-brand-700 dark:bg-brand-500/15 dark:text-brand-200">
            <Cpu className="h-5 w-5" />
          </span>
          <div className="min-w-0">
            <h3 className="text-base font-bold">Models by what Claude is doing</h3>
            <p className="mt-0.5 text-sm text-muted">
              Not by who asks: a count is a cheap model’s work, a root-cause analysis a strong one’s. Auto is the recommended choice, named beside it. Everyone’s
              questions follow these; each person’s own cap still applies.
            </p>
          </div>
        </div>

        <fieldset className="space-y-2" disabled={saving}>
          <legend className="label">How a chat question finds its level</legend>
          <div className="grid gap-2 md:grid-cols-2">
            {CHAT_MODES.map((m) => {
              const on = draft.chatMode === m.value
              return (
                <label
                  key={m.value}
                  className={cn(
                    'flex cursor-pointer items-start gap-3 rounded-xl border p-3 transition-colors',
                    on ? 'border-brand-400 bg-brand-50/60 dark:border-brand-500/60 dark:bg-brand-500/10' : 'border-slate-200 hover:bg-slate-50 dark:border-slate-800 dark:hover:bg-slate-800/40',
                  )}
                >
                  <input
                    type="radio"
                    name="ai-chat-mode"
                    checked={on}
                    onChange={() => setDraft((d) => ({ ...d, chatMode: m.value }))}
                    className="mt-0.5 h-4 w-4 shrink-0 accent-brand-600"
                  />
                  <span className="min-w-0">
                    <span className="block text-sm font-semibold">
                      {m.label}
                      {m.value === 'auto' && <span className="ml-1.5 text-xs font-medium text-brand-700 dark:text-brand-300">recommended</span>}
                    </span>
                    <span className="block text-xs text-muted">{m.note}</span>
                  </span>
                </label>
              )
            })}
          </div>
          <p className="text-xs text-muted">
            A question carrying photos, PDFs or spreadsheets runs as “{AI_ACTION_INFO['chat-files'].name}”. Within a conversation the level only goes up: a
            follow-up asking less stays at the conversation’s level, so the conversation so far is read from Anthropic’s cache at a tenth of the price instead of
            paid for again on another model.
          </p>
        </fieldset>
      </Card>

      <ActionTable title="Chat questions, by level" actions={CHAT_ACTIONS} draft={draft} saving={saving} onChange={setAction} />
      <ActionTable
        title="Everything else"
        actions={OTHER_ACTIONS}
        draft={draft}
        saving={saving}
        onChange={setAction}
        extra={(a) =>
          a.id === 'mtc' ? (
            <label className="mt-2 flex cursor-pointer items-start gap-3">
              <AiSwitch on={draft.mtcReread} onChange={(on) => setDraft((d) => ({ ...d, mtcReread: on }))} labelledBy="ai-mtc-reread" disabled={saving} />
              <span id="ai-mtc-reread" className="text-xs text-muted">
                Read unclear certificates again on {modelName(AI_MTC_REREAD_MODEL)}: when nothing usable comes back, or more than {Math.round(AI_MTC_REREAD_SHARE * 100)}% of the values are
                unsure (a scan, say). That certificate costs about three times as much; the others nothing more.
              </span>
            </label>
          ) : null
        }
      />

      {error && <Notice tone="red">{error}</Notice>}
      <div className="flex flex-wrap justify-end gap-2">
        <Button className="min-h-[44px]" disabled={saving || sameDraft(draft, recommended)} onClick={() => setDraft(recommended)}>
          <RotateCcw className="h-4 w-4" /> All recommended
        </Button>
        <Button variant="primary" className="min-h-[44px]" disabled={saving || !dirty} onClick={() => void save()}>
          <Save className="h-4 w-4" /> {saving ? 'Saving…' : 'Save'}
        </Button>
      </div>
    </div>
  )
}

function ActionTable({
  title,
  actions,
  draft,
  saving,
  onChange,
  extra,
}: {
  title: string
  actions: readonly AiActionInfo[]
  draft: Draft
  saving: boolean
  onChange: (id: AiAction, change: Partial<AiActionSetting>) => void
  extra?: (a: AiActionInfo) => ReactNode
}) {
  return (
    <Card className="overflow-hidden">
      <h4 className="border-b border-slate-100 px-4 py-3 text-sm font-bold dark:border-slate-800">{title}</h4>
      <ul className="divide-y divide-slate-100 dark:divide-slate-800">
        {actions.map((a) => {
          const set = draft.actions[a.id]
          const runs = resolveAiAction(draft, a.id)
          return (
            <li key={a.id} className="grid gap-3 px-4 py-3 md:grid-cols-[minmax(0,1fr)_16rem_11rem] md:items-start">
              <div className="min-w-0">
                <p className="text-sm font-semibold">{a.name}</p>
                <p className="text-xs text-muted">{a.when}</p>
                <p className="mt-1 text-xs font-medium tabular-nums text-slate-600 dark:text-slate-300" data-tip={describeModelPrice(runs.model)}>
                  Runs on {modelName(runs.model)}
                  {a.usesEffort ? `, ${effortName(runs.effort).toLowerCase()} effort` : ''} · {describeModelPrice(runs.model)}
                </p>
                {extra?.(a)}
              </div>
              <label className="block">
                <span className="mb-1 block text-xs font-semibold uppercase text-muted md:sr-only">Model</span>
                <Select
                  className="min-h-[40px] w-full text-sm"
                  value={set.model}
                  disabled={saving}
                  aria-label={`Model: ${a.name}`}
                  onChange={(e) => {
                    const v = e.target.value
                    if (v === 'auto' || isAiModel(v)) onChange(a.id, { model: v })
                  }}
                >
                  <option value="auto">Auto ({modelName(a.recommended.model)})</option>
                  {AI_MODELS.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
                </Select>
              </label>
              <label className="block">
                <span className="mb-1 block text-xs font-semibold uppercase text-muted md:sr-only">Effort</span>
                {a.usesEffort ? (
                  <Select
                    className="min-h-[40px] w-full text-sm"
                    value={set.effort}
                    disabled={saving}
                    aria-label={`Effort: ${a.name}`}
                    onChange={(e) => {
                      const v = e.target.value
                      if (v === 'auto' || isAiEffort(v)) onChange(a.id, { effort: v })
                    }}
                  >
                    <option value="auto">Auto ({effortName(a.recommended.effort)})</option>
                    {AI_EFFORTS.map((x) => (
                      <option key={x.id} value={x.id}>
                        {x.name}
                      </option>
                    ))}
                  </Select>
                ) : (
                  <span className="flex min-h-[40px] items-center text-xs text-muted">No thinking: a few words</span>
                )}
              </label>
            </li>
          )
        })}
      </ul>
    </Card>
  )
}
