// ============================================================================
// §4 — what a session on a universal machine was, given when it closes. The
// line's first close chooses: a final product (each later session inspects a
// new quantity of it) or stages. A staged session ticks every stage it
// covered — two at once when the item runs on two presses — each with its
// quantity, usually the same. The same fields correct a closed session.
// ============================================================================

import type { SessionStagesResponse, UniversalCloseChoice } from '@qc/shared/api'
import type { StageQuantity, UniversalKind } from '@qc/shared/types'
import { stagesProblem } from '@qc/shared/rules'
import { Badge, Field, Input } from '@/components/ui'
import { cn } from '@/lib/utils'

/** The choice as it is being typed: quantities stay text until they are read. */
export interface UniversalDraft {
  kind: UniversalKind | null
  /** A final product's quantity. */
  finalQty: string
  /** The stages ticked, each with its quantity as typed. */
  stages: { stage: number; qty: string }[]
}

/** A draft from a closed session (to correct it), or an empty one that follows the line's kind. */
export function universalDraft(lineKind: UniversalKind | null, session?: { universalKind?: UniversalKind; stages?: StageQuantity[]; finalQty?: number }): UniversalDraft {
  if (session?.universalKind || session?.stages?.length) {
    const kind: UniversalKind = session.universalKind ?? 'staged'
    return {
      kind,
      finalQty: kind === 'final' && session.finalQty !== undefined ? String(session.finalQty) : '',
      stages: (session.stages ?? []).map((s) => ({ stage: s.stage, qty: String(s.qty) })),
    }
  }
  return { kind: lineKind, finalQty: '', stages: [] }
}

const quantity = (raw: string): number | null => {
  if (raw.trim() === '') return null
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 ? n : null
}

/** What the draft says, or why it says nothing yet. `existing` are the stages the line's other sessions covered. */
export function readUniversalDraft(draft: UniversalDraft, existing: readonly number[]): { choice: UniversalCloseChoice; finalQty?: number } | { problem: string } {
  if (draft.kind === null) return { problem: 'Choose: a final product, or stages.' }
  if (draft.kind === 'final') {
    const qty = quantity(draft.finalQty)
    return qty === null ? { problem: 'Enter the final quantity.' } : { choice: { kind: 'final' }, finalQty: qty }
  }
  const stages: StageQuantity[] = []
  for (const s of draft.stages) {
    const qty = quantity(s.qty)
    if (qty === null) return { problem: `Enter the quantity of stage ${s.stage}.` }
    stages.push({ stage: s.stage, qty })
  }
  const problem = stagesProblem(existing, stages)
  return problem ? { problem } : { choice: { kind: 'staged', stages: [...stages].sort((a, b) => a.stage - b.stage) } }
}

