import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { AiDomain, AiMeResponse } from '@qc/shared/ai'
import { keys } from '@/services/queries'
import { AppProvider } from '@/store/AppContext'
import { AiAssistantProvider } from './AiAssistantProvider'
import { AiCapabilityGrid } from './AiCapabilities'
import { AiComposer } from './AiComposer'
import { DEPTH_KEY } from './depth'

// A theme stored, so the app's provider does not ask the window (there is none here) for the system's.
const THEME = ['qc-system-theme', 'light'] as const
const stored = new Map<string, string>([THEME])
beforeAll(() => {
  vi.stubGlobal('localStorage', { getItem: (k: string) => stored.get(k) ?? null, setItem: (k: string, v: string) => void stored.set(k, v), removeItem: (k: string) => void stored.delete(k) })
})
afterAll(() => vi.unstubAllGlobals())

function render(node: React.ReactNode, domains: AiDomain[], over: Partial<AiMeResponse> = {}): string {
  const client = new QueryClient()
  client.setQueryData<AiMeResponse>(keys.aiMe, { granted: true, owner: false, available: true, automations: false, excel: false, notices: false, mtc: false, domains, ...over })
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <AppProvider>
        <MemoryRouter>
          <AiAssistantProvider>{node}</AiAssistantProvider>
        </MemoryRouter>
      </AppProvider>
    </QueryClientProvider>,
  )
}

const composer = <AiComposer value="" onChange={() => {}} focus={{ key: 0, always: false }} onFocusUsed={() => {}} />

describe('§20 what it can do, in an empty conversation', () => {
  it('shows the cards this person can use, and not the others', () => {
    const html = render(<AiCapabilityGrid onPick={() => {}} wide />, ['inspection', 'production'])
    expect(html).toContain('What it can do')
    for (const title of ['Build a report', 'Draw a chart', 'Morning briefing', 'Why did it change?', 'Read a paper sheet', 'Send a task']) expect(html).toContain(title)
    for (const title of ['What if…', 'Plan to a deadline', 'Excel file', 'New automation']) expect(html).not.toContain(title)
    // The paper sheet takes a photo, from the camera on a phone, as the box's scanner does.
    expect(html).toMatch(/accept="image\/\*" capture="environment"/)
  })

  it('adds planning, Excel and automations for someone given them', () => {
    const html = render(<AiCapabilityGrid onPick={() => {}} />, ['planning'], { excel: true, automations: true })
    for (const title of ['What if…', 'Plan to a deadline', 'Excel file', 'New automation']) expect(html).toContain(title)
  })
})

describe('§20 the question box', () => {
  it('offers Quick, Standard and Deep, Standard picked at first, in a turning frame', () => {
    stored.delete(DEPTH_KEY)
    const html = render(composer, ['inspection'])
    expect(html).toContain('role="radiogroup" aria-label="How deep to answer"')
    expect(html.match(/role="radio"/g)).toHaveLength(3)
    expect(html).toMatch(/aria-checked="true"[^>]*>.*?Standard/)
    expect(html).toContain('class="ai-frame"')
    expect(html).toContain('data-busy="false"')
  })

  it('keeps the Quick or Standard picked last on this device', () => {
    stored.set(DEPTH_KEY, 'quick')
    expect(render(composer, ['inspection'])).toMatch(/aria-checked="true"[^>]*>.*?Quick/)
    stored.delete(DEPTH_KEY)
  })

  it('has the sparkles, the paperclip and the scanner, the scanner opening the camera on a phone', () => {
    const html = render(composer, ['inspection'])
    for (const label of ['What it can do', 'Attach a photo, PDF or spreadsheet', 'Scan a paper sheet']) expect(html).toContain(`aria-label="${label}"`)
    expect(html).toContain('capture="environment"')
    expect(html).toContain('aria-label="Send"')
  })

  it('locks the depth and the tools when the assistant cannot answer', () => {
    const html = render(composer, ['inspection'], { available: false, reason: 'cap-reached' })
    expect(html).toMatch(/role="radio"[^>]*disabled=""/)
    expect(html).toMatch(/disabled=""[^>]*aria-label="Scan a paper sheet"|aria-label="Scan a paper sheet"[^>]*disabled=""/)
  })
})
