import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import type { AiDiagramPart } from '@qc/shared/aiDiagram'
import { AppProvider } from '@/store/AppContext'
import { AiDiagramCard, diagramSubtitle } from './AiDiagramCard'
import { diagramFileName } from './diagram/exportDiagram'

vi.mock('@/store/AuthContext', async (original) => ({
  ...(await original<typeof import('@/store/AuthContext')>()),
  useAuth: () => ({ role: 'supervisor', profile: null, factoryTimeZone: 'Africa/Cairo' }),
}))

beforeAll(() => {
  const stored = new Map<string, string>([['qc-system-theme', 'light']])
  vi.stubGlobal('localStorage', { getItem: (k: string) => stored.get(k) ?? null, setItem: (k: string, v: string) => void stored.set(k, v), removeItem: (k: string) => void stored.delete(k) })
})
afterAll(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const html = (part: AiDiagramPart) =>
  renderToStaticMarkup(
    <MemoryRouter>
      <AppProvider>
        <AiDiagramCard part={part} />
      </AppProvider>
    </MemoryRouter>,
  )
const text = (part: AiDiagramPart) =>
  html(part)
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, ' ')
    .trim()

const fishbone: AiDiagramPart = {
  type: 'diagram',
  diagramId: 'd1',
  spec: {
    layout: 'fishbone',
    title: 'Twist on Forming 2, October',
    direction: 'across',
    rtl: false,
    groups: [
      { id: 'machine', label: 'Machine' },
      { id: 'material', label: 'Material' },
    ],
    nodes: [
      { id: 'effect', label: 'Twist in the profile', shape: 'step', tone: 'bad' },
      { id: 'm58', label: 'Machine 58', shape: 'step', tone: 'bad', group: 'machine', figure: { text: '116 pcs', value: 116, source: 'pieces' }, link: '/history?machine=58' },
      { id: 'coil', label: 'Coil thickness varies', shape: 'step', tone: 'neutral', group: 'material', hypothesis: true },
    ],
    edges: [],
    sources: [{ id: 'pieces', purpose: 'Defect pieces by machine', sql: 'SELECT machine_code AS code, count(*) AS pieces FROM ai.defects GROUP BY 1', rows: 2, ms: 1200 }],
  },
}

describe('the diagram card', () => {
  it('shows its title and kind, the diagram with its figures, the hypotheses, the queries behind it and its tools', () => {
    const t = text(fishbone)
    expect(t).toContain('Twist on Forming 2, October Cause and effect (fishbone) · 3 boxes')
    expect(t).toContain('Machine 58')
    expect(t).toContain('116 pcs')
    expect(t).toContain('Dashed: a hypothesis to check — the data does not show it.')
    expect(t).toContain('Figures from 1 query')
    expect(t).toContain('Defect pieces by machine 2 rows · 1.2 s')
    expect(t).toContain('Full screen Download image')
    expect(t).not.toContain('SVG')
    // The drawing names itself, and a box with a link opens its page.
    expect(html(fishbone)).toContain('aria-label="Twist on Forming 2, October"')
    expect(html(fishbone)).toContain('href="/history?machine=58"')
  })

  it('says nothing of hypotheses or queries where there are none', () => {
    const plain: AiDiagramPart = { ...fishbone, spec: { ...fishbone.spec, nodes: fishbone.spec.nodes.map(({ hypothesis: _h, figure: _f, ...n }) => n), sources: [] } }
    const t = text(plain)
    expect(t).not.toContain('Dashed')
    expect(t).not.toContain('Figures from')
  })

  it('names its kind and its files', () => {
    expect(diagramSubtitle({ ...fishbone.spec, layout: 'swimlane', nodes: fishbone.spec.nodes.slice(0, 1) })).toBe('Swimlane process map · 1 box')
    expect(diagramFileName('Scrap: by line / machine?', new Date(2026, 9, 14, 9, 5), 'png')).toBe('Scrap by line machine 2026-10-14 0905.png')
    expect(diagramFileName('   ', new Date(2026, 9, 14, 9, 5), 'svg')).toBe('Diagram 2026-10-14 0905.svg')
  })
})
