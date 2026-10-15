// ============================================================================
// §20 — Activity, on the assistant's settings page, for its owner alone (the
// page and GET /ai/activity both refuse anyone else): what each person asked,
// word for word, when, on which model, how many queries its answer ran, and
// what it cost — a report saved from an answer counted with it — and what each
// scheduled report's summary cost (§21), and what each certificate read on the
// MTC tab cost: who uploaded which file, and what was read from it. Newest
// first, a page at a time, for this month or the last, one person or everyone,
// one kind or all.
// The amounts stay on this page, as everywhere: the chat shows none.
// ============================================================================

import { useState } from 'react'
import { ChevronDown, ChevronUp, FileCheck2, Loader2, MessagesSquare, Zap } from 'lucide-react'
import { AI_LEVEL_NAMES, type AiActivityItem } from '@qc/shared/ai'
import { Button, Card, EmptyState } from '@/components/ui'
import { FilterSelect, Segmented } from '@/components/ui/PageShell'
import { textDirection } from '@/lib/direction'
import { cn, formatDateTime } from '@/lib/utils'
import { useAiActivity } from '@/services/queries'
import { Notice } from './AiNotice'
import { ACTIVITY_STOP_LABEL, aiModelName, formatAnswerCost, formatMonth, utcMonth } from './format'

type Kind = '' | 'question' | 'automation' | 'mtc'

export function AiActivitySection({ enabled }: { enabled: boolean }) {
  const [which, setWhich] = useState<'this' | 'last'>('this')
  const [userId, setUserId] = useState('')
  const [kind, setKind] = useState<Kind>('')
  const month = utcMonth(which === 'this' ? 0 : -1)
  const { data, isLoading, isError, isPlaceholderData, refetch, fetchNextPage, hasNextPage, isFetchingNextPage } = useAiActivity(month, userId, kind, enabled)
  const items = data?.pages.flatMap((p) => p.items) ?? []
  // The people of the newest page: everyone with activity in the month, whatever the filters.
  const people = data?.pages[0]?.people ?? []

  return (
    <section className="space-y-3" aria-label="Activity">
      <div className="flex flex-wrap items-center justify-between gap-2 pt-2">
        <div className="min-w-0">
          <h2 className="text-lg font-bold">Activity · {formatMonth(month)}</h2>
          <p className="text-sm text-muted">What each person asked, each scheduled report and each certificate uploaded, and what each cost.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <FilterSelect label="Person" value={userId} onChange={setUserId}>
            <option value="">Everyone</option>
            {people.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </FilterSelect>
          <FilterSelect label="Kind" value={kind} onChange={(v) => setKind(v as Kind)}>
            <option value="">Everything</option>
            <option value="question">Questions</option>
            <option value="automation">Scheduled reports</option>
            <option value="mtc">MTC uploads</option>
          </FilterSelect>
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
      </div>

      {isLoading && (
        <p className="flex items-center gap-2 text-sm text-muted">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading…
        </p>
      )}
      {isError && !data && (
        <Notice tone="red" action={<Button className="h-8 min-h-0 px-3 py-0 text-xs" onClick={() => void refetch()}>Try again</Button>}>
          The activity could not be loaded.
        </Notice>
      )}
      {data && items.length === 0 && (
        <Card>
          <EmptyState icon={<MessagesSquare className="h-10 w-10" />} title="Nothing asked" hint={`Nobody asked the assistant anything in ${formatMonth(month)}${userId || kind ? ' that matches these filters' : ''}.`} />
        </Card>
      )}
      {items.length > 0 && (
        <Card className={cn('overflow-hidden transition-opacity', isPlaceholderData && 'opacity-60')}>
          <ul className="divide-y divide-slate-100 dark:divide-slate-800">
            {items.map((item) => (
              <ActivityRow key={`${item.kind}:${item.id}`} item={item} />
            ))}
          </ul>
          {hasNextPage && (
            <div className="flex justify-center border-t border-slate-100 p-3 dark:border-slate-800">
              <Button onClick={() => void fetchNextPage()} disabled={isFetchingNextPage} className="min-h-[44px]">
                {isFetchingNextPage && <Loader2 className="h-4 w-4 animate-spin" />} {isFetchingNextPage ? 'Loading…' : 'Load more'}
              </Button>
            </div>
          )}
        </Card>
      )}
    </section>
  )
}

/** One question (or summary): its words on one line, whole when opened; who, when, the model, the look-ups; the cost. */
function ActivityRow({ item }: { item: AiActivityItem }) {
  const [open, setOpen] = useState(false)
  const automation = item.kind === 'automation'
  const mtc = item.kind === 'mtc'
  const running = item.kind === 'question' && item.stopReason === null
  const ended = item.stopReason && item.stopReason !== 'end_turn' ? ACTIVITY_STOP_LABEL[item.stopReason] : null
  const meta = [
    item.userName,
    formatDateTime(item.at),
    item.models.map(aiModelName).join(' → '),
    item.lookups > 0 ? `${item.lookups} look-up${item.lookups === 1 ? '' : 's'}` : null,
  ].filter(Boolean)
  return (
    <li>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-start gap-3 px-4 py-3 text-start transition-colors hover:bg-slate-50 dark:hover:bg-slate-800/40 touch:min-h-[56px]"
      >
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-start gap-1.5">
            {automation && (
              <span className="mt-0.5 inline-flex shrink-0 items-center gap-1 text-xs font-semibold text-violet-700 dark:text-violet-300">
                <Zap aria-hidden className="h-3.5 w-3.5" /> Automation:
              </span>
            )}
            {mtc && (
              <span className="mt-0.5 inline-flex shrink-0 items-center gap-1 text-xs font-semibold text-brand-700 dark:text-brand-300">
                <FileCheck2 aria-hidden className="h-3.5 w-3.5" /> MTC upload:
              </span>
            )}
            {/* The words in their own direction: an Arabic question starts at the right and is cut at its own end. */}
            <span dir={textDirection(item.text) ?? 'auto'} className={cn('min-w-0 flex-1 break-words text-start text-sm font-medium', open ? 'whitespace-pre-line' : 'line-clamp-1')}>
              {item.text}
            </span>
          </span>
          <span className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-xs text-muted">
            <span>{meta.join(' · ')}</span>
            {/* The level the question was answered at, and why the router gave it. */}
            {item.level && (
              <span data-tip={item.levelReason ? `Why: ${item.levelReason}` : 'The router could not be asked in time: the standard level'} className="font-semibold text-slate-600 dark:text-slate-300">
                · {AI_LEVEL_NAMES[item.level]}
              </span>
            )}
            {open && item.levelReason && <span className="basis-full">Level chosen because: {item.levelReason}</span>}
            {running && <span className="font-semibold text-brand-700 dark:text-brand-300">· answering…</span>}
            {ended && <span className="font-semibold text-amber-700 dark:text-amber-300">· {ended}</span>}
            {item.partial && <span data-tip="A call was cut off: part of this cost is an estimate">· estimated</span>}
          </span>
        </span>
        <span className="shrink-0 text-sm font-bold tabular-nums">{formatAnswerCost(item.costUsd)}</span>
        {open ? <ChevronUp aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-muted" /> : <ChevronDown aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-muted" />}
      </button>
    </li>
  )
}
