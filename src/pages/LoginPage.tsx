import { useState } from 'react'
import { ShieldCheck, LogIn, UserPlus, Loader2, Mail, Lock, User as UserIcon } from 'lucide-react'
import { useAuth } from '@/store/AuthContext'
import { Button, Input, Field } from '@/components/ui'
import { useApp } from '@/store/AppContext'

export function LoginPage() {
  const { signIn, signUp, error } = useAuth()
  const { theme } = useApp()
  const [mode, setMode] = useState<'in' | 'up'>('in')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    try {
      if (mode === 'in') await signIn(email.trim(), password)
      else await signUp(email.trim(), password, name.trim() || email.split('@')[0])
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
          <div className="mb-6 flex flex-col items-center text-center">
            <span className="grid h-16 w-16 place-items-center rounded-2xl bg-brand-600 text-white shadow-lift">
              <ShieldCheck className="h-9 w-9" />
            </span>
            <h1 className="mt-4 text-2xl font-extrabold tracking-tight">QC SYSTEM</h1>
            <p className="text-sm text-slate-500 dark:text-slate-400">Inspection Recorder</p>
          </div>

          <div className="card p-6">
            <div className="mb-4 inline-flex w-full rounded-xl bg-slate-100 p-1 dark:bg-slate-800">
              {(['in', 'up'] as const).map((m) => (
                <button
                  key={m}
                  onClick={() => setMode(m)}
                  className={`flex-1 rounded-lg px-3 py-2 text-sm font-semibold transition-colors ${
                    mode === m ? 'bg-white text-brand-600 shadow-sm dark:bg-slate-700 dark:text-white' : 'text-slate-500'
                  }`}
                >
                  {m === 'in' ? 'Sign in' : 'Create account'}
                </button>
              ))}
            </div>

            <form onSubmit={submit} className="space-y-3">
              {mode === 'up' && (
                <Field label="Full name">
                  <div className="relative">
                    <UserIcon className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                    <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Mohamed Abdelrahman" className="pl-9" />
                  </div>
                </Field>
              )}
              <Field label="Email">
                <div className="relative">
                  <Mail className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                  <Input
                    type="email"
                    autoComplete="email"
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="you@factory.com"
                    className="pl-9"
                  />
                </div>
              </Field>
              <Field label="Password">
                <div className="relative">
                  <Lock className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                  <Input
                    type="password"
                    autoComplete={mode === 'in' ? 'current-password' : 'new-password'}
                    required
                    minLength={6}
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
            Secured by Firebase Authentication · roles managed by your quality admin
          </p>
        </div>
      </div>
    </div>
  )
}
