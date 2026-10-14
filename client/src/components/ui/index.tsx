import {
  useEffect,
  useRef,
  type ReactNode,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ButtonHTMLAttributes,
  type HTMLAttributes,
  type InputHTMLAttributes,
  type SelectHTMLAttributes,
} from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import { cn, lockBodyScroll } from '@/lib/utils'
import type { DimensionStatus, Disposition, SessionStatus } from '@qc/shared/types'

// ---- Badge -----------------------------------------------------------------
export type BadgeTone = 'neutral' | 'green' | 'blue' | 'amber' | 'red' | 'violet'
/** Each tone by meaning: neutral, success (green), info (blue), warning (amber), danger (red), and violet for stages. AA in both themes. */
const badgeTones: Record<BadgeTone, string> = {
  neutral: 'bg-neutral-100 text-neutral-700 ring-neutral-200 dark:bg-neutral-800 dark:text-neutral-300 dark:ring-neutral-700',
  green: 'bg-success-50 text-success-700 ring-success-200 dark:bg-success-500/10 dark:text-success-400 dark:ring-success-500/25',
  blue: 'bg-info-50 text-info-700 ring-info-200 dark:bg-info-500/10 dark:text-info-300 dark:ring-info-500/25',
  amber: 'bg-warning-50 text-warning-800 ring-warning-200 dark:bg-warning-500/10 dark:text-warning-400 dark:ring-warning-500/25',
  red: 'bg-danger-50 text-danger-700 ring-danger-200 dark:bg-danger-500/10 dark:text-danger-400 dark:ring-danger-500/25',
  violet: 'bg-violet-50 text-violet-700 ring-violet-200 dark:bg-violet-500/10 dark:text-violet-300 dark:ring-violet-500/25',
}

/** The tone of each status a record can be in, the same on every page. */
export const STATUS_TONE = {
  Open: 'green',
  Closed: 'neutral',
  Active: 'blue',
  Cancel: 'red',
  Defects: 'red',
} as const satisfies Record<string, BadgeTone>

export function Badge({
  children,
  tone = 'neutral',
  className,
  icon,
  tip,
}: {
  children: ReactNode
  tone?: BadgeTone
  className?: string
  icon?: ReactNode
  /** Said in the tooltip: what the badge stands for, in full. */
  tip?: string
}) {
  // One line, 22 px high, whatever the column's width: a badge never wraps.
  return (
    <span
      data-tip={tip}
      className={cn(
        'inline-flex h-[22px] shrink-0 items-center gap-1 whitespace-nowrap rounded-md px-2 text-xs font-semibold leading-none ring-1 ring-inset',
        badgeTones[tone],
        className,
      )}
    >
      {icon}
      {children}
    </span>
  )
}

export function resultTone(r: DimensionStatus): BadgeTone {
  return r === 'Pass' ? 'green' : r === 'Fail' ? 'red' : r === 'Warning' ? 'amber' : 'neutral'
}
/** Rejected reads as a failure, Hold as an open item, the rest as resolved. */
export function dispositionTone(d: Disposition | null): BadgeTone {
  if (!d) return 'red'
  if (d === 'Rejected') return 'red'
  if (d === 'Hold') return 'amber'
  return 'green'
}
export function statusTone(s: SessionStatus): BadgeTone {
  return s === 'Open' ? 'green' : 'neutral'
}

// ---- Button ----------------------------------------------------------------
type Variant = 'primary' | 'secondary' | 'ghost' | 'danger'
const variants: Record<Variant, string> = {
  primary: 'btn-primary',
  secondary: 'btn-secondary',
  ghost: 'btn-ghost',
  danger: 'btn-danger',
}
export function Button({
  variant = 'secondary',
  className,
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  return (
    <button className={cn(variants[variant], className)} {...props}>
      {children}
    </button>
  )
}

// ---- Card ------------------------------------------------------------------
/** A card; any other attribute (a role, a click, a label) reaches its element. */
export function Card({ className, children, ...rest }: HTMLAttributes<HTMLDivElement> & { children: ReactNode }) {
  return (
    <div className={cn('card', className)} {...rest}>
      {children}
    </div>
  )
}

// ---- Inputs ----------------------------------------------------------------
export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cn('input', className)} {...props} />
}
export function Select({ className, children, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select className={cn('input pr-8', className)} {...props}>
      {children}
    </select>
  )
}
export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="block">
      <span className="label">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-muted">{hint}</span>}
    </label>
  )
}

// ---- Modal / Dialog --------------------------------------------------------
/**
 * The footer of every modal and drawer. On a phone a right-aligned row of four
 * buttons wrapped into a ragged stack, so there it is a grid of two even
 * columns, each button filling its cell; from a tablet up it is the row, and
 * `mr-auto` on a button still parts it from the rest.
 *
 * On a phone: a label that wraps stays centred and compact; an odd button out
 * at the end (a lone Close after a pair) takes the whole last row rather than
 * half of it; and a ghost button (Cancel, Back, Stay) gets a thin ring, so the
 * safe choice reads as a button beside a solid one, not as stray text. The
 * page keeps its own labels short enough for half a phone's width.
 */
