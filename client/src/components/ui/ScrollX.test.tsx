import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { EdgeShadows, ScrollX, edgesOf } from './ScrollX'

describe('the ends a sideways strip hides', () => {
  it('hides nothing when everything fits, or all but a pixel of rounding does', () => {
    expect(edgesOf({ scrollLeft: 0, scrollWidth: 360, clientWidth: 360 })).toEqual({ start: false, end: false })
    expect(edgesOf({ scrollLeft: 0, scrollWidth: 361, clientWidth: 360 })).toEqual({ start: false, end: false })
  })

  it('hides the end at the start, both ends in the middle, the start at the end', () => {
    const strip = { scrollWidth: 1000, clientWidth: 400 }
    expect(edgesOf({ ...strip, scrollLeft: 0 })).toEqual({ start: false, end: true })
    expect(edgesOf({ ...strip, scrollLeft: 300 })).toEqual({ start: true, end: true })
    expect(edgesOf({ ...strip, scrollLeft: 600 })).toEqual({ start: true, end: false })
  })

  it('reads a right-to-left strip the same way: 0 at its start, counting down to its end', () => {
    const strip = { scrollWidth: 1000, clientWidth: 400 }
    expect(edgesOf({ ...strip, scrollLeft: 0 })).toEqual({ start: false, end: true })
    expect(edgesOf({ ...strip, scrollLeft: -300 })).toEqual({ start: true, end: true })
    expect(edgesOf({ ...strip, scrollLeft: -600 })).toEqual({ start: true, end: false })
  })

  it('takes a fraction of a pixel short of either end as the end (a zoomed screen rounds)', () => {
    const strip = { scrollWidth: 1000, clientWidth: 400 }
    expect(edgesOf({ ...strip, scrollLeft: 0.6 })).toEqual({ start: false, end: true })
    expect(edgesOf({ ...strip, scrollLeft: 599.4 })).toEqual({ start: true, end: false })
  })
})

describe('the sideways scroller', () => {
  it('is a positioned frame, so an absolutely placed child (sr-only text) cannot widen the page', () => {
    const html = renderToStaticMarkup(
      <ScrollX className="mt-2" innerClassName="max-h-96">
        <table />
      </ScrollX>,
    )
    expect(html).toMatch(/^<div class="relative mt-2"><div class="relative overflow-x-auto overscroll-x-contain max-h-96"><table><\/table><\/div>/)
    // No name, no region: an unnamed scroller is no landmark and takes no tab stop.
    expect(html).not.toContain('role="region"')
    expect(html).not.toContain('tabindex')
  })

  it('is a named region a keyboard can reach when it has a label', () => {
    const html = renderToStaticMarkup(
      <ScrollX label="Open sessions">
        <table />
      </ScrollX>,
    )
    expect(html).toContain('role="region" aria-label="Open sessions" tabindex="0"')
  })

  it('draws its edge shadows hidden until it has measured an end to show, and none when told so', () => {
    const html = renderToStaticMarkup(
      <ScrollX>
        <table />
      </ScrollX>,
    )
    expect(html.match(/aria-hidden="true"/g)).toHaveLength(2)
    expect(html.match(/opacity-0/g)).toHaveLength(2)
    expect(html).not.toContain('data-overflow-')
    const bare = renderToStaticMarkup(
      <ScrollX shadows="none">
        <table />
      </ScrollX>,
    )
    expect(bare).not.toContain('aria-hidden')
  })

  it('puts the start shadow at the right of a right-to-left strip', () => {
    const shadows = (rtl: boolean) =>
      renderToStaticMarkup(<EdgeShadows start end={false} rtl={rtl} />)
        .split('</span>')
        .filter(Boolean)
        .map((s) => (s.includes('left-0') ? 'left' : 'right') + (s.includes('opacity-100') ? ':on' : ':off'))
    expect(shadows(false)).toEqual(['left:on', 'right:off'])
    expect(shadows(true)).toEqual(['left:off', 'right:on'])
  })
})
