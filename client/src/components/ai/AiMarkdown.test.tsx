import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { AiAssistantProvider } from './AiAssistantProvider'
import { AiMarkdown } from './AiMarkdown'
import { classifyAiLink } from './links'

// Rendered to a string, as on a server: the router's layout effects say they do nothing there, which is all the test needs.
const consoleError = console.error
beforeAll(() => {
  vi.spyOn(console, 'error').mockImplementation((message?: unknown, ...rest: unknown[]) => {
    if (String(message).includes('useLayoutEffect does nothing on the server')) return
    consoleError(message, ...rest)
  })
})
afterAll(() => vi.restoreAllMocks())

/** The answer's text as the panel draws it, to HTML. */
function render(text: string): string {
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>
        <AiAssistantProvider>
          <AiMarkdown text={text} />
        </AiAssistantProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

describe('an answer’s markdown', () => {
  it('draws GFM tables, lists and code, right to left where the text is', () => {
    const html = render('**أكثر العيوب**\n\n| العيب | القطع |\n|---|---:|\n| Weld porosity | 30 |\n\n- one\n- two\n\n```sql\nSELECT 1\n```')
    expect(html).toContain('<table')
    expect(html).toContain('dir="auto"')
    expect(html).toMatch(/<pre dir="ltr"[^>]*><code dir="ltr"[^>]*>SELECT 1/)
    expect(html).toContain('<ul')
  })

  it('opens a page of the application in place and a web address in a new tab', () => {
    const html = render('[Session #3 · 24-0117](/history?session=abc) and [pricing](https://www.anthropic.com/pricing)')
    expect(html).toContain('href="/history?session=abc"')
    expect(html).toMatch(/href="https:\/\/www\.anthropic\.com\/pricing" target="_blank" rel="noopener noreferrer"/)
  })

  it('never renders a dangerous link, an image or raw HTML', () => {
    const html = render(
      '[click](javascript:alert(1)) [data](data:text/html,x) [proto](//evil.example) ![beacon](https://evil.example/pixel.png) <img src=x onerror=alert(1)> <script>alert(1)</script> <a href="javascript:alert(2)">raw</a>',
    )
    expect(html).not.toMatch(/javascript:/i)
    expect(html).not.toContain('data:text')
    expect(html).not.toContain('evil.example')
    expect(html).not.toContain('<img')
    expect(html).not.toContain('<script')
    expect(html).not.toContain('onerror')
    // A dropped link keeps its words, as plain text; an image goes altogether.
    expect(html).toContain('<span>click</span>')
    expect(html).not.toContain('beacon')
  })

  it('drops a path whose dot segments resolve to another site', () => {
    // Each resolves to "//evil.example/login": as an href, another site, reached by a new-tab open or a modified click.
    for (const href of ['/..//evil.example/login', '/.//evil.example/login', '/%2e%2e//evil.example/login', '/a/..//evil.example/login', '/%2E%2E/%2e//evil.example']) {
      expect(classifyAiLink(href)).toBeNull()
      const html = render(`[Session #3 · 24-0117](${href})`)
      expect(html).not.toContain('evil.example')
      expect(html).not.toContain('href=')
      expect(html).toContain('<span>Session #3 · 24-0117</span>')
    }
    // A path of the app with dot segments in it stays a link, as resolved.
    expect(classifyAiLink('/history/../history?session=abc')).toEqual({ kind: 'app', to: '/history?session=abc' })
  })
})