const FOOTER =
  'grid shrink-0 grid-cols-2 gap-2 border-t border-slate-100 px-4 py-3 dark:border-slate-800 safe-bottom [&>*]:min-h-[48px] [&>*]:justify-center max-sm:[&>*]:text-center max-sm:[&>*]:leading-tight max-sm:[&>*:last-child:nth-child(odd)]:col-span-2 max-sm:[&>.btn-ghost:not(:focus-visible)]:ring-1 max-sm:[&>.btn-ghost:not(:focus-visible)]:ring-inset max-sm:[&>.btn-ghost:not(:focus-visible)]:ring-slate-200 dark:max-sm:[&>.btn-ghost:not(:focus-visible)]:ring-slate-700 sm:flex sm:flex-wrap sm:justify-end sm:px-5 sm:py-3.5'

/** The close button in a dialog's header: a 44 px target whose margins keep the header as low as its title. */
const CLOSE = 'icon-btn -my-2 -me-2 shrink-0'

/** The inputs a tablet or phone opens its keyboard for: every one but a box, a button, a slider, a colour or a file. */
const NO_KEYBOARD_INPUTS = new Set(['checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'color', 'file', 'image', 'hidden'])

/** Whether the element being typed in has the on-screen keyboard open: a text field, a box of text, or editable text. */
export function opensKeyboard(el: { tagName: string; getAttribute(name: string): string | null; isContentEditable?: boolean } | null | undefined): boolean {
  if (!el) return false
  if (el.isContentEditable) return true
  const tag = el.tagName.toLowerCase()
  if (tag === 'textarea') return true
  if (tag !== 'input') return false
  return !NO_KEYBOARD_INPUTS.has((el.getAttribute('type') ?? 'text').toLowerCase())
}

/**
 * A dialog's backdrop closes it on a click that began on the backdrop — not
 * on one that ends there after a drag from inside the dialog, and not on the
 * tap that closes a pick list opened in the dialog (a FloatingPanel): that tap
 * is meant for the list alone. The press is judged as it begins, before the
 * list (closing on the same press) is gone.
 *
 * Nor on the tap that only puts the keyboard away: on a tablet the keyboard
 * covers half the screen, and a tap outside the dialog while one of its fields
 * is being typed in is meant to hide it (to reach Save), not to throw away what
 * was typed. That tap ends the typing; the next one on the backdrop closes it.
 */
function useBackdrop(onClose: () => void) {
  const armed = useRef(false)
  return {
    onPointerDown: (e: ReactPointerEvent<HTMLDivElement>) => {
      const typing = document.activeElement
      if (typing instanceof HTMLElement && opensKeyboard(typing) && typing.closest('[role="dialog"]')) {
        armed.current = false
        typing.blur()
        return
      }
      armed.current = e.target === e.currentTarget && !document.querySelector('[data-floating-panel]')
    },
    onClick: (e: ReactMouseEvent<HTMLDivElement>) => {
      const close = armed.current && e.target === e.currentTarget
      armed.current = false
      if (close) onClose()
    },
  }
}

export function Modal({
  open,
  onClose,
  title,
  children,
  footer,
  size = 'md',
  icon,
}: {
  open: boolean
  onClose: () => void
  title?: ReactNode
  children: ReactNode
  footer?: ReactNode
  size?: 'sm' | 'md' | 'lg' | 'xl'
  icon?: ReactNode
}) {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    document.addEventListener('keydown', onKey)
    const unlock = lockBodyScroll()
    return () => {
      document.removeEventListener('keydown', onKey)
      unlock()
    }
  }, [open, onClose])
  const backdrop = useBackdrop(onClose)

  if (!open) return null
  const sizes = { sm: 'max-w-sm', md: 'max-w-lg', lg: 'max-w-2xl', xl: 'max-w-4xl' }
  // The whole dialog fits the window (.max-h-dialog: a phone turned on its side, the keyboard open); its header and
  // footer stay in view and the body between them scrolls.
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center">
      <div className="absolute inset-0 bg-slate-900/50 backdrop-blur-sm animate-fade-in" {...backdrop} />
      <div
        role="dialog"
        aria-modal="true"
        className={cn(
          'relative z-10 flex max-h-dialog w-full flex-col rounded-t-3xl bg-white shadow-lift ring-1 ring-slate-200 animate-slide-up dark:bg-slate-900 dark:ring-slate-800 sm:rounded-3xl sm:animate-scale-in',
          sizes[size],
        )}
      >
        {(title || icon) && (
          <div className="flex shrink-0 items-center gap-3 border-b border-slate-100 px-5 py-4 dark:border-slate-800">
            {icon && (
              <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-brand-600 text-white">
                {icon}
              </span>
            )}
            <h2 dir="auto" className="min-w-0 flex-1 break-words text-start text-lg font-bold">
              {title}
            </h2>
            <button type="button" onClick={onClose} className={CLOSE} aria-label="Close">
              <X className="h-5 w-5" />
            </button>
          </div>
        )}
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-4">{children}</div>
        {footer && (
          <div className={FOOTER}>
            {footer}
          </div>
        )}
      </div>
    </div>,
    document.body,
  )
}

