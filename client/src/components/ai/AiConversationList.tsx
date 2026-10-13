// ============================================================================
// §20 — this person's conversations with the assistant, kept in order:
//
//   • Pinned — the ones they pinned, the latest pinned on top;
//   • Groups — their groups by name, each opened in place (remembered on
//     this device) with its conversations, pinned ones included;
//   • Recent — the rest, the latest first, page after page;
//   • Archived — out of the way, a view of its own; asking in one brings it
//     back.
//
// Each conversation's menu pins it, renames it, moves it to a group (a new
// one too), archives it or deletes it. The search reads every conversation
// on the server, archived ones too — titles, questions and answers — and
// shows the words around what it found.
// ============================================================================

import { useCallback, useMemo, useRef, useState, type ReactNode } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Archive, ArrowLeft, ChevronRight, Folder, FolderOpen, FolderPlus, Loader2, MessageSquarePlus, MoreHorizontal, Pencil, Search, Trash2 } from 'lucide-react'
import {
  AI_CONVERSATION_GROUP_NAME_MAX,
  AI_CONVERSATION_SEARCH_MIN,
  AI_CONVERSATION_TITLE_MAX,
  type AiConversation,
  type AiConversationGroup,
  type AiConversationScope,
  type AiConversationSearchHit,
} from '@qc/shared/ai'
import { Badge, Button, Input, Modal } from '@/components/ui'
import { FloatingPanel } from '@/components/dashboard/filters'
import { cn } from '@/lib/utils'
import { createAiConversationGroup, deleteAiConversation, deleteAiConversationGroup, renameAiConversationGroup, updateAiConversation } from '@/services/mutations'
import { useAiConversationGroups, useAiConversationList, useAiConversationSearch, useAiPinnedConversations, useDebounced } from '@/services/queries'
import { useApp } from '@/store/AppContext'
import { useAi, useAiLive } from './AiAssistantProvider'
import { AiConversationRow, MenuItem, type ConversationActions } from './AiConversationRow'
import { isInFlight } from './liveTurn'

/** The groups opened in the list, remembered on this device. */
const OPEN_GROUPS_KEY = 'qc-ai-open-groups'

function readOpenGroups(): Set<string> {
  try {
    const raw = localStorage.getItem(OPEN_GROUPS_KEY)
    const ids: unknown = raw ? JSON.parse(raw) : []
    return new Set(Array.isArray(ids) ? ids.filter((x): x is string => typeof x === 'string') : [])
  } catch {
    return new Set()
  }
}

function writeOpenGroups(ids: ReadonlySet<string>): void {
  try {
    localStorage.setItem(OPEN_GROUPS_KEY, JSON.stringify([...ids]))
  } catch {
    // A private window or blocked storage: the groups open again closed next time.
  }
}

/** Characters as a person counts them: an emoji is one. */
const charCount = (s: string) => Array.from(s).length

/** A name or a title as the server keeps it: on one line. */
const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim()

/** What a dialog asking for a name is for. */
type NameAsk =
  | { kind: 'rename'; conversation: AiConversation }
  | { kind: 'new-group'; moving: AiConversation | null }
  | { kind: 'rename-group'; group: AiConversationGroup }

/** What the rows of every list share. */
interface RowContext {
  activeId: string | null
  writingIn: string | undefined
  groups: readonly AiConversationGroup[]
  actions: ConversationActions
  onOpen: (c: AiConversation) => void
}

/**
 * `onNew`: a New chat button beside the search, where the surface has none of
 * its own in view (the full page's header has one; there the search takes
 * the whole width of its column).
 */
