import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import App from './App'
import { AppProvider } from './store/AppContext'
import { AuthProvider } from './store/AuthContext'
import { ApiError } from './lib/api'
import { TooltipLayer } from './components/ui/Tooltip'
// Inter ships with the application (Latin, the weights the interface uses), so a tablet on the floor with no internet still gets it.
import '@fontsource/inter/latin-400.css'
import '@fontsource/inter/latin-500.css'
import '@fontsource/inter/latin-600.css'
import '@fontsource/inter/latin-700.css'
import '@fontsource/inter/latin-800.css'
import './index.css'
import { registerSW } from 'virtual:pwa-register'
import { appUpdates } from './lib/appUpdate'

// The service worker that makes the app installable and keeps its shell
// ready. A new deploy is picked up without asking — but never under someone
// typing: it is swapped in and the page reloaded at once when nothing unsaved
// is open, and otherwise as soon as the person saves or leaves (lib/appUpdate.ts).
// A tablet on the floor stays open for a whole shift: besides the check on
// each load, ask for a new build every hour so a deploy reaches it without
// anyone reloading.
// A sleeping tablet pauses that timer, so it also asks when the screen comes
// back on and when the network returns — at most every five minutes.
const UPDATE_CHECK_GAP = 5 * 60 * 1000
const updateSW = registerSW({
  immediate: true,
  // A new version is installed and waiting: swap it in (this page then reloads into it).
  onNeedRefresh() {
    appUpdates.whenFree(() => void updateSW(true))
  },
  // The new version took over — swapped in here, or by another tab: reload into it.
  onNeedReload() {
    appUpdates.whenFree(() => window.location.reload())
  },
  onRegisteredSW(_url, registration) {
    if (!registration) return
    let lastCheck = Date.now()
    const check = () => {
      if (Date.now() - lastCheck < UPDATE_CHECK_GAP) return
      lastCheck = Date.now()
      void registration.update().catch(() => {})
    }
    window.setInterval(() => {
      lastCheck = 0
      check()
    }, 60 * 60 * 1000)
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') check()
    })
    window.addEventListener('online', check)
  },
})

// Reads are cached per screen and re-fetched when the tab regains focus, so a
// tablet that was asleep shows current data without a manual reload. A 4xx is
// never retried — it will not change on the second try.
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 15_000,
      refetchOnWindowFocus: true,
      retry: (failureCount, error) => {
        if (error instanceof ApiError && error.status > 0 && error.status < 500) return false
        return failureCount < 2
      },
    },
  },
})

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <AppProvider>
        <AuthProvider>
          <BrowserRouter>
            <App />
          </BrowserRouter>
          <TooltipLayer />
        </AuthProvider>
      </AppProvider>
    </QueryClientProvider>
  </React.StrictMode>,
)