// ---- Drawer ----------------------------------------------------------------
/**
 * A panel for a record the user reads in full, or a list of its own (the
 * bell): a large window in the middle of a wide screen, over the page it
 * came from — the size of the assistant's large window (AiPanelHost), 1.5rem
 * from each edge up to 90rem × 60rem — and a sheet up from the bottom on a
 * phone, where a thumb reaches it. Its height does not follow its content, so
 * switching the bell's tabs does not make it jump; its header and footer stay
 * in view and the body scrolls.
 */
export function Drawer({
  open,
  onClose,
  title,
  subtitle,
  icon,
  children,
  footer,
}: {
  open: boolean
  onClose: () => void
  title?: ReactNode
  subtitle?: ReactNode
  icon?: ReactNode
  children: ReactNode
  footer?: ReactNode
}) {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    document.addEventListener('keydown', onKey)
    const unlock = lockBodyScroll()
    return () => {
      document.removeEventListener('keydown', onKey)
      unlock()
    }
  }, [open, onClose])
  const backdrop = useBackdrop(onClose)

  if (!open) return null
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center sm:p-6">
      <div className="absolute inset-0 bg-slate-900/50 backdrop-blur-sm animate-fade-in" {...backdrop} />
      <div
        role="dialog"
        aria-modal="true"
        className="relative z-10 flex max-h-sheet w-full flex-col rounded-t-3xl bg-white shadow-lift ring-1 ring-slate-200 animate-slide-up dark:bg-slate-900 dark:ring-slate-800 sm:h-full sm:max-h-[60rem] sm:max-w-[90rem] sm:rounded-3xl sm:animate-scale-in"
      >
        <div className="flex shrink-0 items-start gap-3 border-b border-slate-100 px-5 py-4 dark:border-slate-800">
          {icon && <span className="grid h-11 w-11 shrink-0 place-items-center rounded-2xl bg-brand-600 text-white shadow-glow">{icon}</span>}
          <div className="min-w-0 flex-1">
            {/* A record's name in full, over two lines at most, in its own direction: an Arabic name keeps its start. */}
            <h2 dir="auto" className="line-clamp-2 break-words text-start text-xl font-extrabold leading-tight">
              {title}
            </h2>
            {subtitle && <div className="mt-0.5 text-sm text-muted">{subtitle}</div>}
          </div>
          <button type="button" onClick={onClose} className={CLOSE} aria-label="Close">
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-4">{children}</div>
        {footer && (
          <div className={FOOTER}>
            {footer}
          </div>
        )}
      </div>
    </div>,
    document.body,
  )
}

// ---- Empty state -----------------------------------------------------------
export function EmptyState({
  icon,
  title,
  hint,
  action,
}: {
  icon?: ReactNode
  title: string
  hint?: string
  action?: ReactNode
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-slate-300 py-14 text-center dark:border-slate-700">
      {icon && <div className="text-slate-300 dark:text-slate-600">{icon}</div>}
      <div>
        <p className="font-semibold text-slate-700 dark:text-slate-200">{title}</p>
        {hint && <p className="mt-1 text-sm text-muted">{hint}</p>}
      </div>
      {action}
    </div>
  )
}

// ---- Stat tile -------------------------------------------------------------
export function Stat({
  label,
  value,
  sub,
  icon,
  tone = 'blue',
  compact = false,
}: {
  label: string
  value: ReactNode
  sub?: ReactNode
  icon?: ReactNode
  tone?: BadgeTone
  /** Three across on a phone: label and number only. */
  compact?: boolean
}) {
  const bg: Record<BadgeTone, string> = {
    neutral: 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300',
    green: 'bg-emerald-100 text-emerald-600 dark:bg-emerald-500/15 dark:text-emerald-400',
    blue: 'bg-brand-100 text-brand-600 dark:bg-brand-500/15 dark:text-brand-300',
    amber: 'bg-amber-100 text-amber-600 dark:bg-amber-500/15 dark:text-amber-400',
    red: 'bg-rose-100 text-rose-600 dark:bg-rose-500/15 dark:text-rose-400',
    violet: 'bg-violet-100 text-violet-600 dark:bg-violet-500/15 dark:text-violet-300',
  }
  return (
    <Card className={compact ? 'p-3 sm:p-4' : 'p-4'}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-[11px] font-semibold uppercase tracking-wide text-muted sm:text-xs">{label}</p>
          <p className={cn('mt-1 font-bold tabular-nums', compact ? 'text-xl sm:text-2xl' : 'text-2xl')}>{value}</p>
          {sub && <p className={cn('mt-0.5 text-xs text-muted', compact && 'hidden sm:block')}>{sub}</p>}
        </div>
        {icon && <div className={cn('shrink-0 place-items-center rounded-xl', bg[tone], compact ? 'hidden h-10 w-10 sm:grid' : 'grid h-10 w-10')}>{icon}</div>}
      </div>
    </Card>
  )
}
