import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { UNDO_MS, UndoStrip, insertAt } from './UndoStrip'

describe('putting a removed item back', () => {
  it('goes back where it stood', () => {
    expect(insertAt(['a', 'c'], 'b', 1)).toEqual(['a', 'b', 'c'])
    expect(insertAt(['b', 'c'], 'a', 0)).toEqual(['a', 'b', 'c'])
    expect(insertAt(['a', 'b'], 'c', 2)).toEqual(['a', 'b', 'c'])
  })

  it('goes to the end when the list has since become shorter, and never before the start', () => {
    expect(insertAt(['a'], 'z', 5)).toEqual(['a', 'z'])
    expect(insertAt([], 'z', 3)).toEqual(['z'])
    expect(insertAt(['a'], 'z', -2)).toEqual(['z', 'a'])
  })

  it('leaves the list it was given as it was', () => {
    const list = ['a', 'c']
    insertAt(list, 'b', 1)
    expect(list).toEqual(['a', 'c'])
  })
})

describe('the strip that offers it back', () => {
  it('says what went, as a polite announcement, with an Undo button', () => {
    const html = renderToStaticMarkup(<UndoStrip label="Width removed" onUndo={() => undefined} />)
    expect(html).toContain('role="status"')
    expect(html).toContain('Width removed')
    expect(html).toMatch(/<button type="button"[^>]*>.*Undo<\/button>/)
  })

  it('keeps a typed name in its own direction when the caller isolates it', () => {
    const html = renderToStaticMarkup(
      <UndoStrip
        label={
          <>
            Defect <bdi>زوائد قص</bdi> removed
          </>
        }
        onUndo={() => undefined}
      />,
    )
    expect(html).toContain('Defect <bdi>زوائد قص</bdi> removed')
  })

  it('runs its countdown bar over the time the offer lasts', () => {
    expect(UNDO_MS).toBe(6000)
    const html = renderToStaticMarkup(<UndoStrip label="Photo removed" onUndo={() => undefined} ms={4000} />)
    expect(html).toContain('transition-duration:4000ms')
    expect(html).toContain('transform:scaleX(1)')
  })
})
