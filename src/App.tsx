import { Routes, Route, Navigate } from 'react-router-dom'
import { Loader2, ShieldCheck } from 'lucide-react'
import { AppShell } from '@/components/layout/AppShell'
import { InspectionsPage } from '@/pages/InspectionsPage'
import { SessionPage } from '@/pages/SessionPage'
import { OrderSummaryPage } from '@/pages/OrderSummaryPage'
import { AnalyticsPage } from '@/pages/AnalyticsPage'
import { HistoryPage } from '@/pages/HistoryPage'
import { SettingsPage } from '@/pages/SettingsPage'
import { AuditPage } from '@/pages/AuditPage'
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
  const { ready, firebaseEnabled, profile } = useAuth()

  if (firebaseEnabled && !ready) return <Splash />
  if (firebaseEnabled && !profile) return <LoginPage />

  return (
    <AppShell>
      <Routes>
        <Route path="/" element={<InspectionsPage />} />
        <Route path="/session/:id" element={<SessionPage />} />
        <Route path="/orders" element={<OrderSummaryPage />} />
        <Route path="/analytics" element={<AnalyticsPage />} />
        <Route path="/history" element={<HistoryPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="/audit" element={<AuditPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </AppShell>
  )
}
