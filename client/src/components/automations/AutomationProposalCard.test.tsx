import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { AiAutomationPart, AutomationDraft } from '@qc/shared/automation'
import { AppProvider } from '@/store/AppContext'
import { AuthProvider } from '@/store/AuthContext'
import { AiAssistantProvider } from '@/components/ai/AiAssistantProvider'
import { AutomationProposalCard, PROPOSAL_WAIT } from './AutomationProposalCard'
import { factoryMoment } from './wording'

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

function html(part: AiAutomationPart, writing = false): string {
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <AppProvider>
        <AuthProvider>
          <MemoryRouter>
            <AiAssistantProvider>
              <AutomationProposalCard part={part} writing={writing} />
            </AiAssistantProvider>
          </MemoryRouter>
        </AuthProvider>
      </AppProvider>
    </QueryClientProvider>,
  )
}

/** The card as text. */
const text = (part: AiAutomationPart, writing = false) =>
  html(part, writing)
    .replace(/<[^>]+>/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim()

const draft: AutomationDraft = {
  kind: 'watch',
  name: 'Holds on line 3',
  description: 'Every new hold on line 3, to the supervisors.',
  language: 'en',
  watch: { sql: 'SELECT 1', keyColumn: 'sample_id', everyMinutes: 5, titleTemplate: 'Hold on {{machine}}', sessionColumn: 'session_id' },
  recipients: [{ kind: 'role', role: 'supervisor' }],
  channels: { bell: true, chat: true },
  actions: { notify: true, followUp: { assignee: { kind: 'column', column: 'inspector_id' }, dueHours: 24 } },
}

const proposed: AiAutomationPart = {
  type: 'automation',
  proposalId: 'p1',
  ok: true,
  state: 'proposed',
  draft,
  recipients: [{ kind: 'role', role: 'supervisor', label: 'Every supervisor' }],
  assignee: { kind: 'column', column: 'inspector_id', label: 'The person in "inspector_id"' },
  backtest: {
    ranAt: '2026-10-10T05:00:00Z',
    ok: true,
    matched: 3,
    columns: ['sample_id', 'machine', 'inspector_id', 'session_id'],
    sampleRows: [['s1', 'RF-03', 'u1', 'x1']],
    sampleTitle: 'Hold on RF-03',
    sampleBody: 'Sample s1',
  },
}

describe('the proposal card', () => {
  it('says in plain words what would run, what a trial found, and offers Activate, Edit and Discard', () => {
    const t = text(proposed)
    expect(t).toContain('Watch Not active yet Holds on line 3')
    expect(t).toContain('Every 5 minutes it looks for new cases. Each new case is told to every supervisor on the bell and the chat, and gets a follow-up for the person in "inspector_id", due 1 day after the case.')
    expect(t).toContain('Opens a follow-up for the person in "inspector_id", due 1 day after the case')
    expect(t).toContain('Marks the session "Needs review" until the follow-up is closed')
    // When the trial ran, on the factory's clock (the AuthProvider's default zone): the card is read again days later.
    expect(t).toContain(`Tried ${factoryMoment(proposed.backtest!.ranAt, 'Africa/Cairo')} 3 cases matched.`)
    expect(html(proposed)).toContain('<time dateTime="2026-10-10T05:00:00Z"')
    expect(t).toContain('What a notification will say (the first case) Hold on RF-03 Sample s1')
    expect(t).toContain('Also alert on the 3 cases that match now')
    expect(t).toContain('The 3 cases matching now are recorded as already seen; only cases that appear later will fire.')
    expect(t).toContain('Activate Edit Discard Nothing runs until you press Activate.')
    expect(t).not.toContain('Open in Automations')
  })

  it('waits for the answer to finish before anything can be decided', () => {
    const h = html(proposed, true)
    expect(h.match(new RegExp(`disabled="" data-tip="${PROPOSAL_WAIT}"`, 'g'))).toHaveLength(3)
    expect(html(proposed)).not.toContain(PROPOSAL_WAIT)
  })

  it('once activated, says so and opens the automation, keeping what was proposed folded (its page may have changed it)', () => {
    const h = html({ ...proposed, state: 'activated', automationId: 'a1' })
    expect(h).toContain('href="/automations/a1"')
    expect(h).toMatch(/aria-expanded="false"[^>]*>.*Show what was proposed/)
    const t = text({ ...proposed, state: 'activated', automationId: 'a1' })
    expect(t).toContain('Active · Open in Automations')
    expect(t).toContain('It runs on its own now. Its page shows it as it is, with every change and run since.')
    expect(t).not.toContain('Every 5 minutes it looks for new cases.')
    expect(t).not.toContain('Tried ')
    expect(t).not.toContain('Nothing runs until you press Activate.')
    expect(t).not.toContain('Also alert on')
  })

  it('once discarded, says nothing runs', () => {
    const t = text({ ...proposed, state: 'discarded' })
    expect(t).toContain('Discarded — nothing runs.')
    expect(t).not.toContain('Activate Edit')
  })

  it('names the automation a change would replace', () => {
    expect(text({ ...proposed, replacesName: 'Old holds' })).toContain('Changes “Old holds” when activated; the cases it has already fired stay fired.')
  })

  describe('a change of a watch', () => {
    const change = (backtest: Partial<NonNullable<AiAutomationPart['backtest']>>): AiAutomationPart => ({
      ...proposed,
      draft: { ...draft, replacesAutomationId: 'a1' },
      replacesName: 'Old holds',
      backtest: { ...proposed.backtest!, ...backtest },
    })

    it('keeping its query and key column, says its cases carry on, with nothing to choose', () => {
      const t = text(change({ matched: 3, newCases: 1, keepsCases: true }))
      expect(t).toContain('3 cases matched.')
      expect(t).toContain('Its query and key column stay the same, so its cases carry on: of the 3 cases matching now, 1 not seen yet will fire on its next run; the others were already seen and will not fire again.')
      expect(t).not.toContain('Also alert on')
      expect(t).not.toContain('recorded as already seen')
    })

    it('with another query, offers to alert on the cases matching now that its automation has not seen yet', () => {
      const t = text(change({ matched: 3, newCases: 2, keepsCases: false }))
      expect(t).toContain('Also alert on the 2 cases matching now that it has not seen yet')
      expect(t).toContain('Of the 3 cases matching now, 2 not seen yet are recorded as seen, like the others; only cases that appear later will fire.')
    })

    it('with every case matching now seen already, offers nothing to alert on', () => {
      const t = text(change({ matched: 3, newCases: 0, keepsCases: false }))
      expect(t).toContain('It has already seen the 3 cases matching now: they will not fire again, and only cases that appear later will fire.')
      expect(t).not.toContain('Also alert on')
    })

    it('whose automation was deleted since, says it cannot be activated', () => {
      const gone = { ...change({ newCases: 3, keepsCases: false }), replacesName: undefined }
      expect(text(gone)).toContain('The automation this was to change is no longer there, so it cannot be activated. Ask the assistant to propose it again.')
      expect(html(gone)).toContain('disabled="" data-tip="The automation it changes is no longer there"')
      expect(text(proposed)).not.toContain('no longer there')
    })
  })

  it('shows a draft the server did not accept compactly, like a failed query', () => {
    const t = text({ type: 'automation', proposalId: 'p2', ok: false, error: 'watch.keyColumn: "id" is not a column of the result.', state: 'proposed', draft })
    expect(t).toContain('Automation draft not accepted : Holds on line 3')
    expect(t).toContain('The assistant was told what to fix; nothing was set up.')
    expect(t).not.toContain('Activate')
  })

  it('shows a report’s schedule and its sections as they ran over its period', () => {
    const report: AiAutomationPart = {
      type: 'automation',
      proposalId: 'p3',
      ok: true,
      state: 'proposed',
      draft: {
        kind: 'report',
        name: 'Daily rejects',
        description: 'Yesterday’s rejects.',
        language: 'en',
        schedule: { cadence: 'weekly', time: '07:30', weekday: 0, period: { kind: 'last_week', weekStart: 'saturday' }, sections: [{ title: 'Rejects', sql: 'SELECT 1' }], summary: true },
        recipients: [{ kind: 'role', role: 'admin' }],
        channels: { bell: true, chat: false },
        actions: { notify: true, followUp: null },
      },
      recipients: [{ kind: 'role', role: 'admin', label: 'Every administrator' }],
      backtest: {
        ranAt: '2026-10-10T05:00:00Z',
        ok: true,
        period: { from: '2026-10-03', to: '2026-10-09', label: 'Last week' },
        sections: [{ title: 'Rejects', ok: true, columns: ['machine', 'n'], rows: [['RF-01', 4]], rowCount: 1, truncated: false, ms: 9 }],
      },
    }
    const t = text(report)
    expect(t).toContain('Scheduled report Not active yet Daily rejects')
    expect(t).toContain('Every Sunday at 07:30 (factory time) it runs 1 section over last week, adds a short summary written by the assistant, and sends the result to every administrator on the bell.')
    expect(t).toContain('Its sections over last week (3 Oct – 9 Oct 2026):')
    expect(t).toContain('Rejects 1 row')
    // A report has no cases matching now to alert on.
    expect(t).not.toContain('Also alert on')
  })
})
