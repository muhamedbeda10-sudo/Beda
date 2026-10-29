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
vi.mock('@/pages/MtcPage', () => ({ MtcPage: () => <p data-register="mtc" /> }))
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
  it('holds Customer Complaints, NCR, then MTC, and the QA tab shows to whoever may open any of them', () => {
    expect(QA_PARTS.map((p) => p.label)).toEqual(['Customer Complaints', 'NCR', 'MTC'])
    expect(NAV.find((n) => n.to === '/qa')?.needsAny).toEqual(QA_PARTS.map((p) => p.needs))
  })

  it('opens the part named in the address, the others as tabs beside it', () => {
    const page = draw('/qa/ncr', ['view-ncr', 'view-customer-complaints'])
    expect(page).toContain('data-register="ncr"')
    expect(page).toContain('aria-label="QA parts"')
    expect(page).toMatch(/href="\/qa\/customer-complaints"[^>]*>.*Customer Complaints/)
    expect(page).toMatch(/aria-current="page"[^>]*href="\/qa\/ncr"|href="\/qa\/ncr"[^>]*aria-current="page"/)
  })

  it('keeps MTC, the material, a group apart from the complaints and NCRs, and opens it for whoever holds it alone', () => {
    const all = draw('/qa/mtc', ['view-ncr', 'view-customer-complaints', 'view-mtc'])
    expect(all).toContain('data-register="mtc"')
    expect(all).toMatch(/href="\/qa\/ncr".*<span aria-hidden="true" class="mx-1 h-6 w-px[^"]*"><\/span>.*href="\/qa\/mtc"/)
    expect(all).toContain('<optgroup label="Material">')
    // An inspector, say, holds MTC alone: QA is that one part, with no group to name.
    const mtcOnly = draw('/qa/mtc', ['view-mtc'])
    expect(mtcOnly).toContain('data-register="mtc"')
    expect(mtcOnly).not.toContain('NCR')
    expect(mtcOnly).not.toContain('Complaints and NCRs')
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
