import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import type { Permission } from '@qc/shared/permissions'
import { NAV } from '@/components/layout/navItems'
import { QA_PARTS, QaPage } from './QaPage'

// QA: the quality registers as parts of one tab, each shown to whoever may open it. The registers themselves are
// drawn elsewhere (QualityRegisterPage); here a stand-in names which one opened.

let held: Permission[] = []
vi.mock('@/store/AuthContext', () => ({ useAuth: () => ({ can: (p: Permission) => held.includes(p) }) }))
vi.mock('@/pages/QualityRegisterPage', () => ({ QualityRegisterPage: ({ kind }: { kind: string }) => <p data-register={kind} /> }))

const consoleError = console.error
beforeAll(() => {
  vi.spyOn(console, 'error').mockImplementation((message?: unknown, ...rest: unknown[]) => {
    if (String(message).includes('useLayoutEffect does nothing on the server')) return
    consoleError(message, ...rest)
  })
})
afterAll(() => vi.restoreAllMocks())

const draw = (path: string, permissions: Permission[]) => {
  held = permissions
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/qa/:section?" element={<QaPage />} />
      </Routes>
    </MemoryRouter>,
  )
}

describe('QA', () => {
  it('holds Customer Complaints, then NCR, and the QA tab shows to whoever may open any of them', () => {
    expect(QA_PARTS.map((p) => p.label)).toEqual(['Customer Complaints', 'NCR'])
    expect(NAV.find((n) => n.to === '/qa')?.needsAny).toEqual(QA_PARTS.map((p) => p.needs))
  })

  it('opens the part named in the address, the others as tabs beside it', () => {
    const page = draw('/qa/ncr', ['view-ncr', 'view-customer-complaints'])
    expect(page).toContain('data-register="ncr"')
    expect(page).toContain('aria-label="QA parts"')
    expect(page).toMatch(/href="\/qa\/customer-complaints"[^>]*>.*Customer Complaints/)
    expect(page).toMatch(/aria-current="page"[^>]*href="\/qa\/ncr"|href="\/qa\/ncr"[^>]*aria-current="page"/)
  })

  it('shows a person only the parts they may open, and opens no part they may not', () => {
    const page = draw('/qa/ncr', ['view-ncr'])
    expect(page).toContain('data-register="ncr"')
    expect(page).not.toContain('Customer Complaints')
    // A part they may not open, an unknown one or the bare address sends them on rather than drawing a register.
    expect(draw('/qa/customer-complaints', ['view-ncr'])).not.toContain('data-register')
    expect(draw('/qa/nothing', ['view-ncr'])).not.toContain('data-register')
    expect(draw('/qa', ['view-ncr', 'view-customer-complaints'])).not.toContain('data-register')
  })
})
