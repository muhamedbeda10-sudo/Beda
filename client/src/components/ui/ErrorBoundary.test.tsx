import { afterEach, describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { ErrorBoundary, LoadFailed, isStaleChunkError, mayReloadForStaleChunk } from './ErrorBoundary'

describe('a part of the app that failed to draw', () => {
  it('draws its children until one throws, then the fallback in their place, with the error', () => {
    // Rendered on a server React never catches, so the boundary is driven as React drives it.
    const boundary = new ErrorBoundary({ fallback: (e: Error) => `fallback: ${e.message}`, children: 'children' })
    expect(boundary.render()).toBe('children')
    boundary.state = ErrorBoundary.getDerivedStateFromError(new TypeError('x is undefined'))
    expect(boundary.render()).toBe('fallback: x is undefined')
    // Whatever was thrown, an Error.
    expect(ErrorBoundary.getDerivedStateFromError('plain').error.message).toBe('plain')
  })

  it('says what could not be loaded, with Reload, the caller’s own way out, and what broke', () => {
    const html = renderToStaticMarkup(<LoadFailed what="The assistant" action={<button type="button">Close</button>} error={new TypeError('x is undefined')} />)
    expect(html).toContain('role="alert"')
    expect(html).toContain('The assistant could not be loaded.')
    expect(html).toContain('Reload')
    expect(html).toContain('<button type="button">Close</button>')
    expect(html).toContain('Technical details')
    expect(html).toContain('TypeError: x is undefined')
    expect(renderToStaticMarkup(<LoadFailed what="The page" />)).not.toContain('Technical details')
  })
})

describe('a file of the app gone after a deploy', () => {
  const store = new Map<string, string>()
  ;(globalThis as { sessionStorage?: unknown }).sessionStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
  }
  afterEach(() => store.clear())

  it('is told from any other failure, in each browser’s words', () => {
    expect(isStaleChunkError(new TypeError('Failed to fetch dynamically imported module: https://qc/assets/ai-AiPopup-1a2b.js'))).toBe(true)
    expect(isStaleChunkError(new TypeError('Importing a module script failed.'))).toBe(true)
    expect(isStaleChunkError(new Error('error loading dynamically imported module'))).toBe(true)
    expect(isStaleChunkError(new Error('Unable to preload CSS for /assets/fonts-3c4d.css'))).toBe(true)
    expect(isStaleChunkError(new TypeError("Cannot read properties of undefined (reading 'map')"))).toBe(false)
  })

  it('reloads the page once a minute at most, so a file truly missing cannot loop', () => {
    expect(mayReloadForStaleChunk(1_000_000)).toBe(true)
    expect(mayReloadForStaleChunk(1_030_000)).toBe(false)
    expect(mayReloadForStaleChunk(1_061_000)).toBe(true)
  })
})
