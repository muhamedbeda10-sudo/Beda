import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { Check, CheckCheck, CornerUpLeft, Copy, MoreHorizontal, Pencil, SmilePlus, Trash2 } from 'lucide-react'
import { CHAT_EDIT_WINDOW_MS, type ChatMention, type ChatMessage } from '@qc/shared/types'
import { ImagePicker } from '@/components/inspection/ImagePicker'
import { NoticeFileRow } from '@/components/notices/NoticeCard'
import { driftedTooFar } from '@/components/ui/Tooltip'
import { matchesMedia } from '@/lib/media'
import { cn, formatTime } from '@/lib/utils'
import { ACTIONS_AS_SHEET, BUBBLE_LONG_PRESS_MS, menuSide, sideShift } from './bubbleMenu'
import { ChatSheet } from './ChatSheet'
import { QUICK_REACTIONS } from './emoji'
import { MessageBody } from './MessageBody'
import { plainText } from './mentions'

const timeOf = (iso: string) => formatTime(iso)

export interface BubbleActions {
  onReply: (m: ChatMessage) => void
  onEdit: (m: ChatMessage) => void
  onDelete: (m: ChatMessage, scope: 'me' | 'everyone') => void
  onReact: (m: ChatMessage, emoji: string) => void
  onMention: (m: ChatMention) => void
  onJumpTo: (id: string) => void
}

/** How the actions are open: a menu beside the bubble (a mouse on a wide screen), or a sheet from the bottom. */
type MenuShape = 'menu' | 'sheet'

/**
 * One message as WhatsApp draws it: mine on the right in brand, theirs on the left.
 * Its actions (reply, react, copy, edit, delete) open from the "…" beside it,
 * from a long press of the bubble, or from a right click.
 */
