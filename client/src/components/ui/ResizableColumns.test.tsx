import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { HANDLES_QUERY, LEAN_QUERY, TABLE_QUERY, TableFooter, roomBelow, sanitise, shownByDefault, spaceAfter, visibleWith, type ColumnDef } from './ResizableColumns'

/** A table shaped like History's: an everyday set, extras, a lean set for a narrower screen, and the fixed chevron. */
const COLUMNS: ColumnDef[] = [
  { key: 'seq', label: 'Seq', width: 72, defaultHidden: true },
  { key: 'order', label: 'Order', width: 176, lean: true },
  { key: 'status', label: 'Status', width: 208, lean: true },
  { key: 'item', label: 'Item', width: 220, flex: true, lean: true },
  { key: 'inspector', label: 'Inspector', width: 140 },
  { key: 'customer', label: 'Customer', width: 160, defaultHidden: true },
  { key: 'open', label: '', width: 48, hideable: false },
]
const keys = (columns: ColumnDef[]) => columns.map((c) => c.key)

describe('which columns a table starts with', () => {
  it('shows the everyday set on a wide screen and the lean set on a narrower one; the fixed column always', () => {
    expect(keys(visibleWith(COLUMNS, {}))).toEqual(['order', 'status', 'item', 'inspector', 'open'])
    expect(keys(visibleWith(COLUMNS, {}, true))).toEqual(['order', 'status', 'item', 'open'])
    expect(shownByDefault(COLUMNS[6], true)).toBe(true)
    expect(shownByDefault(COLUMNS[4])).toBe(true)
    expect(shownByDefault(COLUMNS[4], true)).toBe(false)
  })

  it('lets a choice win over either default', () => {
    expect(keys(visibleWith(COLUMNS, { inspector: true, customer: true }, true))).toEqual(['order', 'status', 'item', 'inspector', 'customer', 'open'])
    expect(keys(visibleWith(COLUMNS, { status: false }))).toEqual(['order', 'item', 'inspector', 'open'])
  })

  it('separates the table (from a tablet held upright) from the drag handles (a desktop with a mouse) and the lean set (below 1180 px)', () => {
    expect(TABLE_QUERY).toBe('(min-width: 768px)')
    expect(HANDLES_QUERY).toBe('(min-width: 1024px) and (pointer: fine)')
    expect(LEAN_QUERY).toBe('not all and (min-width: 1180px)')
  })
})

describe('what a table keeps on this device', () => {
  it('keeps a choice that changes something at either width, so it holds when the tablet turns', () => {
    // Inspector is shown by default only on a wide screen: ticked on a narrow one, it stays ticked on both.
    expect(sanitise({ shown: { inspector: true } }, COLUMNS).shown).toEqual({ inspector: true })
    expect(sanitise({ shown: { inspector: false } }, COLUMNS, true).shown).toEqual({ inspector: false })
    // Order is shown at both widths: a "shown" choice changes nothing anywhere, and is dropped.
    expect(sanitise({ shown: { order: true, customer: false } }, COLUMNS).shown).toEqual({})
  })

  it('reads every choice against the everyday set alone for a table with no lean set', () => {
    const plain = COLUMNS.map(({ lean: _lean, ...c }) => c)
    expect(sanitise({ shown: { inspector: true, customer: true } }, plain).shown).toEqual({ customer: true })
  })

  it('drops unknown keys, clamps widths, reads the old list of hidden keys, and never leaves the table empty', () => {
    const out = sanitise({ widths: { order: 5, item: 99999, nope: 100 }, shown: { nope: true, open: false }, hidden: ['inspector'] }, COLUMNS)
    expect(out.widths).toEqual({ order: 56, item: 1200 })
    expect(out.shown).toEqual({ inspector: false })
    expect(sanitise({ shown: { order: false, status: false, item: false } }, COLUMNS, true).shown).toEqual({})
    expect(sanitise('garbage', COLUMNS)).toEqual({ widths: {}, shown: {} })
  })
})

// ---- The frame's room: a few boxes standing in for the page --------------------------------------------------------

interface FakeBox {
  tagName: string
  top: number
  height: number
  style: { position: string; paddingBottom: string; borderBottomWidth: string }
  hidden?: boolean
  parentElement: FakeBox | null
  nextElementSibling: FakeBox | null
  getBoundingClientRect: () => { top: number; bottom: number }
  getClientRects: () => unknown[]
}

function box(tagName: string, top: number, height: number, opts: { padding?: number; border?: number; position?: string; hidden?: boolean } = {}): FakeBox {
  const b: FakeBox = {
    tagName,
    top,
    height,
    hidden: opts.hidden,
    style: { position: opts.position ?? 'static', paddingBottom: `${opts.padding ?? 0}px`, borderBottomWidth: `${opts.border ?? 0}px` },
    parentElement: null,
    nextElementSibling: null,
    getBoundingClientRect: () => ({ top: b.top, bottom: b.top + b.height }),
    getClientRects: () => (b.hidden ? [] : [{}]),
  }
  return b
}
function nest(parent: FakeBox, children: FakeBox[]) {
  children.forEach((c, i) => {
    c.parentElement = parent
    c.nextElementSibling = children[i + 1] ?? null
  })
}

