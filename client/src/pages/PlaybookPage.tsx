// ============================================================================
// The assistant's playbook: what it follows in every new conversation. The
// person's own instructions and the conclusions they kept, and the
// instructions the assistant's owner sets for everyone (which the owner
// alone adds, changes or removes here). Each entry says when and where it
// was saved — on this page, or by the assistant in a conversation (a link
// takes the person there). Opened from the book icon in the assistant's
// header, and from a playbook card in an answer.
// ============================================================================

import '@fontsource/ibm-plex-sans-arabic/arabic-400.css'
import '@fontsource/ibm-plex-sans-arabic/arabic-600.css'
import { useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { BookMarked, Check, Lightbulb, Loader2, MessageSquare, Pencil, Plus, Trash2, Users, X } from 'lucide-react'
import { PLAYBOOK_BASIS_MAX, PLAYBOOK_MAX_PERSONAL, PLAYBOOK_MAX_SHARED, PLAYBOOK_TEXT_MAX, type PlaybookEntry, type PlaybookKind, type PlaybookScope } from '@qc/shared/playbook'
import { Button, Card, Modal } from '@/components/ui'
import { aiWorkspaceHref } from '@/components/ai/workspace'
import { ApiError } from '@/lib/api'
import { cn, formatDateTime, formatFullTimestamp } from '@/lib/utils'
import { addPlaybookEntry, changePlaybookEntry, removePlaybookEntry, usePlaybook } from '@/services/playbook'
import { useApp } from '@/store/AppContext'

interface Group {
  key: string
  scope: PlaybookScope
  kind: PlaybookKind
  title: string
  icon: ReactNode
  hint: string
  empty: string
  placeholder: string
}

const GROUPS: Group[] = [
  {
    key: 'shared',
    scope: 'shared',
    kind: 'instruction',
    title: 'For everyone',
    icon: <Users className="h-4 w-4" />,
    hint: "Set by the assistant's owner and followed for everyone given the assistant. Only instructions: a conclusion comes from data its person may read, which others may not.",
    empty: 'No instructions for everyone yet.',
    placeholder: 'e.g. Call coils by their heat number, and orders by their number.',
  },
  {
    key: 'instructions',
    scope: 'personal',
    kind: 'instruction',
    title: 'Your instructions',
    icon: <BookMarked className="h-4 w-4" />,
    hint: 'How the assistant should work and answer for you, in every new conversation.',
    empty: 'No instructions yet. Add one here, or tell the assistant "from now on…" in a chat.',
    placeholder: 'e.g. Always give rates as %, with last month beside them.',
  },
  {
    key: 'conclusions',
    scope: 'personal',
    kind: 'conclusion',
    title: 'Your conclusions',
    icon: <Lightbulb className="h-4 w-4" />,
    hint: 'What you established from the data, kept for the assistant to bear in mind. It checks them against the data when an answer rests on one.',
    empty: 'No conclusions yet. After an analysis, tell the assistant "keep this conclusion".',
    placeholder: 'e.g. Machine 58 makes most of its defects on the night shift.',
  },
]

export function PlaybookPage() {
  const { data, isLoading, isError, refetch } = usePlaybook()
  const entries = data?.entries ?? []
  const personal = entries.filter((e) => e.scope === 'personal').length
  const shared = entries.filter((e) => e.scope === 'shared').length
  const groups = GROUPS.filter((g) => g.scope === 'personal' || shared > 0 || data?.mayShare)

  return (
    <div className="ai-type mx-auto w-full max-w-3xl space-y-4">
      <header className="flex flex-wrap items-center gap-3">
        <span className="grid h-10 w-10 place-items-center rounded-xl bg-violet-50 text-violet-700 dark:bg-violet-500/15 dark:text-violet-300">
          <BookMarked className="h-5 w-5" />
        </span>
        <div className="min-w-0 flex-1">
          <h1 className="text-2xl font-extrabold tracking-tight">Playbook</h1>
          <p className="text-13 text-muted">
            What the AI assistant follows in every new conversation
            {data ? ` · ${personal} of ${PLAYBOOK_MAX_PERSONAL} yours` : ''}
          </p>
        </div>
      </header>

      <Card className="p-3 text-13 text-slate-600 dark:text-slate-300">
        Tell the assistant in a chat — “remember that…”, “from now on…”, “keep this conclusion” — or add entries here. A change applies to the conversations started after it.
      </Card>

      {isLoading && (
        <p className="flex items-center gap-2 text-sm text-muted">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading the playbook…
        </p>
      )}
      {isError && !data && (
        <Card className="p-4 text-sm text-rose-700 dark:text-rose-300">
          The playbook could not be loaded.{' '}
          <button type="button" onClick={() => void refetch()} className="font-semibold underline">
            Try again
          </button>
        </Card>
      )}
      {data &&
        groups.map((g) => (
          <GroupSection
            key={g.key}
            group={g}
            entries={entries.filter((e) => e.scope === g.scope && e.kind === g.kind)}
            mayAdd={g.scope === 'shared' ? data.mayShare && shared < PLAYBOOK_MAX_SHARED : personal < PLAYBOOK_MAX_PERSONAL}
            full={g.scope === 'shared' ? shared >= PLAYBOOK_MAX_SHARED : personal >= PLAYBOOK_MAX_PERSONAL}
            mayEditGroup={g.scope === 'personal' || data.mayShare}
          />
        ))}
    </div>
  )
}

function GroupSection({ group: g, entries, mayAdd, full, mayEditGroup }: { group: Group; entries: PlaybookEntry[]; mayAdd: boolean; full: boolean; mayEditGroup: boolean }) {
  const qc = useQueryClient()
  const { toast } = useApp()
  const [adding, setAdding] = useState(false)

  const save = async (text: string, basis: string) => {
    await addPlaybookEntry(qc, {
      scope: g.scope,
      kind: g.kind,
      text,
      ...(g.kind === 'conclusion' ? { basis } : {}),
    })
    toast(g.scope === 'shared' ? 'Saved for everyone.' : 'Saved to your playbook.', 'success')
    setAdding(false)
  }

  return (
    <Card className="overflow-hidden">
      <header className="flex flex-wrap items-start gap-2 border-b border-slate-100 px-4 py-3 dark:border-slate-800">
        <span className="mt-0.5 text-violet-700 dark:text-violet-300">{g.icon}</span>
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-bold">
            {g.title} <span className="font-normal text-muted">· {entries.length}</span>
          </h2>
          <p className="text-xs text-muted">{g.hint}</p>
        </div>
        {mayEditGroup && !adding && (
          <Button onClick={() => setAdding(true)} disabled={!mayAdd} className="min-h-[40px] touch:min-h-[44px]" data-tip={full ? 'Full: remove or merge an entry first.' : undefined}>
            <Plus className="h-4 w-4" /> Add
          </Button>
        )}
      </header>
      {adding && (
        <div className="border-b border-slate-100 bg-violet-50/40 px-4 py-3 dark:border-slate-800 dark:bg-violet-500/5">
          <EntryForm kind={g.kind} placeholder={g.placeholder} onSave={save} onCancel={() => setAdding(false)} />
        </div>
      )}
      {entries.length === 0 && !adding ? (
        <p className="px-4 py-5 text-13 text-muted">{g.empty}</p>
      ) : (
        <ul className="divide-y divide-slate-100 dark:divide-slate-800">
          {entries.map((e) => (
            <EntryRow key={e.id} entry={e} placeholder={g.placeholder} />
          ))}
        </ul>
      )}
    </Card>
  )
}

function EntryRow({ entry: e, placeholder }: { entry: PlaybookEntry; placeholder: string }) {
  const qc = useQueryClient()
  const { toast } = useApp()
  const [editing, setEditing] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)

  const save = async (text: string, basis: string) => {
    await changePlaybookEntry(qc, e.id, {
      text,
      ...(e.kind === 'conclusion' ? { basis } : {}),
    })
    toast('Changed.', 'success')
    setEditing(false)
  }
  const remove = async () => {
    setBusy(true)
    try {
      await removePlaybookEntry(qc, e.id)
      toast('Removed from the playbook.', 'success')
      setConfirming(false)
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'It could not be removed. Try again.', 'error')
    } finally {
      setBusy(false)
    }
  }

  if (editing) {
    return (
      <li className="bg-violet-50/40 px-4 py-3 dark:bg-violet-500/5">
        <EntryForm kind={e.kind} placeholder={placeholder} initialText={e.text} initialBasis={e.basis} onSave={save} onCancel={() => setEditing(false)} />
      </li>
    )
  }
  return (
    <li className="flex items-start gap-3 px-4 py-3">
      <div className="min-w-0 flex-1">
        <p dir="auto" className="whitespace-pre-wrap break-words text-sm text-slate-800 dark:text-slate-100">
          {e.text}
        </p>
        {e.basis && (
          <p dir="auto" className="mt-0.5 break-words text-xs text-muted">
            Basis: {e.basis}
          </p>
        )}
        <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted">
          <time dateTime={e.updatedAt} data-tip={formatFullTimestamp(e.updatedAt)}>
            {e.updatedAt !== e.createdAt ? 'Changed' : 'Saved'} {formatDateTime(e.updatedAt)}
          </time>
          {e.scope === 'shared' && <span>· by {e.createdByName}</span>}
          {e.source === 'assistant' ? (
            e.conversationId ? (
              <>
                <span aria-hidden>·</span>
                <Link to={aiWorkspaceHref({ conversationId: e.conversationId })} className="inline-flex items-center gap-1 font-semibold text-brand-700 hover:underline dark:text-brand-300">
                  <MessageSquare className="h-3 w-3" /> by the assistant, in a conversation
                </Link>
              </>
            ) : (
              <span>· by the assistant</span>
            )
          ) : (
            <span>· on this page</span>
          )}
        </p>
      </div>
      {e.mayEdit && (
        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="grid h-9 w-9 place-items-center rounded-lg text-muted hover:bg-slate-100 hover:text-slate-800 dark:hover:bg-slate-800 dark:hover:text-slate-100 touch:h-11 touch:w-11"
            aria-label="Change"
            data-tip="Change"
          >
            <Pencil className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={() => setConfirming(true)}
            className="grid h-9 w-9 place-items-center rounded-lg text-muted hover:bg-rose-50 hover:text-rose-700 dark:hover:bg-rose-500/10 dark:hover:text-rose-300 touch:h-11 touch:w-11"
            aria-label="Remove"
            data-tip="Remove"
          >
            <Trash2 className="h-4 w-4" />
          </button>
        </div>
      )}
      {confirming && (
        <Modal
          open
          onClose={() => !busy && setConfirming(false)}
          size="sm"
          title="Remove from the playbook?"
          footer={
            <>
              <Button onClick={() => setConfirming(false)} disabled={busy}>
                Keep it
              </Button>
              <Button variant="danger" onClick={() => void remove()} disabled={busy}>
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />} Remove
              </Button>
            </>
          }
        >
          <p dir="auto" className="whitespace-pre-wrap break-words text-sm text-slate-700 dark:text-slate-200">
            {e.text}
          </p>
          <p className="mt-2 text-xs text-muted">The assistant stops following it in conversations started from now on.</p>
        </Modal>
      )}
    </li>
  )
}

