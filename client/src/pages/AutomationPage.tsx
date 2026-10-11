// ============================================================================
// §21 — one automation, on its own page: what it does in plain words and as
// facts, its state and why (a stop names its cause; a block resumes on its
// own), when it runs next and how its last run went, its queries read-only
// (they change only through the assistant: "Edit in chat" opens a new
// conversation saying which automation), and every run it made — when,
// what it found, whom it told, what failed — newest first, page by page.
// Its creator, and the assistant's owner, may change its words, people,
// channels, actions and timing here, pause and resume it, run it now (a real
// run), test it (a dry run: nothing sent, nothing recorded) or delete it.
// Times are the factory's. Never a cost.
// ============================================================================

import '@/components/ai/fonts'
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import {
  ArrowLeft,
  CalendarClock,
  CheckCircle2,
  FileChartColumn,
  FlaskConical,
  ListChecks,
  Loader2,
  MessageSquareText,
  OctagonX,
  Pause,
  Pencil,
  Play,
  RefreshCw,
  Sparkles,
  Trash2,
  X,
  Zap,
} from 'lucide-react'
import type { Automation, AutomationRun, AutomationTestResponse } from '@qc/shared/automation'
import { Badge, Button, Card, Modal } from '@/components/ui'
import { useTableView, ViewNote, ViewTh } from '@/components/ui/ColumnFilter'
import { AiCode } from '@/components/ai/AiCode'
import { textDirection } from '@/components/ai/tables'
import { Notice } from '@/components/ai/AiNotice'
import { useAi } from '@/components/ai/AiAssistantProvider'
import { AutomationEditor } from '@/components/automations/AutomationEditor'
import { CasesTable, DefinitionFacts, ErrorList, KindBadge, NotificationPreview, SectionsPreview, StatusBadge, errorLines, periodText } from '@/components/automations/parts'
import {
  BLOCKED_TEXT,
  automationStatus,
  automationSummary,
  editInChatText,
  factoryMoment,
  factoryTimestamp,
  knownWatchColumns,
  noNextRunText,
  runFigures,
  runOutcome,
  runToast,
  stoppedText,
  testSummary,
} from '@/components/automations/wording'
import { ApiError } from '@/lib/api'
import { cn, formatDate } from '@/lib/utils'
import {
  deleteAutomation,
  pauseAutomation,
  recheckAccessOn404,
  resumeAutomation,
  runAutomationNow,
  testAutomation,
  updateAutomation,
  useAutomation,
  useAutomationRuns,
} from '@/services/automations'
import { useApp } from '@/store/AppContext'
import { useAuth } from '@/store/AuthContext'

const ACTION = 'h-10 min-h-0 gap-1.5 px-3 py-0 text-13 touch:h-11'

type Busy = 'pause' | 'resume' | 'run' | 'test' | 'delete' | null

export function AutomationPage() {
  const { id = '' } = useParams()
  const qc = useQueryClient()
  const { data: a, isLoading, isError, error, refetch } = useAutomation(id || null)
  useEffect(() => recheckAccessOn404(qc, error), [qc, error])
  const gone = error instanceof ApiError && error.status === 404

  return (
    <div className="ai-type mx-auto w-full max-w-6xl space-y-4">
      <Link to="/automations" className="inline-flex min-h-[40px] items-center gap-1.5 text-13 font-semibold text-brand-700 hover:underline dark:text-brand-300">
        <ArrowLeft className="h-4 w-4 rtl:rotate-180" /> Automations
      </Link>
      {isLoading ? (
        <Card className="flex items-center justify-center gap-2 p-10 text-sm text-muted">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading…
        </Card>
      ) : gone ? (
        <Notice tone="red">This automation could not be found. It may have been deleted, or it is not yours to see.</Notice>
      ) : isError && !a ? (
        <Notice tone="red" action={<Button className="h-8 min-h-0 px-3 py-0 text-xs touch:h-11" onClick={() => void refetch()}>Try again</Button>}>
          The automation could not be loaded.
        </Notice>
      ) : a ? (
        <AutomationView a={a} />
      ) : null}
    </div>
  )
}

