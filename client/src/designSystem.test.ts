// The stylesheet the app ships, built the way Vite builds it (Tailwind over src/index.css with tailwind.config.js),
// for a page that uses the classes in question. What is checked here broke on tablets before: the `touch:` sizes
// lost to `sm:` ones, an sr-only label stretched the History page, and `.safe-bottom` ate the padding it sat beside.

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import postcss from 'postcss'
import tailwind from 'tailwindcss'

const here = (path: string) => new URL(path, import.meta.url)

async function build(classes: string): Promise<string> {
  const { default: config } = await import(/* @vite-ignore */ here('../tailwind.config.js').href)
  const css = readFileSync(here('./index.css'), 'utf8')
  const out = await postcss([tailwind({ ...config, content: [{ raw: `<div class="${classes}"></div>`, extension: 'html' }] })]).process(css, { from: undefined })
  // One line, and no `;` before a `}`, whichever way the build writes it.
  return out.css.replace(/\s+/g, ' ').replace(/;\s*}/g, ' }')
}

describe('the design system’s stylesheet', () => {
  it('gives a touch size the last word over a width size on the same element', async () => {
    const css = await build('h-11 sm:h-10 touch:h-11 dark:touch:ring-slate-700')
    // One class stronger than `.sm\:h-10`, so a tablet (640 px and up, a finger) gets 44 px, not 40.
    expect(css).toContain('@media (pointer: coarse) { :root .touch\\:h-11 { height: 2.75rem }')
    expect(css).toContain('@media (min-width: 640px) { .sm\\:h-10 { height: 2.5rem }')
    // A dark-mode touch class still applies: .dark is matched at the end, not as an ancestor of :root.
    expect(css).toContain(':root .dark\\:touch\\:ring-slate-700:is(.dark *)')
  })

  it('keeps the max-* and range classes, and nests the mouse: variant inside them', async () => {
    const css = await build('max-md:w-full md:max-2xl:mouse:sr-only')
    expect(css).toContain('@media not all and (min-width: 768px) { .max-md\\:w-full { width: 100% }')
    expect(css).toMatch(/@media \(min-width: 768px\) \{ @media not all and \(min-width: 1536px\) \{ @media \(pointer: fine\) \{ :root \.md\\:max-2xl\\:mouse\\:sr-only \{ position: absolute;/)
  })

  it('makes a table’s scroll frame the box its sr-only labels are placed in', async () => {
    const css = await build('grid-scroll')
    expect(css).toMatch(/\.grid-scroll \{ position: relative;/)
  })

  it('adds the safe area to an element’s padding instead of putting it in its place', async () => {
    const css = await build('pb-2 safe-bottom')
    expect(css).toContain('.safe-bottom { border-bottom: env(safe-area-inset-bottom, 0px) solid transparent; border-bottom-color: transparent !important }')
    expect(css).not.toMatch(/\.safe-bottom \{[^}]*padding/)
    expect(css).toContain('.pb-2 { padding-bottom: 0.5rem }')
  })

  it('draws every text box at 16 px on a touch screen, so iOS does not zoom in as it takes focus', async () => {
    const css = await build('input text-sm text-lg label')
    const rule =
      "@media (pointer: coarse) { .input:not([class~='text-base']):not([class~='text-lg']):not([class~='text-xl']):not([class~='text-2xl']):not([class~='text-3xl']), " +
      ".input-cell:not([class~='text-base']):not([class~='text-lg']):not([class~='text-xl']):not([class~='text-2xl']):not([class~='text-3xl']), " +
      ":is(input, select, textarea):is([class~='text-xs'], [class~='text-13'], [class~='text-sm']) { font-size: 16px }"
    expect(css).toContain(rule)
    // Written after the utilities, so a box's own text-sm comes first and loses.
    expect(css.indexOf('.text-sm {')).toBeLessThan(css.indexOf(rule))
    // Once only: no class that applies text-sm or text-xs (.input, .label) carries a copy of it.
    expect(css.split('font-size: 16px')).toHaveLength(2)
  })

  it('holds a dialog to the window’s height, in dvh with a vh fallback', async () => {
    const css = await build('max-h-dialog max-h-sheet')
    expect(css).toContain('.max-h-dialog { max-height: 92vh; max-height: 92dvh }')
    expect(css).toContain('@media (min-width: 640px) { .max-h-dialog { max-height: calc(100vh - 2rem); max-height: calc(100dvh - 2rem) } }')
    expect(css).toContain('.max-h-sheet { max-height: 92vh; max-height: 92dvh }')
  })

  it('pins a table’s first or last column, weaker than any class on the cell itself, its shadow on the inner side', async () => {
    const css = await build('table-sticky-first table-sticky-last')
    expect(css).toContain(':where(.table-sticky-first > :is(thead, tbody, tfoot) > tr) > :first-child, :where(.table-sticky-last > :is(thead, tbody, tfoot) > tr) > :last-child {')
    expect(css).toMatch(/:where\(\.table-sticky-first[^{]*> :first-child \{ --sticky-inner: 1; inset-inline-start: 0 \}/)
    expect(css).toMatch(/:where\(\.table-sticky-first[^{]*> :first-child:where\(:dir\(rtl\)\) \{ --sticky-inner: -1 \}/)
    expect(css).toContain(':where([data-overflow-start] .table-sticky-first > :is(thead, tbody, tfoot) > tr) > :first-child')
  })
})
