import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { AiAccess } from '@qc/shared/ai'
import { AccessTable } from './AiAccessSection'
import { sortAccess } from './access'

const row = (over: Partial<AiAccess>): AiAccess => ({
  userId: 'u1',
  name: 'Mona Adel',
  username: 'mona',
  role: 'inspector',
  active: true,
  enabled: true,
  domains: ['inspection'],
  model: 'claude-sonnet-5-5',
  effort: 'medium',
  monthlyCapUsd: 10,
  spentUsd: 1.25,
  owner: false,
  automations: false,
  notices: false,
  excel: false,
  ...over,
})

/** The table as text, cell by cell. */
const text = (people: AiAccess[]) =>
  renderToStaticMarkup(<AccessTable people={sortAccess(people)} onEdit={() => {}} onRemove={() => {}} />)
    .replace(/<(td|th)[^>]*>/g, ' | ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim()

describe('who can use it, as the owner reads it', () => {
  it('shows each person’s role, switch, data, model, effort and month against their cap', () => {
    const t = text([
      row({ userId: 'b', name: 'Basem Fathy', username: 'basem', role: 'supervisor', domains: ['audit', 'orders'], model: 'claude-haiku-5-5', effort: 'low', monthlyCapUsd: 5, spentUsd: 0.004 }),
      row({ userId: 'o', name: 'Mohamed Beda', username: 'beda', role: 'admin', owner: true, domains: ['inspection', 'orders', 'materials', 'audit'], monthlyCapUsd: 50, spentUsd: 12.5 }),
    ])
    // The owner's own row first, marked as theirs.
    expect(t).toMatch(/Mohamed Beda You beda \| admin \| On \| Can create \| Can manage \| Can have made \| Inspections Orders & PDI Coils & master data Audit & accounts \| Claude Sonnet 5.5 \| Medium \| \$12.50 of \$50 \|/)
    // Domains in the app's order, whatever order they were stored in.
    expect(t).toMatch(/Basem Fathy basem \| supervisor \| On \| No \| No \| No \| Orders & PDI Audit & accounts \| Claude Haiku 5.5 \| Low \| \$0.0040 of \$5 \|/)
  })

  it('says when a person cannot ask whatever is set: switched off, no data, or an account that cannot sign in', () => {
    const t = text([row({ enabled: false, domains: [], active: false })])
    expect(t).toMatch(/Mona Adel Account off mona \| inspector \| Off \| No \| No \| No \| None: cannot ask \|/)
  })

  it('says why someone whose cap is under one call to their model can never ask', () => {
    const t = text([row({ model: 'claude-fable-5-1', monthlyCapUsd: 1, spentUsd: 0 }), row({ userId: 'b', name: 'Basem', model: 'claude-fable-5-1', monthlyCapUsd: 2.4 })])
    expect(t).toMatch(/Mona Adel mona .* \| \$0\.00 of \$1 Under the \$2\.40 one call may cost: cannot ask \|/)
    expect(t).toMatch(/Basem mona .* \| \$1\.25 of \$2\.40 \|/)
    expect(t.match(/cannot ask/g)).toHaveLength(1)
  })

  it('names the model’s price in the tooltip, and offers a change and a removal per person', () => {
    const html = renderToStaticMarkup(<AccessTable people={[row({ model: 'claude-opus-5-5' })]} onEdit={() => {}} onRemove={() => {}} />)
    expect(html).toContain('data-tip="$4 in · $20 out per million tokens"')
    expect(html).toContain('aria-label="Change Mona Adel&#x27;s access"')
    expect(html).toContain('aria-label="Take the assistant from Mona Adel"')
    // The scroller is positioned: its screen-reader-only header stays inside it, never widening a phone's page.
    expect(html).toMatch(/<div class="relative overflow-x-auto/)
  })

  it('says who may create automations: those allowed, and the owner always', () => {
    const t = text([row({ automations: true }), row({ userId: 'b', name: 'Basem', username: 'basem' })])
    expect(t).toMatch(/Mona Adel mona \| inspector \| On \| Can create \|/)
    expect(t).toMatch(/Basem basem \| inspector \| On \| No \|/)
  })

  it('says who may manage notices: administrators allowed, and the owner while one; allowed but not an administrator is not in effect', () => {
    const t = text([
      row({ userId: 'a', name: 'Amal', username: 'amal', role: 'admin', notices: true }),
      row({ userId: 'b', name: 'Basem', username: 'basem', role: 'supervisor', notices: true }),
      row({ userId: 'c', name: 'Camilia', username: 'camilia', role: 'admin' }),
      row({ userId: 'o', name: 'Owner', username: 'owner', role: 'supervisor', owner: true }),
    ])
    expect(t).toMatch(/Amal amal \| admin \| On \| No \| Can manage \|/)
    expect(t).toMatch(/Basem basem \| supervisor \| On \| No \| Allowed, not in effect \|/)
    expect(t).toMatch(/Camilia camilia \| admin \| On \| No \| No \|/)
    // The owner who is not an administrator cannot either, whatever is stored.
    expect(t).toMatch(/Owner You owner \| supervisor \| On \| Can create \| No \|/)
  })
})
