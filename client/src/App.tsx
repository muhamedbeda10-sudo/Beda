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
import { ErrorBoundary, LoadFailed } from '@/components/ui/ErrorBoundary'
import { useAuth } from '@/store/AuthContext'
import { useAiMe } from '@/services/queries'
import { useAi } from '@/components/ai/AiAssistantProvider'
import { AiAddress } from '@/components/ai/AiAddress'
import { can, type Capability } from '@qc/shared/rules'
import { lazy, Suspense, type ReactElement } from 'react'
import { usePushBridge } from '@/lib/push'

// §20 — the assistant's settings are its owner's alone: fetched when first opened, in nobody else's bundle.
const AiAssistantPage = lazy(() => import('@/pages/admin/AiAssistantPage').then((m) => ({ default: m.AiAssistantPage })))
// §20 — the assistant's full page, for the people given it: fetched when first opened, like its panel.
// §21 — automations: their pages for the few who may create them, a delivered report for whoever it went to.
const AutomationsPage = lazy(() => import('@/pages/AutomationsPage').then((m) => ({ default: m.AutomationsPage })))
const AutomationPage = lazy(() => import('@/pages/AutomationPage').then((m) => ({ default: m.AutomationPage })))
const AutomationDeliveryPage = lazy(() => import('@/pages/AutomationDeliveryPage').then((m) => ({ default: m.AutomationDeliveryPage })))
// §21 — follow-ups: the list and, over it, the one opened (/follow-ups/<id>); the server says whose each person sees.
const FollowUpsPage = lazy(() => import('@/pages/FollowUpsPage').then((m) => ({ default: m.FollowUpsPage })))
const TasksPage = lazy(() => import('@/pages/TasksPage').then((m) => ({ default: m.TasksPage })))
const TaskPage = lazy(() => import('@/pages/TaskPage').then((m) => ({ default: m.TaskPage })))
const PlaybookPage = lazy(() => import('@/pages/PlaybookPage').then((m) => ({ default: m.PlaybookPage })))

/** A page for a capability the signed-in role lacks sends the reader home; the API refuses it anyway. */
function Only({ cap, children }: { cap: Capability; children: ReactElement }) {
  const { role } = useAuth()
  return can(role, cap) ? children : <Navigate to="/" replace />
}

/**
 * §20 — the AI assistant's settings, for the one person who owns it (/ai/me
 * says who), whatever their role. Anyone else is sent home as from an address
 * that does not exist — the server answers them 404 as well.
 */
function OnlyAiOwner({ children }: { children: ReactElement }) {
  const { data, isError } = useAiMe()
  if (data) return data.owner ? children : <Navigate to="/" replace />
  return isError ? <LoadFailed what="This page" /> : <PageLoading />
}

/**
 * §20 — the assistant's pages (its addresses, which open its popup; the
 * Playbook), for the people the owner gave it to (/ai/me says who), whatever
 * their role. Anyone else is sent home; someone it was taken from while the
 * page was open stays, to be told so.
 */
function OnlyAiGranted({ children }: { children: ReactElement }) {
  const { data, isError } = useAiMe()
  const { revoked } = useAi()
  if (data) return data.granted || revoked ? children : <Navigate to="/" replace />
  return isError ? <LoadFailed what="This page" /> : <PageLoading />
}

/**
 * §21 — the Automations pages, for the people who may create automations
 * (/ai/me says who: the assistant's owner, and those the owner allowed),
 * whatever their role. Anyone else is sent home — the server answers them
 * 404 as well.
 */
function OnlyAutomator({ children }: { children: ReactElement }) {
  const { data, isError } = useAiMe()
  if (data) return data.automations ? children : <Navigate to="/" replace />
  return isError ? <LoadFailed what="This page" /> : <PageLoading />
}

/** A page fetched when first opened, with a word should its file not arrive. */
function LazyPage({ what, children }: { what: string; children: ReactElement }) {
  return (
    <ErrorBoundary fallback={<LoadFailed what={what} />}>
      <Suspense fallback={<PageLoading />}>{children}</Suspense>
    </ErrorBoundary>
  )
}

/** A page still being fetched: a spinner where it will be. */
function PageLoading() {
  return (
    <p className="flex items-center justify-center gap-2 py-16 text-sm text-muted">
      <Loader2 className="h-4 w-4 animate-spin" /> Loading…
    </p>
  )
}

/** §24 — pushes while the app is open: the chime and a refresh; a tapped notification opens its page. */
function PushBridge({ userId }: { userId: string }) {
  usePushBridge(userId)
  return null
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
      <PushBridge userId={profile.id} />
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
        {/* §20 — the assistant's addresses (/ai?c=<conversation>, /ai/reports/<id>) open its popup, large, on that place. */}
        <Route path="/ai/*" element={<OnlyAiGranted><AiAddress /></OnlyAiGranted>} />
        {/* §21 — automations; a delivered report opens for the people it was sent to (the server decides who). */}
        <Route path="/automations" element={<OnlyAutomator><LazyPage what="This page"><AutomationsPage /></LazyPage></OnlyAutomator>} />
        <Route path="/automations/deliveries/:id" element={<LazyPage what="This report"><AutomationDeliveryPage /></LazyPage>} />
        <Route path="/automations/:id" element={<OnlyAutomator><LazyPage what="This page"><AutomationPage /></LazyPage></OnlyAutomator>} />
        <Route path="/follow-ups/:id?" element={<LazyPage what="Follow-ups"><FollowUpsPage /></LazyPage>} />
        <Route path="/tasks" element={<LazyPage what="Tasks"><TasksPage /></LazyPage>} />
        <Route path="/tasks/:id" element={<LazyPage what="The task"><TaskPage /></LazyPage>} />
        <Route path="/playbook" element={<OnlyAiGranted><LazyPage what="The playbook"><PlaybookPage /></LazyPage></OnlyAiGranted>} />
        {/* Administration lives behind the gear; every section keeps its own address. */}
        <Route path="/admin" element={<Navigate to="/admin/configuration" replace />} />
        <Route path="/admin/configuration/:section?" element={<Only cap="manage-admin-data"><ConfigurationPage /></Only>} />
        <Route path="/admin/import" element={<Only cap="manage-admin-data"><DataImportPage /></Only>} />
        <Route path="/admin/users" element={<Only cap="manage-admin-data"><UsersPage /></Only>} />
        <Route path="/admin/audit" element={<Only cap="edit-closed-session"><AuditPage /></Only>} />
        <Route path="/admin/notices" element={<Only cap="manage-admin-data"><NoticesPage /></Only>} />
        <Route path="/admin/whats-new" element={<Only cap="manage-admin-data"><WhatsNewPage /></Only>} />
        <Route path="/admin/ai" element={<OnlyAiOwner><ErrorBoundary fallback={<LoadFailed what="This page" />}><Suspense fallback={<PageLoading />}><AiAssistantPage /></Suspense></ErrorBoundary></OnlyAiOwner>} />
        <Route path="/audit" element={<Navigate to="/admin/audit" replace />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </AppShell>
  )
}