export function UniversalChoice({
  options,
  draft,
  onChange,
  kindLocked,
}: {
  options: SessionStagesResponse
  draft: UniversalDraft
  onChange: (next: UniversalDraft) => void
  /** At a close after the line's first, the kind follows the line; a correction may change it. */
  kindLocked: boolean
}) {
  const sessionsAt = new Map(options.stages.map((s) => [s.stage, s.sessions]))
  // The line's stages, this session's own, and the next two: the item may start on two presses at once.
  const choices = Array.from(new Set([...options.stages.map((s) => s.stage), ...draft.stages.map((s) => s.stage), options.next, options.next + 1])).sort((a, b) => a - b)
  const ticked = (stage: number) => draft.stages.find((s) => s.stage === stage)
  const toggle = (stage: number) => {
    if (ticked(stage)) return onChange({ ...draft, stages: draft.stages.filter((s) => s.stage !== stage) })
    // A second stage usually made what the first did: its quantity starts as the last one typed.
    const last = draft.stages.at(-1)?.qty ?? ''
    onChange({ ...draft, stages: [...draft.stages, { stage, qty: last }] })
  }
  const setQty = (stage: number, qty: string) => onChange({ ...draft, stages: draft.stages.map((s) => (s.stage === stage ? { ...s, qty } : s)) })
  const kinds: { kind: UniversalKind; label: string; sub: string }[] = [
    { kind: 'final', label: 'Final product', sub: 'No stages: every session inspects a new quantity of it' },
    { kind: 'staged', label: 'Stages', sub: 'The item passes through stages: tick every one this session covered' },
  ]

  return (
    <div className="space-y-3">
      {kindLocked && draft.kind ? (
        <p className="rounded-xl bg-slate-50 px-3 py-2 text-sm text-slate-600 dark:bg-slate-800/60 dark:text-slate-300">
          {draft.kind === 'final'
            ? 'This item was closed as a final product: this session is one more inspection of a new quantity.'
            : 'This item passes through stages: tick the stages this session covered.'}
        </p>
      ) : (
        <div>
          <span className="label">What is this item on this machine?</span>
          <div role="radiogroup" aria-label="Final product or stages" className="grid gap-2 sm:grid-cols-2">
            {kinds.map((k) => {
              const on = draft.kind === k.kind
              return (
                <button
                  key={k.kind}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  onClick={() => onChange({ ...draft, kind: k.kind })}
                  className={cn(
                    'flex min-h-[56px] flex-col items-start justify-center rounded-xl px-3 py-2 text-left ring-1 transition-colors',
                    on ? 'bg-brand-50 ring-2 ring-brand-500 dark:bg-brand-500/10' : 'bg-white ring-slate-200 hover:bg-slate-50 dark:bg-slate-900 dark:ring-slate-700 dark:hover:bg-slate-800',
                  )}
                >
                  <span className="font-bold">{k.label}</span>
                  <span className="text-xs text-muted">{k.sub}</span>
                </button>
              )
            })}
          </div>
        </div>
      )}

      {draft.kind === 'final' && (
        <Field label="Final produced quantity" hint="A new quantity of the finished product, added to the item's earlier ones.">
          <Input type="number" inputMode="numeric" min={0} value={draft.finalQty} onChange={(e) => onChange({ ...draft, finalQty: e.target.value })} className="min-h-[48px] text-lg" />
        </Field>
      )}

      {draft.kind === 'staged' && (
        <div>
          <span className="label">Stages this session covered, and the quantity of each</span>
          <p className="mb-2 text-xs text-muted">Tick more than one when the item ran on more than one machine at the same time. The dashboard counts the quantity of the highest stage.</p>
          <div className="space-y-2">
            {choices.map((stage) => {
              const on = ticked(stage)
              const before = sessionsAt.get(stage)
              return (
                <div key={stage} className={cn('flex flex-wrap items-center gap-3 rounded-xl px-3 py-2 ring-1', on ? 'bg-brand-50 ring-2 ring-brand-500 dark:bg-brand-500/10' : 'ring-slate-200 dark:ring-slate-700')}>
                  <button type="button" role="checkbox" aria-checked={!!on} onClick={() => toggle(stage)} className="flex min-h-[44px] flex-1 flex-col items-start justify-center text-left">
                    <span className="font-bold">Stage {stage}</span>
                    <span className="text-xs text-muted">{before ? `${before} ${before === 1 ? 'session' : 'sessions'} so far` : 'A new stage of this item'}</span>
                  </button>
                  {on && (
                    <Input
                      type="number"
                      inputMode="numeric"
                      min={0}
                      aria-label={`Quantity of stage ${stage}`}
                      placeholder="Quantity"
                      value={on.qty}
                      onChange={(e) => setQty(stage, e.target.value)}
                      className="!w-36 min-h-[44px] text-lg"
                    />
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}

/** Beside a session on a universal machine: its stages ("Stages 1 + 2"), or Final product. Nothing for a lone stage 1 or any other machine. */
export function StageBadge({ kind, stages, compact = false }: { kind?: UniversalKind; stages?: StageQuantity[]; compact?: boolean }) {
  if (kind === 'final') return <Badge tone="violet" tip={compact ? 'Final product' : undefined}>{compact ? 'Final' : 'Final product'}</Badge>
  if (!stages?.length || (stages.length === 1 && stages[0].stage === 1)) return null
  const full = stages.length === 1 ? `Stage ${stages[0].stage}` : `Stages ${stages.map((s) => s.stage).join(' + ')}`
  // The table's form, "St 1+2", says the same in the width of the status column.
  return (
    <Badge tone="violet" tip={compact ? full : undefined}>
      {compact ? `St ${stages.map((s) => s.stage).join('+')}` : full}
    </Badge>
  )
}
