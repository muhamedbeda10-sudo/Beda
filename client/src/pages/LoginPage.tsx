import { useEffect, useState } from 'react'
import { LogIn, UserPlus, Loader2, AtSign, Lock, User as UserIcon } from 'lucide-react'
import { Brand } from '@/components/brand/Brand'
import { useAuth } from '@/store/AuthContext'
import { Button, Input, Field } from '@/components/ui'
import { useApp } from '@/store/AppContext'

const MIN_PASSWORD_LENGTH = 8
/** Mirrors the API's rule: 2–40 letters, digits, dots, dashes or underscores. */
const USERNAME_PATTERN = '[A-Za-z0-9][A-Za-z0-9._\-]{1,39}'

export function LoginPage() {
  const { signIn, signUp, error, selfRegistrationOpen } = useAuth()
  const { theme } = useApp()
  const [mode, setMode] = useState<'in' | 'up'>('in')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)

  // If registration closes (an admin already exists), fall back to sign-in.
  useEffect(() => {
    if (!selfRegistrationOpen && mode === 'up') setMode('in')
  }, [selfRegistrationOpen, mode])

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    try {
      const login = username.trim().toLowerCase()
      if (mode === 'in') await signIn(login, password)
      else await signUp(login, password, name.trim() || login)
    } catch {
      /* error surfaced via context */
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={theme === 'dark' ? 'dark' : ''}>
      <div className="flex min-h-screen items-center justify-center bg-slate-100 px-4 dark:bg-slate-950">
        <div className="w-full max-w-md">
          <div className="mb-6 flex flex-col items-center text-center animate-scale-in">
            <Brand size="lg" />
            <p className="mt-3 text-sm text-slate-500 dark:text-slate-400">Inspection Recorder</p>
          </div>

          <div className="card p-6 shadow-hover">
            {selfRegistrationOpen && (
              <div className="mb-4 inline-flex w-full rounded-xl bg-slate-100 p-1 dark:bg-slate-800">
                {(['in', 'up'] as const).map((m) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => setMode(m)}
                    className={`flex-1 rounded-lg px-3 py-2 text-sm font-semibold transition-colors ${
                      mode === m ? 'bg-white text-brand-600 shadow-sm dark:bg-slate-700 dark:text-white' : 'text-slate-500'
                    }`}
                  >
                    {m === 'in' ? 'Sign in' : 'Create account'}
                  </button>
                ))}
              </div>
            )}

            <form onSubmit={submit} className="space-y-3">
              {mode === 'up' && (
                <Field label="Full name">
                  <div className="relative">
                    <UserIcon className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                    <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Mohamed Abdelrahman" className="pl-9" />
                  </div>
                </Field>
              )}
              <Field label="Username" hint={mode === 'up' ? 'Letters, digits, dots, dashes or underscores.' : undefined}>
                <div className="relative">
                  <AtSign className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                  <Input
                    type="text"
                    autoComplete="username"
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                    required
                    pattern={USERNAME_PATTERN}
                    title="2–40 letters, digits, dots, dashes or underscores"
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    placeholder="m.abdelrahman"
                    className="pl-9"
                  />
                </div>
              </Field>
              <Field label="Password" hint={mode === 'up' ? `At least ${MIN_PASSWORD_LENGTH} characters.` : undefined}>
                <div className="relative">
                  <Lock className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                  <Input
                    type="password"
                    autoComplete={mode === 'in' ? 'current-password' : 'new-password'}
                    required
                    minLength={mode === 'up' ? MIN_PASSWORD_LENGTH : 1}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="••••••••"
                    className="pl-9"
                  />
                </div>
              </Field>

              {error && (
                <p className="rounded-lg bg-rose-50 px-3 py-2 text-sm font-medium text-rose-600 dark:bg-rose-500/10 dark:text-rose-400">
                  {error}
                </p>
              )}

              <Button type="submit" variant="primary" className="w-full" disabled={busy}>
                {busy ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : mode === 'in' ? (
                  <LogIn className="h-4 w-4" />
                ) : (
                  <UserPlus className="h-4 w-4" />
                )}
                {mode === 'in' ? 'Sign in' : 'Create account'}
              </Button>
            </form>
          </div>

          <p className="mt-5 text-center text-xs text-slate-400">
            {selfRegistrationOpen
              ? 'The first account created becomes the administrator · roles are managed in Admin → Users'
              : 'Accounts are created by your quality administrator'}
          </p>
        </div>
      </div>
    </div>
  )
}