export function MessageBubble({
  message: m,
  mine,
  showSender,
  canModerate,
  actions,
  highlighted,
  lead,
  automated = false,
}: {
  message: ChatMessage
  mine: boolean
  showSender: boolean
  /** An administrator in a channel may delete for everyone. */
  canModerate: boolean
  actions: BubbleActions
  highlighted?: boolean
  /** Before someone else's bubble: their circle, or the space it takes. */
  lead?: ReactNode
  /** §21 — from the automations sender: its addresses open in place, and nothing is answered to it. */
  automated?: boolean
}) {
  const [menu, setMenu] = useState<MenuShape | null>(null)
  const ref = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const openMenu = () => setMenu(matchesMedia(ACTIONS_AS_SHEET) ? 'sheet' : 'menu')
  const closeMenu = () => setMenu(null)

  // The menu beside the bubble closes on a press anywhere else, and on Escape (focus back on "…").
  useEffect(() => {
    if (menu !== 'menu') return
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setMenu(null)
    }
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      setMenu(null)
      trigger.current?.focus()
    }
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', key)
    return () => {
      document.removeEventListener('mousedown', close)
      document.removeEventListener('keydown', key)
    }
  }, [menu])

  // A finger resting on the bubble opens its actions; moving it first is a scroll. The tap the lift may still send
  // (a photo, a quoted message, a link under the finger) is swallowed, once.
  const press = useRef<{ id: number; x: number; y: number; timer: number } | null>(null)
  const swallow = useRef(false)
  const swallowTimer = useRef<number | undefined>(undefined)
  const endPress = () => {
    if (press.current) window.clearTimeout(press.current.timer)
    press.current = null
  }
  useEffect(
    () => () => {
      endPress()
      window.clearTimeout(swallowTimer.current)
    },
    [],
  )
  const pressHandlers = m.deleted
    ? {}
    : {
        onPointerDown: (e: React.PointerEvent) => {
          endPress()
          window.clearTimeout(swallowTimer.current)
          swallow.current = false
          if (e.pointerType !== 'touch' || !e.isPrimary) return
          // A tooltip's long press stays the tooltip's (the tooltip layer answers it).
          if (e.target instanceof Element && e.target.closest('[data-tip]')) return
          const at = { x: e.clientX, y: e.clientY }
          press.current = {
            id: e.pointerId,
            ...at,
            timer: window.setTimeout(() => {
              press.current = null
              swallow.current = true
              openMenu()
            }, BUBBLE_LONG_PRESS_MS),
          }
        },
        onPointerMove: (e: React.PointerEvent) => {
          if (press.current && press.current.id === e.pointerId && driftedTooFar(press.current, { x: e.clientX, y: e.clientY })) endPress()
        },
        onPointerUp: () => {
          endPress()
          if (swallow.current) swallowTimer.current = window.setTimeout(() => (swallow.current = false), 400)
        },
        onPointerCancel: endPress,
        onClickCapture: (e: React.MouseEvent) => {
          if (!swallow.current) return
          swallow.current = false
          e.preventDefault()
          e.stopPropagation()
        },
        // A right click, or the phone's own long-press menu: the message's actions instead — unless text is selected
        // in it, or the press is on a link, where the browser's menu (copy, open in a new tab) is what is wanted.
        onContextMenu: (e: React.MouseEvent) => {
          if (e.target instanceof Element && e.target.closest('a[href]')) return
          if (window.getSelection()?.toString()) return
          e.preventDefault()
          endPress()
          if (!menu) openMenu()
        },
      }

  const withinWindow = Date.now() - new Date(m.createdAt).getTime() <= CHAT_EDIT_WINDOW_MS
  const allRead = m.others > 0 && m.readBy >= m.others
  const someRead = m.readBy > 0
  const run = (fn: () => void) => () => {
    fn()
    setMenu(null)
  }
  const items: MenuEntry[] = [
    ...(!automated
      ? [
          { key: 'reply', icon: <CornerUpLeft className="h-4 w-4" />, label: 'Reply', onClick: run(() => actions.onReply(m)) },
          { key: 'react', icon: <SmilePlus className="h-4 w-4" />, label: 'React…', onClick: run(() => actions.onReact(m, '')) },
        ]
      : []),
    { key: 'copy', icon: <Copy className="h-4 w-4" />, label: 'Copy text', onClick: run(() => void navigator.clipboard?.writeText(plainText(m.body))) },
    ...(mine && withinWindow && m.body ? [{ key: 'edit', icon: <Pencil className="h-4 w-4" />, label: 'Edit', onClick: run(() => actions.onEdit(m)) }] : []),
    { key: 'delete-me', icon: <Trash2 className="h-4 w-4" />, label: 'Delete for me', onClick: run(() => actions.onDelete(m, 'me')) },
    ...((mine && withinWindow) || canModerate ? [{ key: 'delete-all', icon: <Trash2 className="h-4 w-4" />, label: 'Delete for everyone', danger: true, onClick: run(() => actions.onDelete(m, 'everyone')) }] : []),
  ]
  const react = automated ? undefined : (emoji: string) => run(() => actions.onReact(m, emoji))()

  return (
    <>
      {/* On a phone the "…" keeps to a gutter of its own beside the bubble, inside the thread, instead of hanging past its edge. */}
      <div id={`msg-${m.id}`} className={cn('group flex w-full', mine ? 'justify-end max-sm:ps-10' : 'justify-start max-sm:pe-10', !!lead && 'items-start gap-2')}>
        {!mine && lead}
        <div ref={ref} className={cn('relative max-w-full sm:max-w-[70%]', highlighted && 'animate-pulse')}>
          <div
            {...pressHandlers}
            className={cn(
              'rounded-2xl px-3 py-2 text-sm shadow-sm touch:select-none touch:[-webkit-touch-callout:none]',
              mine ? 'rounded-br-md bg-brand-600 text-white' : 'rounded-bl-md bg-white text-slate-800 ring-1 ring-slate-200/80 dark:bg-slate-800 dark:text-slate-100 dark:ring-slate-700',
              m.deleted && 'italic opacity-70',
            )}
          >
            {showSender && !mine && <p className="mb-0.5 text-[11px] font-bold text-accent-600 dark:text-accent-400">{m.senderName}</p>}
            {m.replyTo && (
              <button
                type="button"
                onClick={() => actions.onJumpTo(m.replyTo!.id)}
                className={cn('mb-1.5 block w-full rounded-lg border-l-4 px-2 py-1 text-left text-xs', mine ? 'border-white/60 bg-white/15' : 'border-brand-500 bg-slate-100 dark:bg-slate-700/60')}
              >
                <span className="block font-bold">{m.replyTo.senderName}</span>
                <span className="line-clamp-2 opacity-80">{m.replyTo.text || '…'}</span>
              </button>
            )}
            {m.deleted ? (
              <span className="inline-flex items-center gap-1">
                <Trash2 className="h-3.5 w-3.5" /> Message deleted
              </span>
            ) : (
              <>
                {m.imageIds.length > 0 && (
                  <div className="mb-1.5">
                    <ImagePicker imageIds={m.imageIds} onChange={() => {}} readOnly />
                  </div>
                )}
                {m.files.length > 0 && (
                  <div className={cn('mb-1.5 space-y-1', mine && '[&_button]:border-white/30 [&_button]:text-white [&_button:hover]:bg-white/10 [&_span.text-muted]:text-white/70')}>
                    {m.files.map((f) => (
                      <NoticeFileRow key={f.id} file={f} path={`/chat/files/${f.id}/content`} compact />
                    ))}
                  </div>
                )}
                {m.body && <MessageBody body={m.body} mine={mine} onMention={actions.onMention} appLinks={automated} />}
              </>
            )}
            <span className={cn('mt-1 flex items-center justify-end gap-1 text-[10px] tabular-nums', mine ? 'text-white/70' : 'text-muted')}>
              {m.editedAt && !m.deleted && <span>edited ·</span>}
              {timeOf(m.createdAt)}
              {mine && !m.deleted && (allRead ? <CheckCheck className="h-3.5 w-3.5 text-sky-200" /> : someRead ? <CheckCheck className="h-3.5 w-3.5" /> : <Check className="h-3.5 w-3.5" />)}
            </span>
          </div>

          {m.reactions.length > 0 && (
            <div className={cn('-mt-1.5 flex flex-wrap gap-1', mine ? 'justify-end pr-1' : 'pl-1')}>
              {m.reactions.map((r) => (
                <button
                  key={r.emoji}
                  type="button"
                  onClick={() => actions.onReact(m, r.emoji)}
                  data-tip={r.names.join(', ')}
                  aria-label={`${r.emoji} ${r.count}: ${r.names.join(', ')}`}
                  aria-pressed={r.mine}
                  className={cn(
                    // With a finger: 32 px, and a target 40 px tall around it (its press and hold shows who reacted).
                    'relative inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-xs shadow-sm touch:min-h-[32px] touch:px-2.5 touch:before:absolute touch:before:-inset-y-1 touch:before:inset-x-0',
                    r.mine ? 'border-brand-400 bg-brand-50 dark:border-brand-500/60 dark:bg-brand-500/20' : 'border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-800',
                  )}
                >
                  <span>{r.emoji}</span>
                  <span className="tabular-nums text-slate-600 dark:text-slate-300">{r.count}</span>
                </button>
              ))}
            </div>
          )}

          {!m.deleted && (
            // A 28 px circle; with a finger its target is 44 px around it, and it shows without a hover.
            <button
              ref={trigger}
              type="button"
              onClick={() => (menu ? closeMenu() : openMenu())}
              aria-label="Message actions"
              aria-expanded={!!menu}
              className={cn(
                'absolute top-1 grid h-7 w-7 place-items-center rounded-full transition-opacity focus:outline-none touch:-top-1 touch:h-11 touch:w-11',
                mine ? '-left-8 touch:-left-10' : '-right-8 touch:-right-10',
                menu ? 'opacity-100' : 'opacity-0 focus-visible:opacity-100 group-hover:opacity-100 touch:opacity-100',
              )}
            >
              <span className="grid h-7 w-7 place-items-center rounded-full bg-white/90 text-muted shadow ring-1 ring-slate-200 dark:bg-slate-700 dark:text-slate-200 dark:ring-slate-600 [:focus-visible>&]:ring-2 [:focus-visible>&]:ring-brand-500">
                <MoreHorizontal className="h-4 w-4" />
              </span>
            </button>
          )}

          {menu === 'menu' && <BesideMenu mine={mine} items={items} onReact={react} anchor={ref} />}
        </div>
      </div>

      {menu === 'sheet' && (
        <ChatSheet label="Message actions" onClose={closeMenu} header={<SheetHeader message={m} mine={mine} />}>
          {react && <QuickReactions onReact={react} large />}
          <ul>
            {items.map((it) => (
              <li key={it.key}>
                <MenuItem {...it} large />
              </li>
            ))}
          </ul>
        </ChatSheet>
      )}
    </>
  )
}

