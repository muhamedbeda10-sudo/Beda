// ============================================================================
// §20 — one conversation in the list, and its menu: pin or unpin, rename,
// move to a group (or out of one, or into a new one), archive or unarchive,
// delete. The menu is a small panel by the row with a mouse, a sheet from the
// bottom on a phone; "Move to group" turns it into the list of groups.
// ============================================================================

import { memo, useRef, useState, type ReactNode } from 'react'
import { Archive, ArchiveRestore, ArrowLeft, Check, FolderInput, FolderPlus, FolderMinus, Loader2, MessageSquareText, MoreHorizontal, Pencil, Pin, PinOff, Trash2 } from 'lucide-react'
import type { AiConversation, AiConversationGroup } from '@qc/shared/ai'
import { FloatingPanel } from '@/components/dashboard/filters'
import { cn, formatDate, formatFullTimestamp, formatTime } from '@/lib/utils'

/** Today's time, or the day. */
export const when = (iso: string) => (new Date(iso).toDateString() === new Date().toDateString() ? formatTime(iso) : formatDate(iso))

/** What can be done to a conversation from its menu; the list does it. */
export interface ConversationActions {
  setPinned: (c: AiConversation, pinned: boolean) => void
  rename: (c: AiConversation) => void
  move: (c: AiConversation, groupId: string | null) => void
  moveToNewGroup: (c: AiConversation) => void
  setArchived: (c: AiConversation, archived: boolean) => void
  remove: (c: AiConversation) => void
}

