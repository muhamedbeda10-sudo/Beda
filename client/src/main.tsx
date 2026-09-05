import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import App from './App'
import { AppProvider } from './store/AppContext'
import { AuthProvider } from './store/AuthContext'
import { ApiError } from './lib/api'
import './index.css'
import { registerSW } from 'virtual:pwa-register'

// The service worker that makes the app installable and keeps its shell
// ready. A new deploy is picked up on the next load without asking.
registerSW({ immediate: true })

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
        </AuthProvider>
      </AppProvider>
    </QueryClientProvider>
  </React.StrictMode>,
)
