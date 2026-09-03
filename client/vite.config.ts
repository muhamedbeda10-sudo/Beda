import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath, URL } from 'node:url'

// In development the API runs on its own port; `/api` is proxied to it so the
// browser sees one origin, exactly as it will in production where the API
// serves the built client itself.
const API_PROXY_TARGET = process.env.VITE_API_PROXY ?? 'http://localhost:8080'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    host: true,
    port: 5173,
    proxy: {
      '/api': { target: API_PROXY_TARGET, changeOrigin: false },
    },
  },
  preview: { host: true, port: 4173 },
  build: {
    chunkSizeWarningLimit: 900,
    rollupOptions: {
      output: {
        manualChunks: {
          react: ['react', 'react-dom', 'react-router-dom', '@tanstack/react-query'],
        },
      },
    },
  },
  test: {
    environment: 'node',
    globals: true,
  },
})