export const AiConversationRow = memo(function AiConversationRow({
  conversation: c,
  active,
  writing,
  groups,
  actions,
  onOpen,
  below,
}: {
  conversation: AiConversation
  active: boolean
  /** An answer is being written in it: it cannot be deleted meanwhile. */
  writing: boolean
  groups: readonly AiConversationGroup[]
  actions: ConversationActions
  onOpen: (c: AiConversation) => void
  /** What a search found in it, under the title in place of the time. */
  below?: ReactNode
}) {
  const anchor = useRef<HTMLButtonElement>(null)
  const [menu, setMenu] = useState<'closed' | 'main' | 'groups'>('closed')
  const close = () => setMenu('closed')
  const run = (act: () => void) => () => {
    close()
    act()
  }

  return (
    <li className={cn('group flex items-center gap-1 rounded-2xl pe-1 transition-colors', active ? 'bg-brand-50 ring-1 ring-brand-200 dark:bg-brand-500/15 dark:ring-brand-500/30' : 'hover:bg-slate-100 dark:hover:bg-slate-800')}>
      <button type="button" onClick={() => onOpen(c)} aria-current={active ? 'true' : undefined} className="flex min-w-0 flex-1 items-center gap-3 rounded-2xl px-2.5 py-2.5 text-start">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-brand-100 text-brand-700 dark:bg-brand-500/20 dark:text-brand-200">
          {writing ? <Loader2 className="h-4 w-4 animate-spin" /> : <MessageSquareText className="h-4 w-4" />}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1">
            <span dir="auto" className="min-w-0 truncate text-sm font-semibold">
              {c.title}
            </span>
            {c.pinnedAt && <Pin aria-label="Pinned" className="h-3 w-3 shrink-0 rotate-45 text-brand-600 dark:text-brand-300" />}
          </span>
          {below ?? (
            <time dateTime={c.lastMessageAt} data-tip={formatFullTimestamp(c.lastMessageAt)} className="block text-[11px] tabular-nums text-muted">
              {writing ? 'Answering…' : when(c.lastMessageAt)}
            </time>
          )}
        </span>
      </button>
      <button
        ref={anchor}
        type="button"
        onClick={() => setMenu((m) => (m === 'closed' ? 'main' : 'closed'))}
        aria-haspopup="menu"
        aria-expanded={menu !== 'closed'}
        aria-label={`More for the conversation "${c.title}"`}
        data-tip="More"
        className={cn(
          'icon-btn h-9 w-9 shrink-0 focus:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100 touch:h-11 touch:w-11',
          menu === 'closed' && !active ? 'opacity-0' : 'opacity-100',
        )}
      >
        <MoreHorizontal className="h-4 w-4" />
      </button>
      <FloatingPanel anchor={anchor} open={menu !== 'closed'} onClose={close} width={232} label={c.title}>
        {menu === 'groups' ? (
          <div role="menu" aria-label="Move to group">
            <MenuItem icon={<ArrowLeft className="h-4 w-4 rtl:rotate-180" />} onClick={() => setMenu('main')}>
              Move to group
            </MenuItem>
            <div className="my-1 border-t border-slate-100 dark:border-slate-800" />
            {groups.map((g) => (
              <MenuItem key={g.id} icon={c.groupId === g.id ? <Check className="h-4 w-4 text-brand-600" /> : <span className="h-4 w-4" />} onClick={run(() => c.groupId !== g.id && actions.move(c, g.id))} checked={c.groupId === g.id}>
                <span dir="auto" className="min-w-0 truncate">
                  {g.name}
                </span>
              </MenuItem>
            ))}
            {groups.length === 0 && <p className="px-2 py-1.5 text-xs text-muted">No groups yet.</p>}
            <div className="my-1 border-t border-slate-100 dark:border-slate-800" />
            <MenuItem icon={<FolderPlus className="h-4 w-4" />} onClick={run(() => actions.moveToNewGroup(c))}>
              New group…
            </MenuItem>
            {c.groupId && (
              <MenuItem icon={<FolderMinus className="h-4 w-4" />} onClick={run(() => actions.move(c, null))}>
                Take out of its group
              </MenuItem>
            )}
          </div>
        ) : (
          <div role="menu" aria-label={c.title}>
            {!c.archivedAt &&
              (c.pinnedAt ? (
                <MenuItem icon={<PinOff className="h-4 w-4" />} onClick={run(() => actions.setPinned(c, false))}>
                  Unpin
                </MenuItem>
              ) : (
                <MenuItem icon={<Pin className="h-4 w-4" />} onClick={run(() => actions.setPinned(c, true))}>
                  Pin
                </MenuItem>
              ))}
            <MenuItem icon={<Pencil className="h-4 w-4" />} onClick={run(() => actions.rename(c))}>
              Rename
            </MenuItem>
            <MenuItem icon={<FolderInput className="h-4 w-4" />} onClick={() => setMenu('groups')}>
              Move to group
            </MenuItem>
            {c.archivedAt ? (
              <MenuItem icon={<ArchiveRestore className="h-4 w-4" />} onClick={run(() => actions.setArchived(c, false))}>
                Unarchive
              </MenuItem>
            ) : (
              <MenuItem icon={<Archive className="h-4 w-4" />} onClick={run(() => actions.setArchived(c, true))}>
                Archive
              </MenuItem>
            )}
            <div className="my-1 border-t border-slate-100 dark:border-slate-800" />
            <MenuItem icon={<Trash2 className="h-4 w-4" />} onClick={run(() => actions.remove(c))} disabled={writing} danger hint={writing ? 'Still answering' : undefined}>
              Delete
            </MenuItem>
          </div>
        )}
      </FloatingPanel>
    </li>
  )
})

export function MenuItem({
  icon,
  onClick,
  children,
  disabled,
  danger,
  checked,
  hint,
}: {
  icon: ReactNode
  onClick: () => void
  children: ReactNode
  disabled?: boolean
  danger?: boolean
  /** For a choice among several (a group): whether it is the one chosen. */
  checked?: boolean
  hint?: string
}) {
  return (
    <button
      type="button"
      role={checked === undefined ? 'menuitem' : 'menuitemradio'}
      aria-checked={checked}
      onClick={onClick}
      disabled={disabled}
      data-tip={hint}
      className={cn(
        'flex h-9 w-full items-center gap-2 rounded-md px-2 text-start text-sm hover:bg-slate-100 disabled:opacity-50 disabled:hover:bg-transparent dark:hover:bg-slate-800 touch:h-11',
        danger && 'text-rose-700 dark:text-rose-300',
      )}
    >
      <span className="grid shrink-0 place-items-center">{icon}</span>
      {typeof children === 'string' ? <span className="min-w-0 flex-1 truncate">{children}</span> : children}
    </button>
  )
}
