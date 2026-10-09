import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'
import { fileURLToPath, URL } from 'node:url'

// In development the API runs on its own port; `/api` is proxied to it so the
// browser sees one origin, exactly as it will in production where the API
// serves the built client itself.
const API_PROXY_TARGET = process.env.VITE_API_PROXY ?? 'http://localhost:8080'

/**
 * A chunk only the AI assistant loads — its panel, its owner's settings page
 * and what those two share. Named `ai-…`, so the service worker leaves it out
 * of the precache: it is fetched the first time someone given the assistant
 * opens it, never downloaded by every phone on install and on each deploy.
 */
const AI_MODULE = /\/src\/components\/ai\/|\/src\/pages\/admin\/AiAssistantPage\./
const isAiChunk = (chunk: { moduleIds: readonly string[] }) => chunk.moduleIds.some((id) => AI_MODULE.test(id))

export default defineConfig({
  plugins: [
    react(),
    // Installable on a phone or tablet. The shell (HTML, scripts, styles,
    // icons) is precached so the app opens instantly from the home screen;
    // the API is never cached — every read still goes to the server, and the
    // wizard's own draft store covers a dead network.
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['brand/*.svg', 'icons/*.png'],
      manifest: {
        name: 'LinkMisr Quality Control',
        short_name: 'LinkMisr QC',
        description: 'Inspection recorder for the LinkMisr factories.',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        orientation: 'any',
        background_color: '#ffffff',
        theme_color: '#1e46a8',
        lang: 'en',
        categories: ['productivity', 'business'],
        icons: [
          { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: '/icons/maskable-192.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' },
          { src: '/icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,mjs,css,html,svg,png,woff2}'],
        // The assistant's chunks (isAiChunk) are fetched when someone given the assistant first opens them.
        globIgnores: ['**/node_modules/**/*', '**/ai-*.js'],
        navigateFallback: '/index.html',
        // API calls and image bytes are never answered from the cache, nor the Access sync agent's files, downloaded as they are.
        navigateFallbackDenylist: [/^\/api\//, /^\/agent\//],
        cleanupOutdatedCaches: true,
        clientsClaim: true,
        skipWaiting: true,
      },
    }),
  ],
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
        chunkFileNames: (chunk) => (isAiChunk(chunk) ? 'assets/ai-[name]-[hash].js' : 'assets/[name]-[hash].js'),
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