interface MenuEntry {
  key: string
  icon: ReactNode
  label: string
  onClick: () => void
  danger?: boolean
}

/**
 * The actions as a menu beside the bubble (a mouse on a wide screen): below
 * it, or above it when only that side has room inside the thread, kept
 * within the thread's width, and scrolled into view.
 */
function BesideMenu({ mine, items, onReact, anchor }: { mine: boolean; items: MenuEntry[]; onReact?: (emoji: string) => void; anchor: React.RefObject<HTMLElement> }) {
  const menu = useRef<HTMLDivElement>(null)
  const [place, setPlace] = useState<{ side: 'below' | 'above'; shift: number } | null>(null)

  useLayoutEffect(() => {
    const el = menu.current
    const box = anchor.current
    if (!el || !box) return
    const thread = scrollParent(box)
    const view = thread ? thread.getBoundingClientRect() : { top: 0, bottom: window.innerHeight, left: 0, right: window.innerWidth }
    // Its layout size and the side it hangs from: the opening animation's scale is not counted.
    const b = box.getBoundingClientRect()
    const width = el.offsetWidth
    const left = mine ? b.right - width : b.left
    const side = menuSide(b, el.offsetHeight, { top: Math.max(view.top, 0), bottom: Math.min(view.bottom, window.innerHeight) })
    const shift = sideShift(left, left + width, Math.max(view.left, 0) + 8, Math.min(view.right, window.innerWidth) - 8)
    setPlace({ side, shift })
  }, [anchor, mine])

  // Placed: brought into view inside the thread, as little as it takes.
  useEffect(() => {
    if (place) menu.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [place])

  return (
    <div
      ref={menu}
      // `translate`, not `transform`: the opening animation's transform composes with it instead of replacing it.
      style={place?.shift ? { translate: `${place.shift}px 0` } : undefined}
      className={cn(
        'absolute z-20 w-64 rounded-2xl bg-white p-1.5 shadow-lift ring-1 ring-slate-200 animate-scale-in dark:bg-slate-900 dark:ring-slate-700',
        mine ? 'right-0' : 'left-0',
        place?.side === 'above' ? 'bottom-full mb-1' : 'top-full mt-1',
        !place && 'invisible',
      )}
    >
      {onReact && <QuickReactions onReact={onReact} />}
      {items.map(({ key, ...it }) => (
        <MenuItem key={key} {...it} />
      ))}
    </div>
  )
}

/** The nearest box around `el` that scrolls up and down: the thread. */
function scrollParent(el: HTMLElement): HTMLElement | null {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const y = getComputedStyle(p).overflowY
    if (y === 'auto' || y === 'scroll') return p
  }
  return null
}

