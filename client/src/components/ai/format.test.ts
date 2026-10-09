import { describe, expect, it } from 'vitest'
import { formatCap, formatMonth, formatUsd, spendShare, spendTone, utcMonth } from './format'
import { aiUrlTransform, classifyAiLink } from './links'

describe('AI assistant figures', () => {
  it('writes money to the cent, and an answer’s fraction of a cent to four places', () => {
    expect(formatUsd(3.2)).toBe('$3.20')
    expect(formatUsd(1234.5)).toBe('$1,234.50')
    expect(formatUsd(0)).toBe('$0.00')
    expect(formatUsd(0.0042)).toBe('$0.0042')
    expect(formatCap(50)).toBe('$50')
    expect(formatCap(50.5)).toBe('$50.50')
  })

  it('colours the spend by its share of the cap', () => {
    expect(spendTone(10, 50)).toBe('neutral')
    expect(spendTone(35, 50)).toBe('amber')
    expect(spendTone(45, 50)).toBe('red')
    expect(spendTone(60, 50)).toBe('red')
    // A cap of zero lets nothing through.
    expect(spendShare(0, 0)).toBe(1)
  })

  it('counts months in UTC, across the turn of a year', () => {
    const now = new Date('2026-01-15T12:00:00Z')
    expect(utcMonth(0, now)).toBe('2026-01')
    expect(utcMonth(-1, now)).toBe('2025-12')
    // Anthropic's month turns at midnight UTC, whatever the device's zone.
    expect(utcMonth(0, new Date('2026-10-31T23:30:00Z'))).toBe('2026-10')
    expect(utcMonth(0, new Date('2026-11-01T00:30:00Z'))).toBe('2026-11')
    expect(formatMonth('2026-10')).toBe('October 2026')
  })
})

describe('links in an answer', () => {
  it('opens a page of the application in place', () => {
    expect(classifyAiLink('/history?session=3f2a')).toEqual({ kind: 'app', to: '/history?session=3f2a' })
    expect(classifyAiLink('/dashboard#holds')).toEqual({ kind: 'app', to: '/dashboard#holds' })
    // A path is resolved, so it can only ever name a page of this origin.
    expect(classifyAiLink('/a/../history')).toEqual({ kind: 'app', to: '/history' })
  })

  it('opens a web address in a new tab', () => {
    expect(classifyAiLink('https://www.anthropic.com/pricing')).toEqual({ kind: 'external', href: 'https://www.anthropic.com/pricing' })
    expect(classifyAiLink('http://example.com')).toEqual({ kind: 'external', href: 'http://example.com/' })
  })

  it('drops every other kind of address', () => {
    for (const href of [
      'javascript:alert(1)',
      ' JavaScript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'vbscript:msgbox',
      'mailto:someone@example.com',
      'file:///etc/passwd',
      '//evil.example/path',
      '/\\evil.example',
      'https://linkmisr.com@evil.example/',
      'session:abc',
      '#user-content-fn-1',
      'relative/path',
      '',
      null,
      undefined,
    ])
      expect(classifyAiLink(href)).toBeNull()
    expect(aiUrlTransform('javascript:alert(1)')).toBe('')
    expect(aiUrlTransform('/history')).toBe('/history')
  })
})
