import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { AppProvider } from '@/store/AppContext'
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
  // The app's provider reads the theme it was left in; there is no browser storage here.
  const stored = new Map<string, string>([['qc-system-theme', 'light']])
  vi.stubGlobal('localStorage', { getItem: (k: string) => stored.get(k) ?? null, setItem: (k: string, v: string) => void stored.set(k, v), removeItem: (k: string) => void stored.delete(k) })
})
afterAll(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

/** The answer's text as the panel draws it, to HTML. */
function render(text: string, caret = false): string {
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <AppProvider>
        <MemoryRouter>
          <AiAssistantProvider>
            <AiMarkdown text={text} caret={caret} />
          </AiAssistantProvider>
        </MemoryRouter>
      </AppProvider>
    </QueryClientProvider>,
  )
}

/** The cells of the first table, in order: each one's tag, attributes and text. */
function cells(html: string): { tag: string; attrs: string; text: string }[] {
  return [...html.matchAll(/<(t[hd])\b([^>]*)>([\s\S]*?)<\/\1>/g)].map((m) => ({ tag: m[1], attrs: m[2], text: m[3].replace(/<[^>]+>/g, '') }))
}

describe('an answer’s markdown', () => {
  it('draws GFM tables, lists and code, right to left where the text is', () => {
    const html = render('**أكثر العيوب**\n\n| العيب | القطع |\n|---|---:|\n| Weld porosity | 30 |\n\n- one\n- two\n\n```sql\nSELECT 1\n```')
    expect(html).toContain('<table')
    expect(html).toContain('dir="auto"')
    expect(html).toMatch(/<pre dir="ltr"[^>]*><code dir="ltr"[^>]*>SELECT 1/)
    expect(html).toContain('<ul')
  })

  it('aligns a column of figures to the end in left-to-right digits, as written, and reads an Arabic table right to left', () => {
    const html = render('| العيب | القطع | النسبة |\n|---|---|---|\n| Weld porosity | 1,204 | 1.29% |\n| خدش | 39 | — |')
    expect(html).toMatch(/<table dir="rtl"/)
    const [defect, pieces, share, ...body] = cells(html)
    expect(defect.tag).toBe('th')
    // In a right-to-left table the words sit on the right and the figures on the left: each column as one.
    expect(defect.attrs).toContain('dir="auto"')
    expect(defect.attrs).toContain('text-right')
    expect(pieces.attrs).toContain('dir="ltr"')
    expect(pieces.attrs).toContain('text-left')
    expect(share.attrs).toContain('text-left')
    const [weld, count, rate, scratch, count2, blank] = body
    expect(weld.attrs).toContain('text-right')
    expect(count.text).toBe('1,204')
    expect(count.attrs).toMatch(/dir="ltr".*tabular-nums|tabular-nums.*dir="ltr"/)
    expect(rate.text).toBe('1.29%')
    expect(scratch.text).toBe('خدش')
    expect(count2.attrs).toContain('text-left')
    // A dash leaves its column a column of figures.
    expect(blank.attrs).toContain('dir="ltr"')
    // The marks the renderer reads never reach the page.
    expect(html).not.toContain('data-ai-')
  })

  it('lays an Arabic answer out right to left as a whole — its text, its lists and its quotes — each block reading its own way', () => {
    const html = render('## الخلاصة\n\nLM4 هو أسوأ خط هذا الشهر.\n\n1. مراجعة إعدادات سماكة الدهان على خط LM4.\n2. فحص إضافي للون عند تغيير الدفعة.\n\n- Scratch — 135\n\n> ملاحظة: الأرقام تشمل جميع الورديات حتى نهاية يوم أمس.')
    // Set, not left to dir="auto": every block in it says its own direction, which dir="auto" on the whole passes over.
    expect(html).toMatch(/^<div dir="rtl" class="ai-prose/)
    expect(html).toMatch(/<ol dir="rtl"/)
    expect(html).toMatch(/<blockquote dir="rtl"/)
    // A list of other words reads its own way; each paragraph and item still reads by its own first letter.
    expect(html).toMatch(/<ul dir="ltr"/)
    expect(html).toMatch(/<p dir="auto"[^>]*>LM4 هو/)
    expect(html).toMatch(/<li dir="auto"/)
    expect(render('Defects fell **12%** on LM4.')).toMatch(/^<div dir="ltr" class="ai-prose/)
  })

  it('scrolls a table in its own direction, a wide Arabic one from its first column on the right, under tools that read left to right', () => {
    const html = render('| الخط | القطع المنتجة | ملاحظات |\n|---|---:|---|\n| خط الدهان LM4 | 31,420 | ارتفاع في سماكة الدهان |')
    expect(html).toMatch(/<div dir="rtl" class="ai-table-scroll[^"]*"><table dir="rtl"/)
    expect(html).toMatch(/<div dir="ltr" class="[^"]*border-t[^"]*"><span[^>]*>1 row/)
  })

  it('puts a row count, Copy table and Export Excel under every table, and a Copy on every code block', () => {
    const html = render('| Machine | Pieces |\n|---|---|\n| RF-01 | 12 |\n| RF-02 | 7 |\n\n```sql\nSELECT 1\n```')
    expect(html).toMatch(/<table dir="ltr"/)
    expect(html).toContain('2 rows')
    expect(html).toContain('Copy table')
    expect(html).toContain('Export Excel')
    expect(html).toContain('aria-label="Copy the code"')
    // Copy sits in a strip over the code, naming its language — never over a line of it.
    expect(html).toMatch(/>sql<\/span><button type="button" aria-label="Copy the code"[^>]*>.*Copy<\/button><\/div><pre dir="ltr"/)
    expect(render('```\nplain\n```')).toMatch(/>Code<\/span><button/)
    const [machine, pieces] = cells(html)
    expect(machine.attrs).toContain('text-left')
    expect(pieces.attrs).toContain('text-right')
  })

  it('keeps the model’s alignment of a column of words, and puts figures at the end whatever it said', () => {
    const html = render('| Machine | Pieces |\n|:---:|:---|\n| RF-01 | 12 |')
    const [machine, pieces, rf, twelve] = cells(html)
    expect(machine.attrs).toMatch(/style="text-align:\s*center"/)
    expect(rf.attrs).toMatch(/style="text-align:\s*center"/)
    expect(pieces.attrs).not.toContain('style=')
    expect(twelve.attrs).not.toContain('style=')
    expect(twelve.attrs).toContain('text-right')
  })

  it('marks the text being written for its caret, and only then', () => {
    expect(render('Looking at September', true)).toContain('ai-caret')
    expect(render('Looking at September')).not.toContain('ai-caret')
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
