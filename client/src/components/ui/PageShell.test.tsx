import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { ExportMenu, FilterBar, FilterSelect, HeaderStat, Segmented } from './PageShell'

const noop = () => {}
/** The class list of the first element whose markup contains `marker`. */
const classOf = (html: string, marker: string) => {
  const at = html.indexOf(marker)
  const open = html.lastIndexOf('<', at)
  return /class="([^"]*)"/.exec(html.slice(open, html.indexOf('>', at) + 1))?.[1] ?? ''
}
/** The class list of the element just around `marker`. */
const parentClassOf = (html: string, marker: string) => {
  const before = html.slice(0, html.indexOf(marker))
  return /class="([^"]*)"[^>]*>$/.exec(before)?.[1] ?? ''
}

describe('the filter row on a phone and a tablet', () => {
  it('heads a phone’s bar with the actions on a row of their own, by default', () => {
    const html = renderToStaticMarkup(<FilterBar chips={[]} onReset={noop} canReset={false} leading={<b id="switch" />} actions={<i id="export" />} />)
    const actions = parentClassOf(html, '<i id="export"').split(' ')
    expect(actions).toEqual(expect.arrayContaining(['max-md:order-first', 'max-md:w-full', 'md:ml-auto']))
    // The switch is not wrapped: the row is as it always was.
    expect(html).toContain('<b id="switch"></b>')
    expect(html).not.toContain('<div class="flex min-w-0 items-center gap-2 max-md:order-first"><b')
  })

  it('puts the actions beside the view switch with actionsInline, at the row’s right end', () => {
    const html = renderToStaticMarkup(<FilterBar chips={[]} onReset={noop} canReset={false} actionsInline leading={<b id="switch" />} actions={<i id="export" />} />)
    expect(html).toContain('<div class="flex min-w-0 items-center gap-2 max-md:order-first"><b id="switch"></b></div>')
    const actions = parentClassOf(html, '<i id="export"').split(' ')
    expect(actions).toEqual(expect.arrayContaining(['max-md:order-first', 'max-md:ml-auto', 'md:ml-auto']))
    expect(actions).not.toContain('max-md:w-full')
  })

  it('keeps the row on one line only from a wide screen, and never squeezes Reset or breaks More filters', () => {
    const html = renderToStaticMarkup(<FilterBar chips={[]} onReset={noop} canReset singleRow more={<span />} />)
    expect(html).toContain('flex flex-wrap items-center gap-2 xl:flex-nowrap')
    expect(html).not.toContain('md:flex-nowrap')
    expect(classOf(html, 'aria-label="Reset all filters"')).toContain('shrink-0')
    expect(classOf(html, 'aria-haspopup="dialog"')).toContain('whitespace-nowrap')
  })

  it('sets two selects side by side on a phone, and one alone across the row', () => {
    const cls = classOf(renderToStaticMarkup(<FilterSelect label="Status" value="" onChange={noop}><option /></FilterSelect>), '<select').split(' ')
    expect(cls).toEqual(expect.arrayContaining(['max-md:!w-auto', 'max-md:min-w-[calc(50%-4px)]', 'max-md:flex-1', 'touch:h-11']))
    expect(cls).not.toContain('max-md:!w-[calc(50%-4px)]')
  })
})

describe('the switch, the export and the figures on a touch screen', () => {
  const options = [
    { value: 'cards', label: 'Cards', icon: <svg /> },
    { value: 'table', label: 'Table', icon: <svg /> },
  ]

  it('never breaks a tab’s words, and scrolls a switch wider than its row', () => {
    const html = renderToStaticMarkup(<Segmented label="View" value="cards" options={options} onChange={noop} />)
    expect(classOf(html, 'role="tablist"').split(' ')).toEqual(expect.arrayContaining(['max-w-full', 'overflow-x-auto', 'scrollbar-none']))
    expect(classOf(html, 'role="tab"')).toContain('whitespace-nowrap')
  })

  it('hides the words between a tablet and a wide screen only under a mouse', () => {
    const html = renderToStaticMarkup(<Segmented label="View" value="cards" options={options} onChange={noop} iconsWhenTight />)
    expect(html).toContain('<span class="md:max-2xl:mouse:sr-only">Cards</span>')
    expect(classOf(html, 'role="tab"')).toContain('md:max-2xl:mouse:px-2.5')
    expect(html).not.toMatch(/md:max-2xl:sr-only|md:max-2xl:px-2\.5/)
  })

  it('names the one export in words on a touch screen, 44 px tall', () => {
    const html = renderToStaticMarkup(<ExportMenu items={[{ label: 'Export Excel', onClick: noop }]} />)
    expect(html).toContain('<span class="hidden touch:inline 2xl:inline">Export Excel</span>')
    expect(classOf(html, '<button')).toContain('touch:h-11')
  })

  it('draws a figure that opens what it counts as a chip on a touch screen, and leaves a plain one as text', () => {
    const button = renderToStaticMarkup(<HeaderStat value={3} label="open" onClick={noop} />)
    expect(classOf(button, '<button')).toContain('touch:min-h-[40px]')
    expect(classOf(button, '<button')).toContain('dark:touch:ring-slate-700')
    expect(renderToStaticMarkup(<HeaderStat value={0} label="open" onClick={noop} />)).not.toContain('<button')
  })
})