function AutomationView({ a }: { a: Automation }) {
  const qc = useQueryClient()
  const ai = useAi()
  const navigate = useNavigate()
  const { toast } = useApp()
  const { profile, factoryTimeZone } = useAuth()
  const [editing, setEditing] = useState(false)
  const [removing, setRemoving] = useState(false)
  const [busy, setBusy] = useState<Busy>(null)
  const [test, setTest] = useState<AutomationTestResponse | null>(null)
  const [problems, setProblems] = useState<string[] | null>(null)

  const status = automationStatus(a)
  const mine = a.creator.id === profile?.id
  const columns = useMemo(() => (a.kind === 'watch' ? knownWatchColumns(a, test?.ok ? test.columns : null) : []), [a, test])
  const summary = automationSummary(a)

  const act = async (what: Exclude<Busy, null>, fn: () => Promise<void>) => {
    setBusy(what)
    setProblems(null)
    try {
      await fn()
    } catch (e) {
      setProblems(errorLines(e, 'That did not work.'))
    } finally {
      setBusy(null)
    }
  }

  const pause = () => act('pause', async () => {
    await pauseAutomation(qc, a.id)
    toast(`“${a.name}” is paused. The change is in the audit log.`, 'success')
  })
  const resume = () => act('resume', async () => {
    await resumeAutomation(qc, a.id)
    toast(`“${a.name}” is on again. The change is in the audit log.`, 'success')
  })
  const runNow = () => act('run', async () => {
    const run = await runAutomationNow(qc, a.id)
    toast(runToast(run, a.kind), run.ok === false ? 'error' : 'success')
  })
  const runTest = () => act('test', async () => {
    setTest(await testAutomation(a.id))
  })
  const remove = () => act('delete', async () => {
    await deleteAutomation(qc, a.id)
    toast(`“${a.name}” is deleted. Its follow-ups and the reports it sent stay. The change is in the audit log.`, 'success')
    navigate('/automations', { replace: true })
  })

  const openConversation = () => {
    if (!a.conversationId) return
    ai.openConversation(a.conversationId)
    ai.setOpen(true)
  }

  return (
    <>
      <header className="space-y-2">
        <div className="flex flex-wrap items-center gap-1.5">
          <KindBadge kind={a.kind} />
          <StatusBadge automation={a} />
          <span className="text-xs text-muted">
            {ai.owner && !mine && (
              <>
                Created by <bdi dir="auto" className="font-semibold text-slate-700 dark:text-slate-200">{a.creator.name}</bdi> ·{' '}
              </>
            )}
            Created {formatDate(a.createdAt)}
            {a.updatedByName && a.updatedAt !== a.createdAt && (
              <>
                {' '}
                · changed {formatDate(a.updatedAt)} by <bdi dir="auto">{a.updatedByName}</bdi>
              </>
            )}
          </span>
        </div>
        <h1 dir="auto" className="break-words text-2xl font-extrabold tracking-tight">
          {a.name}
        </h1>
        {/* Kept to a readable measure, on the side its words start from: an Arabic one ends where the title does. */}
        <p dir="auto" className={cn('max-w-3xl whitespace-pre-wrap break-words text-sm text-muted', textDirection(a.description) === 'rtl' && 'ml-auto')}>
          {a.description}
        </p>
        <div className="flex flex-wrap items-center gap-2 pt-1">
          <Button variant="primary" className={ACTION} onClick={() => void runNow()} disabled={busy !== null || status.key === 'blocked'} data-tip={status.key === 'blocked' ? status.tip : 'A real run, now: it tells people and is recorded'}>
            {busy === 'run' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />} Run now
          </Button>
          <Button className={ACTION} onClick={() => void runTest()} disabled={busy !== null} data-tip="What it would find and whom it would tell now. Nothing is sent or recorded.">
            {busy === 'test' ? <Loader2 className="h-4 w-4 animate-spin" /> : <FlaskConical className="h-4 w-4" />} Test
          </Button>
          {a.status === 'active' ? (
            <Button className={ACTION} onClick={() => void pause()} disabled={busy !== null}>
              {busy === 'pause' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Pause className="h-4 w-4" />} Pause
            </Button>
          ) : (
            <Button className={ACTION} onClick={() => void resume()} disabled={busy !== null} data-tip={a.status === 'failed' ? 'On again, its failed runs forgotten' : undefined}>
              {busy === 'resume' ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />} Resume
            </Button>
          )}
          <Button className={ACTION} onClick={() => setEditing(true)} disabled={busy !== null}>
            <Pencil className="h-4 w-4" /> Edit
          </Button>
          {mine && ai.enabled && (
            <Button className={ACTION} onClick={() => ai.compose(editInChatText(a))} data-tip="Opens the assistant in a new conversation about this automation: its queries change there">
              <Sparkles className="h-4 w-4" /> Edit in chat
            </Button>
          )}
          <Button variant="ghost" className={cn(ACTION, 'hover:text-rose-600')} onClick={() => setRemoving(true)} disabled={busy !== null}>
            <Trash2 className="h-4 w-4" /> Delete
          </Button>
        </div>
        <ErrorList lines={problems} />
      </header>

      <StateNotice a={a} onResume={() => void resume()} busy={busy !== null} />

      {test && <TestResult a={a} test={test} timeZone={factoryTimeZone} onClose={() => setTest(null)} />}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card className="space-y-3 p-4">
          <h2 className="flex items-center gap-2 text-sm font-bold">
            <Zap className="h-4 w-4 text-muted" /> What it does
          </h2>
          <p className="text-13 leading-relaxed text-slate-700 dark:text-slate-200">{summary}</p>
          <DefinitionFacts def={a} recipients={a.recipients} assignee={a.assignee} />
          <dl className="grid grid-cols-1 gap-2 border-t border-slate-100 pt-3 text-13 dark:border-slate-800 sm:grid-cols-3">
            <Figure label="Next run" icon={<CalendarClock className="h-4 w-4" />}>
              {a.nextRunAt ? (
                <time dateTime={a.nextRunAt} data-tip={factoryTimestamp(a.nextRunAt, factoryTimeZone)}>
                  {factoryMoment(a.nextRunAt, factoryTimeZone)}
                </time>
              ) : (
                <span className="text-muted">{noNextRunText(status)}</span>
              )}
            </Figure>
            <Figure label="Last run" icon={a.lastRunOk === false ? <OctagonX className="h-4 w-4 text-rose-600 dark:text-rose-400" /> : <CheckCircle2 className="h-4 w-4" />}>
              {a.lastRunAt ? (
                <time dateTime={a.lastRunAt} data-tip={factoryTimestamp(a.lastRunAt, factoryTimeZone)}>
                  {factoryMoment(a.lastRunAt, factoryTimeZone)}
                  {a.lastRunOk === false && <span className="text-rose-700 dark:text-rose-300"> · failed</span>}
                </time>
              ) : (
                <span className="text-muted">Never</span>
              )}
            </Figure>
            <Figure label="Open follow-ups" icon={<ListChecks className="h-4 w-4" />}>
              {a.openFollowUps > 0 ? (
                <Link to={`/follow-ups?automationId=${encodeURIComponent(a.id)}`} className="inline-flex items-center font-semibold text-brand-700 hover:underline dark:text-brand-300 touch:min-h-[44px]">
                  {a.openFollowUps.toLocaleString()} open
                </Link>
              ) : (
                <span className="text-muted">None</span>
              )}
            </Figure>
          </dl>
          {a.conversationId && ai.enabled && (
            <button type="button" onClick={openConversation} className="inline-flex min-h-[40px] items-center gap-1.5 text-xs font-semibold text-brand-700 hover:underline dark:text-brand-300">
              <MessageSquareText className="h-3.5 w-3.5" /> Open the conversation it was proposed in
            </button>
          )}
        </Card>

        <Definition a={a} canChat={mine && ai.enabled} onEditInChat={() => ai.compose(editInChatText(a))} />
      </div>

      <RunHistory a={a} timeZone={factoryTimeZone} />

      {editing && (
        <AutomationEditor
          base={a}
          knownRecipients={a.recipients}
          knownAssignee={a.assignee}
          creatorName={a.creator.name}
          columns={columns}
          title={a.name}
          subtitle={a.kind === 'watch' ? 'A watch: its words, people, actions and interval.' : 'A scheduled report: its words, people, timing and summary.'}
          saveLabel="Save changes"
          footnote={
            <>
              Its queries change only through the assistant{mine && ai.enabled ? ': use Edit in chat.' : '.'} A change is checked again before it is kept, and is in the audit log.
            </>
          }
          onSave={async (edits) => {
            if (Object.keys(edits).length > 0) {
              await updateAutomation(qc, a.id, edits)
              toast('Saved. The change is in the audit log.', 'success')
            }
            setEditing(false)
          }}
          onClose={() => setEditing(false)}
        />
      )}

      {removing && (
        <Modal
          open
          onClose={() => busy !== 'delete' && setRemoving(false)}
          size="sm"
          title="Delete this automation?"
          footer={
            <>
              <Button onClick={() => setRemoving(false)} disabled={busy === 'delete'}>
                Keep it
              </Button>
              <Button variant="danger" onClick={() => void remove()} disabled={busy === 'delete'}>
                {busy === 'delete' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />} Delete
              </Button>
            </>
          }
        >
          <p className="text-sm text-slate-600 dark:text-slate-300">
            <bdi dir="auto" className="font-semibold text-slate-800 dark:text-slate-100">
              “{a.name}”
            </bdi>{' '}
            stops at once and leaves the list. Its follow-ups, its run history and the reports it sent stay. The change is in the audit log.
          </p>
        </Modal>
      )}
    </>
  )
}

