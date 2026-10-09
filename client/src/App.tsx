import { Routes, Route, Navigate } from 'react-router-dom'
import { Loader2 } from 'lucide-react'
import { AppShell } from '@/components/layout/AppShell'
import { Brand } from '@/components/brand/Brand'
import { InspectionsPage } from '@/pages/InspectionsPage'
import { WizardPage } from '@/pages/WizardPage'
import { HistoryPage } from '@/pages/HistoryPage'
import { AccessPage } from '@/pages/AccessPage'
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
import { can, type Capability } from '@qc/shared/rules'
import { lazy, Suspense, type ReactElement } from 'react'

// §20 — the assistant's administration is for administrators alone: fetched when first opened, never in an inspector's bundle.
const AiAssistantPage = lazy(() => import('@/pages/admin/AiAssistantPage').then((m) => ({ default: m.AiAssistantPage })))

/** A page for a capability the signed-in role lacks sends the reader home; the API refuses it anyway. */
function Only({ cap, children }: { cap: Capability; children: ReactElement }) {
  const { role } = useAuth()
  return can(role, cap) ? children : <Navigate to="/" replace />
}

/** A page still being fetched: a spinner where it will be. */
function PageLoading() {
  return (
    <p className="flex items-center justify-center gap-2 py-16 text-sm text-muted">
      <Loader2 className="h-4 w-4 animate-spin" /> Loading…
    </p>
  )
}

function Splash() {
  return (
    <div className="grid min-h-screen place-items-center bg-slate-100 dark:bg-slate-950">
      <div className="flex flex-col items-center gap-4 animate-scale-in">
        <Brand size="lg" />
        <Loader2 className="h-5 w-5 animate-spin text-muted" />
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
        <Route path="/wizard/:sessionId" element={<Only cap="record-inspection"><WizardPage /></Only>} />
        <Route path="/wizard/:sessionId/edit/:sampleId" element={<Only cap="record-inspection"><WizardPage /></Only>} />
        <Route path="/coils" element={<Only cap="record-inspection"><CoilSearchPage /></Only>} />
        <Route path="/pdi" element={<Only cap="record-inspection"><PDIPage /></Only>} />
        <Route path="/history" element={<HistoryPage />} />
        <Route path="/access" element={<Only cap="view-order-sheet"><AccessPage /></Only>} />
        <Route path="/dashboard" element={<Only cap="view-dashboard"><DashboardPage /></Only>} />
        <Route path="/chat/:conversationId?" element={<Only cap="use-chat"><ChatPage /></Only>} />
        {/* Administration lives behind the gear; every section keeps its own address. */}
        <Route path="/admin" element={<Navigate to="/admin/configuration" replace />} />
        <Route path="/admin/configuration/:section?" element={<Only cap="manage-admin-data"><ConfigurationPage /></Only>} />
        <Route path="/admin/import" element={<Only cap="manage-admin-data"><DataImportPage /></Only>} />
        <Route path="/admin/users" element={<Only cap="manage-admin-data"><UsersPage /></Only>} />
        <Route path="/admin/audit" element={<Only cap="edit-closed-session"><AuditPage /></Only>} />
        <Route path="/admin/notices" element={<Only cap="manage-admin-data"><NoticesPage /></Only>} />
        <Route path="/admin/whats-new" element={<Only cap="manage-admin-data"><WhatsNewPage /></Only>} />
        <Route path="/admin/ai" element={<Only cap="use-ai-assistant"><Suspense fallback={<PageLoading />}><AiAssistantPage /></Suspense></Only>} />
        <Route path="/audit" element={<Navigate to="/admin/audit" replace />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </AppShell>
  )
}