export function AiConversationList({ onPicked, onNew }: { onPicked: () => void; onNew?: () => void }) {
  const qc = useQueryClient()
  const { toast } = useApp()
  const { conversationId, openConversation, enabled } = useAi()
  const live = useAiLive()
  const [term, setTerm] = useState('')
  const [view, setView] = useState<'list' | 'archived'>('list')
  const [openGroups, setOpenGroups] = useState<Set<string>>(readOpenGroups)
  const [asking, setAsking] = useState<NameAsk | null>(null)
  const [removing, setRemoving] = useState<AiConversation | null>(null)
  const [removingGroup, setRemovingGroup] = useState<AiConversationGroup | null>(null)
  const [busy, setBusy] = useState(false)

  const pinned = useAiPinnedConversations(enabled && view === 'list')
  const groupsQuery = useAiConversationGroups(enabled)
  const groups = useMemo(() => groupsQuery.data?.groups ?? [], [groupsQuery.data])
  const searching = charCount(term.trim()) >= AI_CONVERSATION_SEARCH_MIN
  const writingIn = isInFlight(live) ? live?.conversationId : undefined

  const fail = useCallback((e: unknown, fallback: string) => toast(e instanceof Error ? e.message : fallback, 'error'), [toast])

  const update = useCallback(
    async (c: AiConversation, change: Parameters<typeof updateAiConversation>[2], done?: string) => {
      try {
        await updateAiConversation(qc, c.id, change)
        if (done) toast(done, 'success')
      } catch (e) {
        fail(e, 'The conversation could not be changed. Try again.')
      }
    },
    [qc, toast, fail],
  )

  const actions = useMemo<ConversationActions>(
    () => ({
      setPinned: (c, pinned) => void update(c, { pinned }),
      rename: (c) => setAsking({ kind: 'rename', conversation: c }),
      move: (c, groupId) => void update(c, { groupId }, groupId ? `Moved to ${groups.find((g) => g.id === groupId)?.name ?? 'the group'}.` : 'Taken out of its group.'),
      moveToNewGroup: (c) => setAsking({ kind: 'new-group', moving: c }),
      setArchived: (c, archived) => void update(c, { archived }, archived ? 'Archived. It is under Archived at the end of the list.' : 'Back in your list.'),
      remove: (c) => setRemoving(c),
    }),
    [update, groups],
  )

  const onOpen = useCallback(
    (c: AiConversation) => {
      openConversation(c.id)
      onPicked()
    },
    [openConversation, onPicked],
  )

  const rows: RowContext = { activeId: conversationId ?? null, writingIn: writingIn ?? undefined, groups, actions, onOpen }

  const toggleGroup = (id: string) =>
    setOpenGroups((open) => {
      const next = new Set(open)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      writeOpenGroups(next)
      return next
    })

  const saveName = async (name: string) => {
    if (!asking) return
    setBusy(true)
    try {
      if (asking.kind === 'rename') {
        await updateAiConversation(qc, asking.conversation.id, { title: name })
      } else if (asking.kind === 'rename-group') {
        await renameAiConversationGroup(qc, asking.group.id, name)
      } else {
        const group = await createAiConversationGroup(qc, name)
        const opened = new Set(openGroups).add(group.id)
        writeOpenGroups(opened)
        setOpenGroups(opened)
        if (asking.moving) {
          await updateAiConversation(qc, asking.moving.id, { groupId: group.id })
          toast(`Moved to ${group.name}.`, 'success')
        }
      }
      setAsking(null)
    } catch (e) {
      fail(e, 'It could not be saved. Try again.')
    } finally {
      setBusy(false)
    }
  }

  const remove = async () => {
    if (!removing) return
    setBusy(true)
    try {
      await deleteAiConversation(qc, removing.id)
      if (conversationId === removing.id) openConversation(null)
      toast('Conversation deleted.', 'success')
      setRemoving(null)
    } catch (e) {
      fail(e, 'Could not delete the conversation.')
    } finally {
      setBusy(false)
    }
  }

  const removeGroup = async () => {
    if (!removingGroup) return
    setBusy(true)
    try {
      await deleteAiConversationGroup(qc, removingGroup.id)
      toast('Group removed. Its conversations are back in your list.', 'success')
      setRemovingGroup(null)
    } catch (e) {
      fail(e, 'The group could not be removed. Try again.')
    } finally {
      setBusy(false)
    }
  }

  const pinnedList = pinned.data?.conversations ?? []

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 px-3 pb-2 pt-3">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
          <Input value={term} onChange={(e) => setTerm(e.target.value)} placeholder="Search titles, questions and answers" className="rounded-full ps-9" aria-label="Search your conversations" dir="auto" type="search" />
        </div>
        {onNew && (
          <button type="button" onClick={onNew} className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-brand-600 text-white shadow-card hover:bg-brand-700 touch:h-11 touch:w-11" aria-label="New chat" data-tip="New chat">
            <MessageSquarePlus className="h-5 w-5" />
          </button>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 pb-3">
        {searching ? (
          <SearchResults term={term} rows={rows} />
        ) : view === 'archived' ? (
          <>
            <button type="button" onClick={() => setView('list')} className="mb-1 flex min-h-[40px] items-center gap-2 rounded-xl px-2.5 text-13 font-semibold text-brand-700 hover:bg-slate-100 dark:text-brand-300 dark:hover:bg-slate-800 touch:min-h-[44px]">
              <ArrowLeft className="h-4 w-4 rtl:rotate-180" /> All conversations
            </button>
            <SectionTitle>Archived</SectionTitle>
            <PagedConversations scope="archived" rows={rows} empty="Nothing archived. Archive a conversation from its menu to keep it out of the way." />
          </>
        ) : (
          <>
            {pinnedList.length > 0 && (
              <section aria-label="Pinned">
                <SectionTitle>Pinned</SectionTitle>
                <ul>
                  {pinnedList.map((c) => (
                    <Row key={c.id} c={c} rows={rows} />
                  ))}
                </ul>
              </section>
            )}

            <section aria-label="Groups" className={cn(pinnedList.length > 0 && 'mt-2')}>
              <div className="flex items-center gap-1 pe-1">
                <SectionTitle className="flex-1">Groups</SectionTitle>
                <button type="button" onClick={() => setAsking({ kind: 'new-group', moving: null })} className="icon-btn h-8 w-8 touch:h-11 touch:w-11" aria-label="New group" data-tip="New group">
                  <FolderPlus className="h-4 w-4" />
                </button>
              </div>
              {groups.length === 0 && !groupsQuery.isLoading && <p className="px-3 pb-1 text-xs text-muted">Put conversations that belong together in a group, from their menu (⋯) or with the folder button.</p>}
              <ul>
                {groups.map((g) => (
                  <GroupSection
                    key={g.id}
                    group={g}
                    open={openGroups.has(g.id)}
                    onToggle={() => toggleGroup(g.id)}
                    onRename={() => setAsking({ kind: 'rename-group', group: g })}
                    onRemove={() => setRemovingGroup(g)}
                    rows={rows}
                  />
                ))}
              </ul>
            </section>

            <section aria-label="Recent" className="mt-2">
              <SectionTitle>Recent</SectionTitle>
              <PagedConversations scope="recent" rows={rows} empty={pinnedList.length > 0 || groups.length > 0 ? 'Every conversation is pinned or in a group.' : 'No conversations yet. Ask a first question.'} />
            </section>

            <button type="button" onClick={() => setView('archived')} className="mt-2 flex min-h-[40px] w-full items-center gap-2 rounded-xl px-2.5 text-13 font-semibold text-muted hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-800 dark:hover:text-slate-200 touch:min-h-[44px]">
              <Archive className="h-4 w-4" /> Archived
              <ChevronRight className="ms-auto h-4 w-4 rtl:rotate-180" />
            </button>
          </>
        )}
      </div>

      {asking && (
        <NameDialog
          key={asking.kind === 'rename' ? asking.conversation.id : asking.kind === 'rename-group' ? asking.group.id : 'new'}
          title={asking.kind === 'rename' ? 'Rename the conversation' : asking.kind === 'rename-group' ? 'Rename the group' : asking.moving ? 'New group for this conversation' : 'New group'}
          label={asking.kind === 'rename' ? 'Title' : 'Group name'}
          initial={asking.kind === 'rename' ? asking.conversation.title : asking.kind === 'rename-group' ? asking.group.name : ''}
          max={asking.kind === 'rename' ? AI_CONVERSATION_TITLE_MAX : AI_CONVERSATION_GROUP_NAME_MAX}
          saveLabel={asking.kind === 'new-group' ? 'Make the group' : 'Save'}
          busy={busy}
          onSave={(name) => void saveName(name)}
          onClose={() => !busy && setAsking(null)}
        />
      )}

      {removing && (
        <Modal
          open
          onClose={() => !busy && setRemoving(null)}
          size="sm"
          title="Delete this conversation?"
          footer={
            <>
              <Button onClick={() => setRemoving(null)} disabled={busy}>
                Keep it
              </Button>
              <Button variant="danger" onClick={() => void remove()} disabled={busy}>
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />} Delete
              </Button>
            </>
          }
        >
          <p className="text-sm text-slate-600 dark:text-slate-300">
            <b dir="auto">{removing.title}</b>
            <br />
            It leaves your list. To keep it out of the way without deleting it, archive it instead.
          </p>
        </Modal>
      )}

      {removingGroup && (
        <Modal
          open
          onClose={() => !busy && setRemovingGroup(null)}
          size="sm"
          title="Remove this group?"
          footer={
            <>
              <Button onClick={() => setRemovingGroup(null)} disabled={busy}>
                Keep it
              </Button>
              <Button variant="danger" onClick={() => void removeGroup()} disabled={busy}>
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />} Remove the group
              </Button>
            </>
          }
        >
          <p className="text-sm text-slate-600 dark:text-slate-300">
            <b dir="auto">{removingGroup.name}</b>
            <br />
            Its {removingGroup.conversationCount === 1 ? 'conversation goes' : 'conversations go'} back to your list. None is deleted.
          </p>
        </Modal>
      )}
    </div>
  )
}