function Figure({ label, icon, children }: { label: string; icon: ReactNode; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wide text-muted">
        <span aria-hidden>{icon}</span>
        {label}
      </dt>
      <dd className="mt-0.5 tabular-nums">{children}</dd>
    </div>
  )
}

/** Why it is not running as set, when it is not: stopped by failures, paused, or blocked by its creator's access. */
function StateNotice({ a, onResume, busy }: { a: Automation; onResume: () => void; busy: boolean }) {
  const resume = (
    <Button className="h-8 min-h-0 px-3 py-0 text-xs touch:h-11" onClick={onResume} disabled={busy}>
      <RefreshCw className="h-3.5 w-3.5" /> Resume
    </Button>
  )
  if (a.status === 'failed') {
    // The server's note says it whole ("Stopped after 5 failed runs in a row. The last one: …"): said once.
    const why = a.statusNote ? stoppedText(a.statusNote) : `Stopped after failing ${a.consecutiveFailures > 0 ? `${a.consecutiveFailures} runs` : 'runs'} in a row.`
    return (
      <Notice tone="red" action={resume}>
        <span dir="auto">{why}</span> Resume it once the cause is put right — or ask the assistant to change its query.
      </Notice>
    )
  }
  if (a.status === 'paused') return <Notice tone="neutral" action={resume}>Paused: it does not run until it is resumed.</Notice>
  if (a.blockedReason) return <Notice tone="amber">{BLOCKED_TEXT[a.blockedReason]} It does not run meanwhile, and resumes by itself once this is put right.</Notice>
  if (a.consecutiveFailures > 0) return <Notice tone="amber">Its last {a.consecutiveFailures === 1 ? 'run' : `${a.consecutiveFailures} runs`} failed; it stops itself after five in a row. The run history says why.</Notice>
  return null
}

