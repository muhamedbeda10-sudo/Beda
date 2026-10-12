// ============================================================================
// The account circle at the top right: the person's photo, or their initials
// until they add one. Their name is not written beside it; a tap opens a small
// panel with the name, the role, the photo to add, change or remove, the
// light or dark look of the app, and notifications on this device (on a
// phone, the same sits in the menu).
// ============================================================================

import { useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Camera, Moon, Sun, Trash2 } from 'lucide-react'
import { FloatingPanel } from '@/components/dashboard/filters'
import { useMyAvatar } from '@/services/queries'
import { removeMyAvatar, setMyAvatar } from '@/services/mutations'
import { avatarFromFile } from '@/lib/avatarImage'
import { useAuth } from '@/store/AuthContext'
import { useApp } from '@/store/AppContext'
import { cn } from '@/lib/utils'
import { Avatar } from '@/components/ui/UserAvatar'
import { NotificationSettings } from './NotificationSettings'

/** Light or dark, chosen in the account panel and in the phone's menu; kept on this device. */
export function ThemeSwitch() {
  const { theme, toggleTheme } = useApp()
  const options = [
    { id: 'light', label: 'Light', icon: Sun },
    { id: 'dark', label: 'Dark', icon: Moon },
  ] as const
  return (
    <div role="radiogroup" aria-label="Theme" className="grid grid-cols-2 gap-1 rounded-xl bg-slate-100 p-1 dark:bg-slate-800">
      {options.map((o) => {
        const on = theme === o.id
        return (
          <button
            key={o.id}
            type="button"
            role="radio"
            aria-checked={on}
            onClick={() => {
              if (!on) toggleTheme()
            }}
            className={cn(
              'flex min-h-[40px] items-center justify-center gap-2 rounded-lg px-3 text-sm font-semibold transition-colors touch:min-h-[44px]',
              on ? 'bg-white text-slate-900 shadow-sm dark:bg-slate-950 dark:text-white' : 'text-muted hover:text-slate-800 dark:hover:text-slate-100',
            )}
          >
            <o.icon className="h-4 w-4" aria-hidden />
            {o.label}
          </button>
        )
      })}
    </div>
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
      await setMyAvatar(qc, profile?.id ?? '', await avatarFromFile(file))
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
      await removeMyAvatar(qc, profile?.id ?? '')
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
      {/* The circle stays 36 px; under a finger the target around it is 44, like Sign out beside it. */}
      <button
        ref={anchor}
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`Your account: ${name}`}
        data-tip={open ? undefined : name}
        className="grid place-items-center rounded-full touch:h-11 touch:w-11 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-slate-900"
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
          <ThemeSwitch />
          <NotificationSettings />
        </div>
      </FloatingPanel>
    </>
  )
}
