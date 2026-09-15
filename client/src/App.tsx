import { Routes, Route, Navigate } from 'react-router-dom'
import { Loader2 } from 'lucide-react'
import { AppShell } from '@/components/layout/AppShell'
import { Brand } from '@/components/brand/Brand'
import { InspectionsPage } from '@/pages/InspectionsPage'
import { WizardPage } from '@/pages/WizardPage'
import { HistoryPage } from '@/pages/HistoryPage'
import { DashboardPage } from '@/pages/DashboardPage'
import { ChatPage } from '@/pages/ChatPage'
import { CoilSearchPage } from '@/pages/CoilSearchPage'
import { PDIPage } from '@/pages/PDIPage'
import { LoginPage } from '@/pages/LoginPage'
import { ConfigurationPage } from '@/pages/admin/ConfigurationPage'
import { DataImportPage } from '@/pages/admin/DataImportPage'
import { UsersPage } from '@/pages/admin/UsersPage'
import { AuditPage } from '@/pages/admin/AuditPage'
import { NoticesPage } from '@/pages/admin/NoticesPage'
import { WhatsNewPage } from '@/pages/admin/WhatsNewPage'
import { useAuth } from '@/store/AuthContext'

function Splash() {
  return (
    <div className="grid min-h-screen place-items-center bg-slate-100 dark:bg-slate-950">
      <div className="flex flex-col items-center gap-4 animate-scale-in">
        <Brand size="lg" />
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
        <Route path="/wizard/:sessionId/edit/:sampleId" element={<WizardPage />} />
        <Route path="/coils" element={<CoilSearchPage />} />
        <Route path="/pdi" element={<PDIPage />} />
        <Route path="/history" element={<HistoryPage />} />
        <Route path="/dashboard" element={<DashboardPage />} />
        <Route path="/chat/:conversationId?" element={<ChatPage />} />
        {/* Administration lives behind the gear; every section keeps its own address. */}
        <Route path="/admin" element={<Navigate to="/admin/configuration" replace />} />
        <Route path="/admin/configuration/:section?" element={<ConfigurationPage />} />
        <Route path="/admin/import" element={<DataImportPage />} />
        <Route path="/admin/users" element={<UsersPage />} />
        <Route path="/admin/audit" element={<AuditPage />} />
        <Route path="/admin/notices" element={<NoticesPage />} />
        <Route path="/admin/whats-new" element={<WhatsNewPage />} />
        <Route path="/audit" element={<Navigate to="/admin/audit" replace />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </AppShell>
  )
}