/** Its queries, as they run: read-only here. */
function Definition({ a, canChat, onEditInChat }: { a: Automation; canChat: boolean; onEditInChat: () => void }) {
  const { toast } = useApp()
  const copy = async (sql: string) => {
    try {
      await navigator.clipboard.writeText(sql)
      toast('SQL copied.', 'success')
    } catch {
      toast('Could not copy — select the SQL and copy it by hand.', 'error')
    }
  }
  const w = a.watch
  const s = a.schedule
  return (
    <Card className="space-y-3 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-sm font-bold">
          <FileChartColumn className="h-4 w-4 text-muted" /> {a.kind === 'watch' ? 'Its query' : 'Its sections'}
        </h2>
        {canChat && (
          <button type="button" onClick={onEditInChat} className="inline-flex min-h-[40px] items-center gap-1.5 text-xs font-semibold text-brand-700 hover:underline dark:text-brand-300">
            <Sparkles className="h-3.5 w-3.5" /> Edit in chat
          </button>
        )}
      </div>
      <p className="text-xs text-muted">Read-only here: the queries change only through the assistant. They run with {a.kind === 'watch' ? 'its' : 'their'} creator's data, as it stands at each run.</p>
      {w && (
        <>
          <AiCode label="SQL" onCopy={() => void copy(w.sql)} copyLabel="Copy the SQL" className="rounded-lg" codeClassName="max-h-72 p-2.5 text-[11px]">
            {w.sql}
          </AiCode>
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
            <dt className="font-semibold text-muted">A case is</dt>
            <dd>
              one value of <code className="font-mono">{w.keyColumn}</code>
            </dd>
            <dt className="font-semibold text-muted">Title</dt>
            <dd dir="auto" className="break-words font-mono">
              {w.titleTemplate}
            </dd>
            {w.bodyTemplate && (
              <>
                <dt className="font-semibold text-muted">Body</dt>
                <dd dir="auto" className="break-words font-mono">
                  {w.bodyTemplate}
                </dd>
              </>
            )}
            {(w.sessionColumn || w.sampleColumn || w.orderColumn) && (
              <>
                <dt className="font-semibold text-muted">Links</dt>
                <dd className="flex flex-wrap gap-x-3">
                  {w.sessionColumn && (
                    <span>
                      session <code className="font-mono">{w.sessionColumn}</code>
                    </span>
                  )}
                  {w.sampleColumn && (
                    <span>
                      sample <code className="font-mono">{w.sampleColumn}</code>
                    </span>
                  )}
                  {w.orderColumn && (
                    <span>
                      order <code className="font-mono">{w.orderColumn}</code>
                    </span>
                  )}
                </dd>
              </>
            )}
          </dl>
          <p className="text-[11px] text-muted">
            <code dir="ltr" className="font-mono">{'{{column}}'}</code> in the title and body is filled from each case's row.
          </p>
        </>
      )}
      {s &&
        s.sections.map((section, i) => (
          <div key={i} className="space-y-1">
            <h3 dir="auto" className="text-13 font-semibold">
              {i + 1}. {section.title}
            </h3>
            <AiCode label="SQL" onCopy={() => void copy(section.sql)} copyLabel={`Copy the SQL of section ${i + 1}`} className="rounded-lg" codeClassName="max-h-56 p-2.5 text-[11px]">
              {section.sql}
            </AiCode>
          </div>
        ))}
      {s?.period && /\{\{(from|to)\}\}/.test(s.sections.map((x) => x.sql).join('\n')) && (
        <p className="text-[11px] text-muted">
          <code dir="ltr" className="font-mono">{'{{from}}'}</code> and <code dir="ltr" className="font-mono">{'{{to}}'}</code> stand for the first and last day of the period it covers.
        </p>
      )}
    </Card>
  )
}

