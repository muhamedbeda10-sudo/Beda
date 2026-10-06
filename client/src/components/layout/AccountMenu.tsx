// ============================================================================
// The account circle at the top right: the person's photo, or their initials
// until they add one. Their name is not written beside it; a tap opens a small
// panel with the name, the role, and the photo to add, change or remove.
// ============================================================================

import { useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Camera, Trash2 } from 'lucide-react'
import { FloatingPanel } from '@/components/dashboard/filters'
import { useMyAvatar } from '@/services/queries'
import { removeMyAvatar, setMyAvatar } from '@/services/mutations'
import { avatarFromFile } from '@/lib/avatarImage'
import { useAuth } from '@/store/AuthContext'
import { useApp } from '@/store/AppContext'
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

/** The circle itself: the photo when there is one, else the initials. */
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

/** Add, change or remove one's own photo; used in the panel and in the phone's menu. */
export function AvatarEditor({ name, size = 64 }: { name: string; size?: number }) {
  const qc = useQueryClient()
  const { toast } = useApp()
  const { profile } = useAuth()
  const { data } = useMyAvatar(!!profile)
  const input = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState<'upload' | 'remove' | null>(null)
  const photo = data?.dataUrl ?? null

  async function chosen(file: File | undefined) {
    if (!file) return
    setBusy('upload')
    try {
      await setMyAvatar(qc, await avatarFromFile(file))
      toast('Your photo is set.', 'success')
    } catch (e) {
      toast(e instanceof Error ? e.message : 'The photo could not be saved.', 'error')
    } finally {
      setBusy(null)
      if (input.current) input.current.value = ''
    }
  }

  async function remove() {
    setBusy('remove')
    try {
      await removeMyAvatar(qc)
      toast('Your photo is removed; your initials show instead.', 'success')
    } catch (e) {
      toast(e instanceof Error ? e.message : 'The photo could not be removed.', 'error')
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="flex items-center gap-3">
      <button type="button" onClick={() => input.current?.click()} disabled={busy !== null} aria-label={photo ? 'Change your photo' : 'Add your photo'} data-tip={photo ? 'Change your photo' : 'Add your photo'} className="group relative shrink-0 rounded-full focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500">
        <Avatar name={name} dataUrl={photo} size={size} className={cn(busy && 'opacity-60')} />
        <span className="absolute -bottom-0.5 -right-0.5 grid h-6 w-6 place-items-center rounded-full bg-white text-slate-700 shadow ring-1 ring-slate-200 transition-colors group-hover:text-brand-700 dark:bg-slate-800 dark:text-slate-200 dark:ring-slate-700">
          <Camera className="h-3.5 w-3.5" />
        </span>
      </button>
      <div className="flex min-w-0 flex-col items-start gap-1">
        <button type="button" onClick={() => input.current?.click()} disabled={busy !== null} className="inline-flex min-h-[32px] items-center gap-1.5 rounded-md px-1 text-13 font-semibold text-brand-600 hover:underline disabled:opacity-50 dark:text-brand-400 touch:min-h-[44px]">
          <Camera className="h-4 w-4" /> {busy === 'upload' ? 'Saving…' : photo ? 'Change photo' : 'Add a photo'}
        </button>
        {photo && (
          <button type="button" onClick={() => void remove()} disabled={busy !== null} className="inline-flex min-h-[32px] items-center gap-1.5 rounded-md px-1 text-13 font-semibold text-muted hover:text-rose-600 disabled:opacity-50 touch:min-h-[44px]">
            <Trash2 className="h-4 w-4" /> {busy === 'remove' ? 'Removing…' : 'Remove photo'}
          </button>
        )}
      </div>
      <input ref={input} type="file" accept="image/*" className="hidden" onChange={(e) => void chosen(e.target.files?.[0])} />
    </div>
  )
}

/** The circle at the top right, and the panel it opens. */
export function AccountMenu({ name, role, username }: { name: string; role: string; username?: string }) {
  const anchor = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const { profile } = useAuth()
  const { data } = useMyAvatar(!!profile)
  return (
    <>
      <button
        ref={anchor}
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`Your account: ${name}`}
        data-tip={open ? undefined : name}
        className="rounded-full focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-slate-900"
      >
        <Avatar name={name} dataUrl={data?.dataUrl} size={36} />
      </button>
      <FloatingPanel anchor={anchor} open={open} onClose={() => setOpen(false)} width={280} label="Your account">
        <div className="space-y-3 p-2">
          <div className="min-w-0">
            <p className="truncate text-sm font-bold text-slate-900 dark:text-slate-100">{name}</p>
            <p className="truncate text-xs capitalize text-muted">
              {role}
              {username && <span className="normal-case"> · {username}</span>}
            </p>
          </div>
          <AvatarEditor name={name} />
        </div>
      </FloatingPanel>
    </>
  )
}
