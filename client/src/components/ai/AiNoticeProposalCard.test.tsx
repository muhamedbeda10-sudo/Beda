import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { AiNoticeDraft, AiNoticePart } from '@qc/shared/noticeAssistant'
import { AppProvider } from '@/store/AppContext'
import { AiAssistantProvider } from './AiAssistantProvider'
import { PROPOSAL_WAIT } from '@/components/automations/AutomationProposalCard'
import { AiNoticeProposalCard } from './AiNoticeProposalCard'
import { dayText } from './noticeProposal'

// The signed-in person's role: the Notices page (and so the card's link to it) is an administrator's.
const auth = vi.hoisted(() => ({ role: 'admin' }))
vi.mock('@/store/AuthContext', async (original) => ({
  ...(await original<typeof import('@/store/AuthContext')>()),
  useAuth: () => ({ role: auth.role, profile: null, factoryTimeZone: 'Africa/Cairo' }),
}))

// The card drawn to a string, as on a server: what each state says and offers. The router's and the provider's
// layout effects say they do nothing there, which is all the test needs.
const consoleError = console.error
beforeAll(() => {
  vi.spyOn(console, 'error').mockImplementation((message?: unknown, ...rest: unknown[]) => {
    if (String(message).includes('useLayoutEffect does nothing on the server')) return
    consoleError(message, ...rest)
  })
  const stored = new Map<string, string>([['qc-system-theme', 'light']])
  vi.stubGlobal('localStorage', { getItem: (k: string) => stored.get(k) ?? null, setItem: (k: string, v: string) => void stored.set(k, v), removeItem: (k: string) => void stored.delete(k) })
})
afterAll(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})
beforeEach(() => {
  auth.role = 'admin'
})

function html(part: AiNoticePart, writing = false): string {
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <AppProvider>
        <MemoryRouter>
          <AiAssistantProvider>
            <AiNoticeProposalCard part={part} writing={writing} />
          </AiAssistantProvider>
        </MemoryRouter>
      </AppProvider>
    </QueryClientProvider>,
  )
}