/** A dry run's result: what it would find now and whom it would tell. */
function TestResult({ a, test, timeZone, onClose }: { a: Automation; test: AutomationTestResponse; timeZone: string; onClose: () => void }) {
  return (
    <Card className="space-y-3 border-s-4 border-s-brand-500 p-4" role="region" aria-label="Test run">
      <div className="flex items-start gap-2">
        <FlaskConical className="mt-0.5 h-4 w-4 shrink-0 text-brand-600 dark:text-brand-300" />
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-bold">Test run · nothing was sent or recorded</h2>
          <p className="text-xs text-muted">
            <time dateTime={test.ranAt} data-tip={factoryTimestamp(test.ranAt, timeZone)}>
              {factoryMoment(test.ranAt, timeZone)}
            </time>
            {test.period && <> · over {periodText(test.period)}</>}
          </p>
        </div>
        <button type="button" onClick={onClose} className="icon-btn h-9 w-9 touch:h-11 touch:w-11" aria-label="Close the test run">
          <X className="h-4 w-4" />
        </button>
      </div>
      <p role="status" className={cn('text-13 font-semibold', test.ok ? 'text-slate-800 dark:text-slate-100' : 'text-rose-700 dark:text-rose-300')}>
        {testSummary(test, a.kind)}
      </p>
      {a.kind === 'watch' && test.ok && test.columns && test.sampleRows && test.sampleRows.length > 0 && (
        <CasesTable title="Cases matching now" columns={test.columns} rows={test.sampleRows} more={(test.matched ?? 0) > test.sampleRows.length || !!test.truncated} />
      )}
      {a.kind === 'watch' && <NotificationPreview title={test.sampleTitle} body={test.sampleBody} label="What a notification says (the first case)" />}
      {a.kind === 'report' && test.sections && <SectionsPreview sections={test.sections} />}
      {a.kind === 'report' && test.recipients !== undefined && <p className="text-xs text-muted">It would go to {test.recipients === 1 ? '1 person' : `${test.recipients.toLocaleString()} people`} now.</p>}
    </Card>
  )
}

