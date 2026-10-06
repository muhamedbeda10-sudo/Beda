// ============================================================================
// A person's circle: their photo when they have set one, their initials until
// then. One look everywhere — the account circle, the chat's lists, members
// and messages.
// ============================================================================

import { useUserAvatar } from '@/services/queries'
import { cn } from '@/lib/utils'

/** "Mohamed Beda" → "MB". */
export function initialsOf(name: string | null | undefined): string {
  return (
    (name ?? '')
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .map((w) => w[0]?.toUpperCase() ?? '')
      .join('') || '?'
  )
}

/** The circle for a given picture, or the initials when there is none. */
export function Avatar({ name, dataUrl, size = 36, className }: { name: string; dataUrl: string | null | undefined; size?: number; className?: string }) {
  return dataUrl ? (
    <img src={dataUrl} alt="" width={size} height={size} style={{ width: size, height: size }} className={cn('shrink-0 rounded-full object-cover shadow-card ring-1 ring-black/5 dark:ring-white/10', className)} />
  ) : (
    <span
      aria-hidden
      style={{ width: size, height: size, fontSize: Math.round(size * 0.34) }}
      className={cn('grid shrink-0 place-items-center rounded-full bg-gradient-to-br from-brand-600 to-brand-800 font-bold text-white shadow-card', className)}
    >
      {initialsOf(name)}
    </span>
  )
}

/** A colleague's circle: their small photo, fetched with the others on screen, or their initials. */
export function UserAvatar({ userId, name, size = 36, className }: { userId: string; name: string; size?: number; className?: string }) {
  const { data } = useUserAvatar(userId)
  return <Avatar name={name} dataUrl={data} size={size} className={className} />
}