/** The card as text. */
const text = (part: AiNoticePart, writing = false) =>
  html(part, writing)
    .replace(/<[^>]+>/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim()

const draft: AiNoticeDraft = {
  title: 'Check the coating thickness',
  body: 'Measure every coil at the start of the shift.',
  severity: 'warning',
  requiresAck: true,
  matchMode: 'all',
  validFrom: '2026-10-10',
  validTo: null,
  targets: [{ kind: 'machine', value: 'RF-03', label: 'RF-03' }],
}

const create: AiNoticePart = { type: 'notice', proposalId: 'n1', ok: true, action: 'create', state: 'proposed', draft, reach: { everyone: false, people: null, placeBound: true } }
const update: AiNoticePart = {
  type: 'notice',
  proposalId: 'n2',
  ok: true,
  action: 'update',
  noticeId: 'nt1',
  state: 'proposed',
  before: { ...draft, title: 'Coating', attachments: 2 },
  draft: { ...draft, attachments: 2 },
  reach: { everyone: false, people: null, placeBound: true },
}
const withdraw: AiNoticePart = { type: 'notice', proposalId: 'n3', ok: true, action: 'withdraw', noticeId: 'nt1', state: 'proposed', before: { ...draft, targets: [] }, reach: { everyone: true, people: 42, placeBound: false } }
const remove: AiNoticePart = { ...withdraw, proposalId: 'n4', action: 'delete' }

describe('the notice card', () => {
  it('shows a new notice as readers will see it, with its days, audience and reach, and offers Publish and Discard', () => {
    const t = text(create)
    expect(t).toContain('New notice Not published yet Check the coating thickness')
    expect(t).toContain('As readers will see it Warning Acknowledgement required Check the coating thickness')
    expect(t).toContain('Measure every coil at the start of the shift.')
    expect(t).toContain(`Shown From ${dayText('2026-10-10')} until withdrawn`)
    expect(t).toContain('Aimed at Machine RF-03')
    expect(t).toContain('Reaches Shown at the machine to whoever works there')
    expect(t).toContain('Publish Discard Nothing goes out until you press Publish. Photos and files are added on the Notices page.')
    expect(t).not.toContain('What changes')
    expect(t).not.toContain('Open in Notices')
  })

  it('waits for the answer to finish before anything can be decided', () => {
    expect(html(create, true).match(new RegExp(`disabled="" data-tip="${PROPOSAL_WAIT}"`, 'g'))).toHaveLength(2)
    expect(html(create)).not.toContain(PROPOSAL_WAIT)
  })

  it('shows a change as the notice will be, what it changes before → after, and that its photos and files stay', () => {
    const t = text(update)
    expect(t).toContain('Change to a notice Not applied yet Check the coating thickness')
    expect(t).toContain('Changes the notice “Coating” when you apply it.')
    expect(t).toContain('What changes Title Coating changes to Check the coating thickness Everything else stays as it is.')
    expect(t).toContain('Photos and files stay (2); add more on the Notices page.')
    expect(t).toContain('Apply changes Discard Nothing changes until you press Apply changes.')
  })

  it('shows a withdrawal or a deletion on the notice as it is, under a word on what the button does', () => {
    const w = text(withdraw)
    expect(w).toContain('Withdraw notice Not withdrawn yet')
    expect(w).toContain('Withdrawing stops it showing at once, in the bell and before inspections. The record and every acknowledgement stay.')
    expect(w).toContain('The notice as it is')
    expect(w).toContain('Aimed at Everyone, everywhere')
    expect(w).toContain('Reaches now Everyone (42 people)')
    expect(w).toContain('Withdraw Discard It keeps showing until you press Withdraw.')
    const d = text(remove)
    expect(d).toContain('Delete notice Not deleted yet')
    expect(d).toContain('Deleting takes it out of every bell and list, the Notices page included. The record stays for the audit.')
    expect(d).toContain('Delete Discard Nothing is deleted until you press Delete and confirm.')
    // The second confirmation opens only when Delete is pressed.
    expect(d).not.toContain('Delete this notice?')
    expect(html(remove)).toContain('class="btn-danger')
  })

  it('once published, says so and opens the Notices page for an administrator, keeping what was proposed folded', () => {
    const applied: AiNoticePart = { ...create, state: 'applied', noticeId: 'nt9', appliedAt: '2026-10-10T05:01:00Z', appliedByName: 'Mona Adel' }
    const h = html(applied)
    expect(h).toContain('href="/admin/notices"')
    expect(h).toMatch(/aria-expanded="false"[^>]*>.*Show what was proposed/)
    const t = text(applied)
    expect(t).toContain('New notice Published')
    expect(t).toContain('It is out. The Notices page shows it as it is now, with who has read it.')
    expect(t).toMatch(/Published .* by Mona Adel · Open in Notices/)
    expect(t).not.toContain('As readers will see it')
    expect(t).not.toContain('Nothing goes out until you press Publish.')
    // No longer an administrator: no link to a page that is not theirs.
    auth.role = 'supervisor'
    expect(html(applied)).not.toContain('href="/admin/notices"')
  })

  it('once discarded, replaced or out of date, says so and offers nothing to press', () => {
    const discarded = text({ ...create, state: 'discarded' })
    expect(discarded).toContain('Discarded — nothing changed. Ask the assistant again any time.')
    expect(discarded).not.toContain('Publish Discard')
    const replaced = text({ ...create, state: 'superseded' })
    expect(replaced).toContain('New notice Replaced')
    expect(replaced).toContain('Nothing of it changes: the newer card below is the one to decide.')
    expect(replaced).toContain('Replaced by a newer version below')
    expect(replaced).not.toContain('As readers will see it')
    const stale = text({ ...update, state: 'stale' })
    expect(stale).toContain('Change to a notice Out of date')
    expect(stale).toContain('The notice changed since; ask the assistant again.')
    expect(stale).not.toContain('Apply changes Discard')
  })

  it('shows a draft the server did not accept compactly, opening on why', () => {
    const t = text({ type: 'notice', proposalId: 'n5', ok: false, error: 'targets[0]: no machine RF-99', action: 'create', state: 'proposed', draft })
    expect(t).toContain('Notice draft not accepted : Check the coating thickness')
    expect(t).toContain('The assistant was told what to fix; nothing changed.')
    expect(text({ type: 'notice', proposalId: 'n6', ok: false, error: 'No such notice', action: 'withdraw', state: 'proposed' })).toContain('Withdrawal not accepted')
  })

  it('reads an Arabic notice right to left, whatever the page’s direction', () => {
    const h = html({ ...create, draft: { ...draft, title: 'افحص سماكة الطلاء', body: 'قس كل لفة في بداية الوردية.' } })
    expect(h).toContain('dir="rtl"')
    expect(h.match(/dir="rtl"/g)?.length).toBeGreaterThanOrEqual(3)
  })
})
