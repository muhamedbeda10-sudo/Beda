import { describe, expect, it } from 'vitest'
import { popupShape } from './AiPanelHost'

// §20 — the assistant's popup: the card in the corner or the large window, as chosen, for its conversation and
// saved reports; its own pages (Automations, the Playbook) always in the large window, which they need; a phone's
// popup is its whole screen.
describe('the assistant popup’s shape', () => {
  it('keeps the size chosen for the conversation and its saved reports', () => {
    expect(popupShape('/ai', 'compact', false)).toBe('compact')
    expect(popupShape('/ai/reports/r1', 'compact', false)).toBe('compact')
    expect(popupShape('/ai', 'large', false)).toBe('large')
  })

  it('opens the assistant’s pages in the large window', () => {
    for (const path of ['/automations', '/automations/a1', '/automations/deliveries/d1', '/playbook']) {
      expect(popupShape(path, 'compact', false)).toBe('large')
    }
  })

  it('fills a phone’s screen, whatever the size', () => {
    expect(popupShape('/ai', 'large', true)).toBe('phone')
    expect(popupShape('/automations', 'compact', true)).toBe('phone')
  })
})