function SectionTitle({ children, className }: { children: ReactNode; className?: string }) {
  return <h3 className={cn('px-2.5 pb-1 pt-2 text-[11px] font-bold uppercase tracking-wide text-muted', className)}>{children}</h3>
}

function Row({ c, rows, below }: { c: AiConversation; rows: RowContext; below?: ReactNode }) {
  return <AiConversationRow conversation={c} active={c.id === rows.activeId} writing={c.id === rows.writingIn} groups={rows.groups} actions={rows.actions} onOpen={rows.onOpen} below={below} />
}

/** A scope of the list a page at a time, with "Older conversations" while there are more. */
function PagedConversations({ scope, groupId = null, rows, empty }: { scope: Exclude<AiConversationScope, 'pinned' | 'all'>; groupId?: string | null; rows: RowContext; empty: string }) {
  const { enabled } = useAi()
  const { data, isLoading, isError, refetch, hasNextPage, fetchNextPage, isFetchingNextPage } = useAiConversationList(scope, groupId, enabled)
  // A conversation is listed once, though a change between two pages moved it from one to the next.
  const list = useMemo(() => {
    const seen = new Set<string>()
    return (data?.pages ?? []).flatMap((p) => p.conversations).filter((c) => (seen.has(c.id) ? false : (seen.add(c.id), true)))
  }, [data])

  if (isLoading) {
    return (
      <ul aria-busy>
        <li className="sr-only" role="status">
          Loading your conversations…
        </li>
        {[0, 1, 2].map((i) => (
          <li key={i} aria-hidden className="flex items-center gap-3 px-2.5 py-2.5">
            <span className="skeleton h-9 w-9 shrink-0 rounded-full" />
            <span className="min-w-0 flex-1 space-y-1.5">
              <span className={cn('skeleton block h-3.5', i % 2 ? 'w-3/5' : 'w-4/5')} />
              <span className="skeleton block h-2.5 w-1/4" />
            </span>
          </li>
        ))}
      </ul>
    )
  }
  if (isError && !data) {
    return (
      <p className="px-3 py-4 text-center text-sm text-muted">
        These conversations could not be loaded.{' '}
        <button type="button" onClick={() => void refetch()} className="font-semibold text-brand-700 hover:underline dark:text-brand-300">
          Try again
        </button>
      </p>
    )
  }
  return (
    <>
      <ul>
        {list.map((c) => (
          <Row key={c.id} c={c} rows={rows} />
        ))}
      </ul>
      {list.length === 0 && <p className="px-3 py-3 text-xs text-muted">{empty}</p>}
      {hasNextPage && (
        <div className="flex justify-center pt-2">
          <button
            type="button"
            onClick={() => void fetchNextPage().catch(() => undefined)}
            disabled={isFetchingNextPage}
            className="rounded-full bg-white px-3 py-1.5 text-xs font-semibold text-muted shadow ring-1 ring-slate-200 hover:text-slate-700 dark:bg-slate-800 dark:ring-slate-700 dark:hover:text-slate-200 touch:min-h-[44px]"
          >
            {isFetchingNextPage ? 'Loading…' : 'Older conversations'}
          </button>
        </div>
      )}
    </>
  )
}

