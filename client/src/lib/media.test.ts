import { afterEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { COARSE, FINE, PHONE, isCoarsePointer, matchesMedia, useCoarsePointer, useMediaQuery } from './media'

/** A window whose screen answers the queries in `matching`, the way a phone or a desktop browser would. */
const stubScreen = (...matching: string[]) => {
  const asked: string[] = []
  vi.stubGlobal('window', {
    matchMedia: (query: string) => {
      asked.push(query)
      return { matches: matching.includes(query), addEventListener: () => {}, removeEventListener: () => {} }
    },
  })
  return asked
}

describe('media queries in script', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('names the queries the CSS variants use', () => {
    expect(COARSE).toBe('(pointer: coarse)')
    expect(FINE).toBe('(pointer: fine)')
    // Tailwind's own max-sm: query, so script and CSS change at the same pixel.
    expect(PHONE).toBe('not all and (min-width: 640px)')
  })

  it('tells a finger from a mouse', () => {
    stubScreen(COARSE)
    expect(isCoarsePointer()).toBe(true)
    expect(matchesMedia(FINE)).toBe(false)
    stubScreen(FINE)
    expect(isCoarsePointer()).toBe(false)
    expect(matchesMedia(FINE)).toBe(true)
  })

  it('answers no where there is no window or no matchMedia (a test, a server render, an old browser)', () => {
    expect(isCoarsePointer()).toBe(false)
    vi.stubGlobal('window', {})
    expect(matchesMedia(COARSE)).toBe(false)
  })

  it('draws with the answer of the first render, before any effect has run', () => {
    const asked = stubScreen(COARSE, PHONE)
    const Probe = () => `${useCoarsePointer()}|${useMediaQuery(PHONE)}|${useMediaQuery(FINE)}`
    expect(renderToStaticMarkup(createElement(Probe))).toBe('true|true|false')
    expect(asked).toEqual([COARSE, PHONE, FINE])
  })
})