function EntryForm({
  kind,
  placeholder,
  initialText = '',
  initialBasis = '',
  onSave,
  onCancel,
}: {
  kind: PlaybookKind
  placeholder: string
  initialText?: string
  initialBasis?: string
  onSave: (text: string, basis: string) => Promise<void>
  onCancel: () => void
}) {
  const [text, setText] = useState(initialText)
  const [basis, setBasis] = useState(initialBasis)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const ready = text.trim() !== '' && !busy

  const submit = async () => {
    if (!ready) return
    setBusy(true)
    setProblem(null)
    try {
      await onSave(text.trim(), basis.trim())
    } catch (e) {
      setProblem(e instanceof ApiError ? e.message : 'It could not be saved. Try again.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-2">
      <label className="block">
        <span className="sr-only">{kind === 'instruction' ? 'Instruction' : 'Conclusion'}</span>
        <textarea dir="auto" value={text} onChange={(e) => setText(e.target.value)} maxLength={PLAYBOOK_TEXT_MAX} rows={2} className="input min-h-[64px] resize-y py-2" placeholder={placeholder} autoFocus />
        <span className={cn('mt-0.5 block text-end text-[11px]', text.length > PLAYBOOK_TEXT_MAX - 50 ? 'text-amber-700 dark:text-amber-300' : 'text-muted')}>
          {text.length} / {PLAYBOOK_TEXT_MAX}
        </span>
      </label>
      {kind === 'conclusion' && (
        <label className="block">
          <span className="label">Basis (optional): the data, the period, the key figures</span>
          <input dir="auto" value={basis} onChange={(e) => setBasis(e.target.value)} maxLength={PLAYBOOK_BASIS_MAX} className="input" placeholder="e.g. Inspections Sep 2026: 61% of 412 defects at night" />
        </label>
      )}
      {problem && (
        <p role="alert" dir="auto" className="text-13 text-rose-700 dark:text-rose-300">
          {problem}
        </p>
      )}
      <div className="flex items-center gap-2">
        <Button variant="primary" onClick={() => void submit()} disabled={!ready} className="min-h-[40px] touch:min-h-[44px]">
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />} Save
        </Button>
        <Button variant="ghost" onClick={onCancel} disabled={busy} className="min-h-[40px] touch:min-h-[44px]">
          <X className="h-4 w-4" /> Cancel
        </Button>
      </div>
    </div>
  )
}