/** A group in the list: opened in place, its conversations read only then. */
function GroupSection({
  group: g,
  open,
  onToggle,
  onRename,
  onRemove,
  rows,
}: {
  group: AiConversationGroup
  open: boolean
  onToggle: () => void
  onRename: () => void
  onRemove: () => void
  rows: RowContext
}) {
  const anchor = useRef<HTMLButtonElement>(null)
  const [menu, setMenu] = useState(false)
  return (
    <li>
      <div className="group flex items-center gap-1 rounded-2xl pe-1 hover:bg-slate-100 dark:hover:bg-slate-800">
        <button type="button" onClick={onToggle} aria-expanded={open} className="flex min-h-[44px] min-w-0 flex-1 items-center gap-2 rounded-2xl px-2.5 text-start">
          <ChevronRight className={cn('h-4 w-4 shrink-0 text-muted transition-transform rtl:rotate-180', open && 'rotate-90 rtl:rotate-90')} />
          {open ? <FolderOpen className="h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" /> : <Folder className="h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />}
          <span dir="auto" className="min-w-0 truncate text-sm font-semibold">
            {g.name}
          </span>
          <span className="ms-auto shrink-0 text-xs tabular-nums text-muted">{g.conversationCount}</span>
        </button>
        <button
          ref={anchor}
          type="button"
          onClick={() => setMenu((m) => !m)}
          aria-haspopup="menu"
          aria-expanded={menu}
          aria-label={`More for the group "${g.name}"`}
          data-tip="More"
          className={cn('icon-btn h-9 w-9 shrink-0 focus:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100 touch:h-11 touch:w-11', menu ? 'opacity-100' : 'opacity-0')}
        >
          <MoreHorizontal className="h-4 w-4" />
        </button>
        <FloatingPanel anchor={anchor} open={menu} onClose={() => setMenu(false)} width={220} label={g.name}>
          <div role="menu" aria-label={g.name}>
            <MenuItem
              icon={<Pencil className="h-4 w-4" />}
              onClick={() => {
                setMenu(false)
                onRename()
              }}
            >
              Rename the group
            </MenuItem>
            <MenuItem
              icon={<Trash2 className="h-4 w-4" />}
              danger
              onClick={() => {
                setMenu(false)
                onRemove()
              }}
            >
              Remove the group
            </MenuItem>
          </div>
        </FloatingPanel>
      </div>
      {open && (
        <div className="ms-4 border-s border-slate-200 ps-1 dark:border-slate-700">
          <PagedConversations scope="group" groupId={g.id} rows={rows} empty="No conversations in this group yet. Move one here from its menu (⋯)." />
        </div>
      )}
    </li>
  )
}

/** The search's conversations, each with where the words are and the words around them. */
function SearchResults({ term, rows }: { term: string; rows: RowContext }) {
  const { enabled } = useAi()
  const settled = useDebounced(term, 300)
  const { data, isLoading, isError, refetch, isPlaceholderData } = useAiConversationSearch(settled, enabled)
  if (isLoading || (charCount(settled.trim()) < AI_CONVERSATION_SEARCH_MIN && !data)) {
    return (
      <p role="status" className="flex items-center justify-center gap-2 px-3 py-8 text-sm text-muted">
        <Loader2 className="h-4 w-4 animate-spin" /> Searching…
      </p>
    )
  }
  if (isError && !data) {
    return (
      <p className="px-3 py-8 text-center text-sm text-muted">
        The search could not be done.{' '}
        <button type="button" onClick={() => void refetch()} className="font-semibold text-brand-700 hover:underline dark:text-brand-300">
          Try again
        </button>
      </p>
    )
  }
  const hits = data?.hits ?? []
  return (
    <div className={cn(isPlaceholderData && 'opacity-60 transition-opacity')}>
      <SectionTitle>{hits.length === 0 ? 'Nothing found' : `Found in ${hits.length}${data?.hasMore ? '+' : ''} ${hits.length === 1 ? 'conversation' : 'conversations'}`}</SectionTitle>
      {hits.length === 0 && <p className="px-3 py-3 text-sm text-muted">No conversation has “{oneLine(settled)}” in its title, its questions or its answers.</p>}
      <ul>
        {hits.map((h) => (
          <Row key={h.conversation.id} c={h.conversation} rows={rows} below={<HitLine hit={h} />} />
        ))}
      </ul>
      {data?.hasMore && <p className="px-3 py-2 text-xs text-muted">Showing the latest. Add a word to narrow the search.</p>}
    </div>
  )
}

const WHERE: Record<AiConversationSearchHit['where'], string> = { title: 'In the title', question: 'In a question', answer: 'In an answer' }

/** Where the words were found, and the words around them with the match marked. */
export function HitLine({ hit }: { hit: AiConversationSearchHit }) {
  const { snippet, match } = hit
  return (
    <span className="block">
      <span className="flex items-center gap-1 text-[11px] text-muted">
        {WHERE[hit.where]}
        {hit.conversation.archivedAt && <Badge tone="neutral">Archived</Badge>}
      </span>
      {snippet && (
        <span dir="auto" className="mt-0.5 line-clamp-2 block break-words text-xs text-slate-600 dark:text-slate-300">
          {match ? (
            <>
              {snippet.slice(0, match.start)}
              <mark className="rounded bg-amber-200/80 px-0.5 text-slate-900 dark:bg-amber-400/30 dark:text-amber-100">{snippet.slice(match.start, match.start + match.length)}</mark>
              {snippet.slice(match.start + match.length)}
            </>
          ) : (
            snippet
          )}
        </span>
      )}
    </span>
  )
}

/** Asks for a conversation's title or a group's name: on one line, up to `max` characters. */
function NameDialog({
  title,
  label,
  initial,
  max,
  saveLabel,
  busy,
  onSave,
  onClose,
}: {
  title: string
  label: string
  initial: string
  max: number
  saveLabel: string
  busy: boolean
  onSave: (name: string) => void
  onClose: () => void
}) {
  const [value, setValue] = useState(initial)
  const name = oneLine(value)
  const length = charCount(name)
  const problem = name === '' ? null : length > max ? `At most ${max} characters.` : null
  const can = name !== '' && !problem && !busy
  return (
    <Modal
      open
      onClose={onClose}
      size="sm"
      title={title}
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" form="ai-name-dialog" disabled={!can}>
            {busy && <Loader2 className="h-4 w-4 animate-spin" />} {saveLabel}
          </Button>
        </>
      }
    >
      <form
        id="ai-name-dialog"
        onSubmit={(e) => {
          e.preventDefault()
          if (can) onSave(name)
        }}
      >
        <label className="block text-13 font-semibold text-slate-700 dark:text-slate-200" htmlFor="ai-name-input">
          {label}
        </label>
        <Input id="ai-name-input" value={value} onChange={(e) => setValue(e.target.value)} dir="auto" autoFocus maxLength={max * 2} className="mt-1" aria-invalid={problem ? true : undefined} />
        <p className={cn('mt-1 text-xs', problem ? 'text-rose-700 dark:text-rose-300' : 'text-muted')}>{problem ?? `${length} / ${max}`}</p>
      </form>
    </Modal>
  )
}
