import { describe, expect, it } from 'vitest'
import { appLinkLabel, appLinkSegments } from './appLinks'

describe('the paths in an automated message', () => {
  it('turns each into a link named for what it opens', () => {
    expect(appLinkSegments('Line 3 rejects: 2 new cases\n• Sample 2009-1 failed — /follow-ups/f1\n• Coil 77 — /history?session=s9')).toEqual([
      { type: 'text', text: 'Line 3 rejects: 2 new cases\n• Sample 2009-1 failed — ' },
      { type: 'link', to: '/follow-ups/f1', label: 'Open the follow-up' },
      { type: 'text', text: '\n• Coil 77 — ' },
      { type: 'link', to: '/history?session=s9', label: 'Open the session' },
    ])
  })

  it('leaves the punctuation that ends a sentence outside the link', () => {
    expect(appLinkSegments('…and 4 more: /automations/a1.')).toEqual([
      { type: 'text', text: '…and 4 more: ' },
      { type: 'link', to: '/automations/a1', label: 'Open the automation' },
      { type: 'text', text: '.' },
    ])
    expect(appLinkSegments('(see /automations/deliveries/d1)')).toEqual([
      { type: 'text', text: '(see ' },
      { type: 'link', to: '/automations/deliveries/d1', label: 'Open the report' },
      { type: 'text', text: ')' },
    ])
  })

  it('finds a path at the very start of the text', () => {
    expect(appLinkSegments('/automations/deliveries/d1')).toEqual([{ type: 'link', to: '/automations/deliveries/d1', label: 'Open the report' }])
  })

  it('keeps as text what is not a path of the app, or not on its own', () => {
    expect(appLinkSegments('3/4 of the samples, see https://example.com/history and a/history/x')).toEqual([
      { type: 'text', text: '3/4 of the samples, see https://example.com/history and a/history/x' },
    ])
    expect(appLinkSegments('/etc/passwd and //evil.example/follow-ups')).toEqual([{ type: 'text', text: '/etc/passwd and //evil.example/follow-ups' }])
    expect(appLinkSegments('')).toEqual([])
  })

  it('never links a path that resolves outside the app', () => {
    expect(appLinkSegments('/history/..//evil.example')).toEqual([{ type: 'text', text: '/history/..//evil.example' }])
  })
})

describe('what a link is called', () => {
  it('names the page it opens', () => {
    expect(appLinkLabel('/follow-ups')).toBe('Open follow-ups')
    expect(appLinkLabel('/history?session=s1&sample=x1')).toBe('Open the sample')
    expect(appLinkLabel('/history?q=2009')).toBe('Open the order in History')
    expect(appLinkLabel('/history')).toBe('Open History')
    expect(appLinkLabel('/automations')).toBe('Open automations')
    expect(appLinkLabel('/dashboard')).toBe('/dashboard')
  })
})