/** The eight quick reactions: a row of eight in the menu, two rows of four (44 px each) in a phone's sheet. */
function QuickReactions({ onReact, large = false }: { onReact: (emoji: string) => void; large?: boolean }) {
  return (
    <div role="group" aria-label="Quick reactions" className={cn('mb-1 grid gap-1 border-b border-slate-100 pb-1.5 dark:border-slate-800', large ? 'grid-cols-4 px-1 sm:grid-cols-8' : 'grid-cols-8')}>
      {QUICK_REACTIONS.map((e) => (
        <button
          key={e}
          type="button"
          onClick={() => onReact(e)}
          aria-label={`React ${e}`}
          className={cn('grid place-items-center rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800', large ? 'h-11 text-2xl' : 'h-8 text-lg')}
        >
          {e}
        </button>
      ))}
    </div>
  )
}

/** Above a sheet's actions: whose message they are for, its first words, and who reacted with what. */
function SheetHeader({ message: m, mine }: { message: ChatMessage; mine: boolean }) {
  const text = plainText(m.body) || (m.imageIds.length ? '📷 Photo' : m.files.length ? '📎 File' : '')
  return (
    <div className="shrink-0 border-b border-slate-100 px-4 pb-3 pt-2 dark:border-slate-800">
      <p className="text-xs font-bold text-muted">
        {mine ? 'Your message' : m.senderName} · <span className="font-medium tabular-nums">{timeOf(m.createdAt)}</span>
      </p>
      {text && (
        <p dir="auto" className="mt-0.5 line-clamp-2 break-words text-start text-sm text-slate-700 dark:text-slate-200">
          {text}
        </p>
      )}
      {m.reactions.length > 0 && (
        <ul aria-label="Reactions" className="mt-2 space-y-1">
          {m.reactions.map((r) => (
            <li key={r.emoji} className="flex items-start gap-2 text-xs">
              <span className="shrink-0 text-base leading-none">{r.emoji}</span>
              <span dir="auto" className="min-w-0 flex-1 break-words text-start text-slate-600 dark:text-slate-300">
                {r.names.join(', ')}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function MenuItem({ icon, label, onClick, danger, large = false }: Omit<MenuEntry, 'key'> & { large?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex w-full items-center gap-3 rounded-xl px-3 text-left font-medium hover:bg-slate-100 dark:hover:bg-slate-800',
        large ? 'min-h-[48px] text-base' : 'py-2 text-sm',
        danger ? 'text-rose-600 dark:text-rose-400' : 'text-slate-700 dark:text-slate-200',
      )}
    >
      {icon} {label}
    </button>
  )
}
