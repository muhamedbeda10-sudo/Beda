import { Routes, Route, Navigate } from 'react-router-dom'
import { Loader2, ShieldCheck } from 'lucide-react'
import { AppShell } from '@/components/layout/AppShell'
import { InspectionsPage } from '@/pages/InspectionsPage'
import { WizardPage } from '@/pages/WizardPage'
import { HistoryPage } from '@/pages/HistoryPage'
import { SettingsPage } from '@/pages/SettingsPage'
import { AuditPage } from '@/pages/AuditPage'
import { CoilSearchPage } from '@/pages/CoilSearchPage'
import { PDIPage } from '@/pages/PDIPage'
import { LoginPage } from '@/pages/LoginPage'
import { useAuth } from '@/store/AuthContext'

function Splash() {
  return (
    <div className="grid min-h-screen place-items-center bg-slate-100 dark:bg-slate-950">
      <div className="flex flex-col items-center gap-3">
        <span className="grid h-14 w-14 place-items-center rounded-2xl bg-brand-600 text-white">
          <ShieldCheck className="h-8 w-8" />
        </span>
        <Loader2 className="h-5 w-5 animate-spin text-slate-400" />
      </div>
    </div>
  )
}

export default function App() {
  const { ready, profile } = useAuth()

  if (!ready) return <Splash />
  if (!profile) return <LoginPage />

  return (
    <AppShell>
      <Routes>
        <Route path="/" element={<InspectionsPage />} />
        <Route path="/wizard/:sessionId" element={<WizardPage />} />
        <Route path="/coils" element={<CoilSearchPage />} />
        <Route path="/pdi" element={<PDIPage />} />
        <Route path="/history" element={<HistoryPage />} />
        <Route path="/admin" element={<SettingsPage />} />
        <Route path="/audit" element={<AuditPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </AppShell>
  )
}