const TRIGGER_LABEL: Record<AutomationRun['trigger'], string> = { schedule: 'On schedule', manual: 'Run now' }

/** "850 ms", "4.2 s", "1 min 5 s". */
function took(ms: number | undefined): string {
  if (ms === undefined) return '—'
  if (ms < 1000) return `${ms} ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`
  return `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`
}

/** Every run, newest first, a page at a time. */
function RunHistory({ a, timeZone }: { a: Automation; timeZone: string }) {
  const runs = useAutomationRuns(a.id)
  const rows = useMemo(() => runs.data?.pages.flatMap((p) => p.runs) ?? [], [runs.data])
  const view = useTableView(rows, [
    { key: 'started', value: (r) => factoryMoment(r.startedAt, timeZone), sortValue: (r) => Date.parse(r.startedAt), numeric: true },
    { key: 'trigger', value: (r) => TRIGGER_LABEL[r.trigger] },
    { key: 'outcome', value: (r) => runOutcome(r).label },
    { key: 'figures', value: (r) => runFigures(r, a.kind), noValues: true },
    { key: 'note', value: (r) => r.error ?? r.note ?? '', noValues: true },
  ])

  return (
    <Card className="overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-4 py-3 dark:border-slate-800">
        <h2 className="text-sm font-bold">Run history</h2>
        <span className="text-xs text-muted">Factory time · kept for every run</span>
      </div>
      {runs.isLoading ? (
        <p className="flex items-center justify-center gap-2 px-4 py-8 text-sm text-muted">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading…
        </p>
      ) : runs.isError && rows.length === 0 ? (
        <div className="p-4">
          <Notice tone="red" action={<Button className="h-8 min-h-0 px-3 py-0 text-xs touch:h-11" onClick={() => void runs.refetch()}>Try again</Button>}>
            The run history could not be loaded.
          </Notice>
        </div>
      ) : rows.length === 0 ? (
        <p className="px-4 py-8 text-center text-sm text-muted">It has not run yet.</p>
      ) : (
        <>
          {/* Phone: a line each. */}
          <ul className="divide-y divide-slate-100 md:hidden dark:divide-slate-800">
            {view.rows.map((r) => (
              <li key={r.id} className="space-y-1 px-4 py-3">
                <RunHead r={r} timeZone={timeZone} />
                <p className="text-xs text-slate-600 dark:text-slate-300">{runFigures(r, a.kind) || '—'}</p>
                <RunNote r={r} />
              </li>
            ))}
          </ul>
          <div className="hidden overflow-x-auto md:block">
            <table className="w-full min-w-[48rem] text-sm">
              <thead className="bg-slate-50 text-left text-[11px] uppercase tracking-wide text-muted dark:bg-slate-800/60">
                <tr>
                  <ViewTh view={view} column="started" label="Started" className="px-3 py-2 font-semibold" />
                  <ViewTh view={view} column="trigger" label="How" className="px-3 py-2 font-semibold" />
                  <ViewTh view={view} column="outcome" label="Outcome" className="px-3 py-2 font-semibold" />
                  <th className="px-3 py-2 text-right font-semibold">Took</th>
                  <ViewTh view={view} column="figures" label="Found and sent" className="px-3 py-2 font-semibold" />
                  <ViewTh view={view} column="note" label="Notes" className="px-3 py-2 font-semibold" />
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {view.rows.map((r) => {
                  const o = runOutcome(r)
                  return (
                    <tr key={r.id} className="data-row align-top">
                      <td className="whitespace-nowrap px-3 py-2 tabular-nums">
                        <time dateTime={r.startedAt} data-tip={factoryTimestamp(r.startedAt, timeZone)}>
                          {factoryMoment(r.startedAt, timeZone)}
                        </time>
                      </td>
                      <td className="whitespace-nowrap px-3 py-2 text-muted">{TRIGGER_LABEL[r.trigger]}</td>
                      <td className="px-3 py-2">
                        <Badge tone={o.tone}>{o.label}</Badge>
                      </td>
                      <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums text-muted">{took(r.ms)}</td>
                      <td className="px-3 py-2 tabular-nums">
                        {runFigures(r, a.kind) || <span className="text-muted">—</span>}
                        {r.deliveryId && (
                          <Link to={`/automations/deliveries/${encodeURIComponent(r.deliveryId)}`} className="ms-2 inline-flex items-center whitespace-nowrap text-xs font-semibold text-brand-700 hover:underline dark:text-brand-300 touch:min-h-[44px]">
                            Open the report
                          </Link>
                        )}
                      </td>
                      <td className="max-w-[24rem] px-3 py-2">
                        <RunNote r={r} />
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
            <ViewNote view={view} total={rows.length} />
          </div>
          {runs.hasNextPage && (
            <div className="border-t border-slate-100 px-4 py-2.5 dark:border-slate-800">
              <button type="button" onClick={() => void runs.fetchNextPage()} disabled={runs.isFetchingNextPage} className="btn-secondary h-8 min-h-0 px-3 py-0 text-13 touch:h-11">
                {runs.isFetchingNextPage ? 'Loading…' : 'Show older runs'}
              </button>
            </div>
          )}
        </>
      )}
    </Card>
  )
}

function RunHead({ r, timeZone }: { r: AutomationRun; timeZone: string }) {
  const o = runOutcome(r)
  return (
    <p className="flex flex-wrap items-center gap-2 text-13">
      <Badge tone={o.tone}>{o.label}</Badge>
      <time dateTime={r.startedAt} className="font-semibold tabular-nums" data-tip={factoryTimestamp(r.startedAt, timeZone)}>
        {factoryMoment(r.startedAt, timeZone)}
      </time>
      <span className="text-xs text-muted">
        {TRIGGER_LABEL[r.trigger]} · {took(r.ms)}
      </span>
      {r.deliveryId && (
        <Link to={`/automations/deliveries/${encodeURIComponent(r.deliveryId)}`} className="inline-flex items-center text-xs font-semibold text-brand-700 hover:underline dark:text-brand-300 touch:min-h-[44px]">
          Open the report
        </Link>
      )}
    </p>
  )
}

/** Why a run failed, or a word on anything it left out. */
function RunNote({ r }: { r: AutomationRun }) {
  if (!r.error && !r.note) return null
  return (
    <p dir="auto" className={cn('whitespace-pre-wrap break-words text-xs', r.error ? 'text-rose-700 dark:text-rose-300' : 'text-muted')}>
      {r.error ?? r.note}
      {r.error && r.note && <span className="block text-muted">{r.note}</span>}
    </p>
  )
}