describe('the room a table frame leaves under it', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('adds the footer below it, the gap above the footer, and main’s bottom padding and safe area — nothing beside or hidden', () => {
    const body = box('BODY', 0, 2000)
    const main = box('MAIN', 64, 900, { padding: 20, border: 34 })
    const page = box('DIV', 84, 800)
    const cards = box('DIV', 140, 0, { hidden: true }) // the phone cards, display: none on a tablet
    const card = box('DIV', 140, 600)
    const frame = box('DIV', 140, 600)
    const footer = box('DIV', 752, 60) // 12 px below the card
    const toast = box('DIV', 900, 80, { position: 'fixed' })
    nest(body, [main])
    nest(main, [page])
    nest(page, [cards, card, footer, toast])
    nest(card, [frame])
    vi.stubGlobal('document', { body })
    vi.stubGlobal('getComputedStyle', (el: FakeBox) => el.style)
    expect(spaceAfter(frame as unknown as Element)).toBe(12 + 60 + 20 + 34)
  })

  it('stops at the box the page scrolls in, as it does at main: the assistant’s popup draws a page without a main', () => {
    const body = box('BODY', 0, 1000)
    const section = box('SECTION', 0, 1000, { padding: 50 })
    const scroller = box('DIV', 64, 600, { padding: 20 })
    const frame = box('DIV', 84, 560)
    nest(body, [section])
    nest(section, [scroller])
    nest(scroller, [frame])
    ;(scroller as unknown as { hasAttribute: (n: string) => boolean }).hasAttribute = (n) => n === 'data-app-scroll'
    vi.stubGlobal('document', { body })
    vi.stubGlobal('getComputedStyle', (el: FakeBox) => el.style)
    expect(spaceAfter(frame as unknown as Element)).toBe(20)
  })

  it('measures the room a frame has against the box it scrolls in, as that box is scrolled, not against the window', () => {
    const body = box('BODY', 0, 1000)
    // The shell's main: 700 px tall from 64, scrolled down 100 px, so the frame (laid out 20 px into it) shows at -16.
    const main = box('MAIN', 64, 700, { padding: 20 })
    const frame = box('DIV', -16, 560)
    nest(body, [main])
    nest(main, [frame])
    Object.assign(main, { hasAttribute: (n: string) => n === 'data-app-scroll', clientHeight: 700, clientTop: 0, scrollTop: 100 })
    Object.assign(frame, { closest: (q: string) => (q === '[data-app-scroll]' ? main : null) })
    vi.stubGlobal('document', { body })
    vi.stubGlobal('window', { innerHeight: 9999, scrollY: 0 })
    vi.stubGlobal('getComputedStyle', (el: FakeBox) => el.style)
    // 700 − (where it starts in the box: −16 − 64 + 100 = 20) − main's bottom padding.
    expect(roomBelow(frame as unknown as HTMLElement)).toBe(700 - 20 - 20)
  })

  it('is only the padding that closes the page when nothing follows the frame', () => {
    const body = box('BODY', 0, 1000)
    const main = box('MAIN', 64, 600, { padding: 20 })
    const frame = box('DIV', 84, 560)
    nest(body, [main])
    nest(main, [frame])
    vi.stubGlobal('document', { body })
    vi.stubGlobal('getComputedStyle', (el: FakeBox) => el.style)
    expect(spaceAfter(frame as unknown as Element)).toBe(20)
  })
})

describe('the list’s footer on a touch screen', () => {
  const footer = (extra?: JSX.Element) =>
    renderToStaticMarkup(<TableFooter shown={100} total={1351} noun="sessions" hasMore loadingMore={false} onMore={() => {}} pageSize={100} onPageSize={() => {}} extra={extra} />)

  it('gives the next page and the page size 44 px for a finger', () => {
    const html = footer()
    expect(html).toMatch(/<button[^>]*class="[^"]*touch:h-11[^"]*"[^>]*>Show the next 100/)
    expect(html).toMatch(/<select[^>]*class="[^"]*touch:h-11/)
  })

  it('sets the figures apart by space, never by a dot a wrapped line would start with', () => {
    const html = footer(
      <>
        <b>2 open</b>
        <b>25 closed</b>
      </>,
    )
    expect(html).toContain('<span class="flex flex-wrap items-center gap-x-3 gap-y-2"><b>2 open</b><b>25 closed</b></span>')
    expect(html).not.toContain('·')
  })
})
