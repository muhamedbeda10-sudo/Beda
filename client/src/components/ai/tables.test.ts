import { describe, expect, it } from 'vitest'
import {
  asciiDigits,
  cellNumber,
  codeLanguage,
  hastDirection,
  hastTableData,
  letterDirection,
  looksNumeric,
  numericColumns,
  numericTextColumns,
  plainNumber,
  proseDirection,
  rehypeAiTables,
  tableDirection,
  tableTsv,
  textDirection,
  textTableSheet,
  type HastNode,
} from './tables'

const text = (value: string): HastNode => ({ type: 'text', value })
const el = (tagName: string, children: HastNode[] = [], properties: Record<string, unknown> = {}): HastNode => ({ type: 'element', tagName, properties, children })
const row = (tag: 'th' | 'td', cells: (string | HastNode)[]) => el('tr', cells.map((c) => el(tag, [typeof c === 'string' ? text(c) : c])))

describe('figures in a table', () => {
  it('knows a figure as people write it', () => {
    for (const t of ['39', '1,204', '1.29%', '-4.5', '−4.5', '+12', '$3.20', 'EGP 1,000', '1.5 mm', '12 pcs', '2.5 pp', '3×', '٣٩', '١٬٢٠٤', '١٫٥٪', ' 7 ']) expect(looksNumeric(t), t).toBe(true)
    for (const t of ['', 'RF-01', '24-0117', 'Sep 8', '2026-10-09', 'Line 3', 'twelve', '1,23', '12 pieces each', '#3']) expect(looksNumeric(t), t).toBe(false)
  })

  it('reads Arabic digits and signs as ASCII', () => {
    expect(asciiDigits('١٬٢٠٤٫٥٪ ۴۲')).toBe('1,204.5% 42')
  })

  it('takes a plain number to Excel as a number, and nothing else', () => {
    expect(plainNumber('1,204')).toBe(1204)
    expect(plainNumber('-4.5')).toBe(-4.5)
    expect(plainNumber('−4.5')).toBe(-4.5)
    expect(plainNumber('٣٩')).toBe(39)
    expect(plainNumber('1.29%')).toBeNull()
    expect(plainNumber('12 pcs')).toBeNull()
    expect(plainNumber('1,23')).toBeNull()
  })

  it('reads a value of a query as a number for a chart', () => {
    expect(cellNumber(12)).toBe(12)
    expect(cellNumber('9007199254740993')).toBe(9007199254740992)
    expect(cellNumber('1.29%')).toBe(1.29)
    expect(cellNumber('١٫٥٪')).toBe(1.5)
    expect(cellNumber('RF-01')).toBeNull()
    expect(cellNumber(true)).toBeNull()
    expect(cellNumber(null)).toBeNull()
    expect(cellNumber(Number.NaN)).toBeNull()
  })

  it('calls a column of text cells figures when all but its blanks are', () => {
    const rows = [
      ['RF-01', '1,204', '1.29%', '—', ''],
      ['RF-02', '39', 'n/a', '—', '7'],
      ['RF-03', '', '0.5%', '', 'x'],
    ]
    expect(numericTextColumns(5, rows)).toEqual([false, true, true, false, false])
  })

  it('calls a column of a query figures when it holds numbers, or text that is one, and NULLs', () => {
    const rows = [
      ['RF-01', 12, '9007199254740993', true, null, 1],
      ['RF-02', null, '12', false, null, 'two'],
    ]
    expect(numericColumns(['machine', 'pieces', 'big', 'flag', 'empty', 'mixed'], rows)).toEqual([false, true, true, false, false, false])
  })
})

describe('the direction of a table', () => {
  it('reads by the first strong letter, Arabic digits being weak', () => {
    expect(textDirection('٣٩ قطعة')).toBe('rtl')
    expect(textDirection('39 pieces')).toBe('ltr')
    expect(textDirection('١٢٣ — 45')).toBeNull()
    expect(textDirection('')).toBeNull()
  })

  it('takes its header’s, else its first cell that says', () => {
    expect(tableDirection(['العيب', 'Pieces'], [])).toBe('rtl')
    expect(tableDirection(['#', '%'], [['1', 'خدش']])).toBe('rtl')
    expect(tableDirection(['#'], [['1']])).toBe('ltr')
  })
})

describe('the direction of an answer’s text', () => {
  it('reads by most of the letters, not the first', () => {
    expect(letterDirection('LM4 هو أسوأ خط هذا الشهر')).toBe('rtl')
    expect(letterDirection('The customer شركة ordered 40 pieces')).toBe('ltr')
    expect(letterDirection('١٢٣ — 45%')).toBeNull()
  })

  it('reads an answer as a whole by its prose: never by its code or addresses', () => {
    // Every block of it names its own direction, so dir="auto" on the whole would find nothing and fall back to left to right.
    expect(proseDirection('## الخلاصة\n\n- LM4 هو أسوأ خط\n- خط الدهان LM2\n\n> ملاحظة: الأرقام تشمل جميع الورديات')).toBe('rtl')
    expect(proseDirection('أكثر العيوب:\n\n```sql\nSELECT defect_type, sum(defect_pieces) AS pieces FROM ai.production_between(current_date - 29, current_date, \'day\') GROUP BY 1\n```')).toBe('rtl')
    expect(proseDirection('راجع [سجل الجلسة](/history?session=abcdefghijklmnopqrstuvwxyz) و `ai.production_between_with_a_long_name`')).toBe('rtl')
    expect(proseDirection('انظر https://qc.example.com/inspections/very-long-path-with-many-latin-letters')).toBe('rtl')
    // A fence still open while the answer streams is code too.
    expect(proseDirection('الخلاصة\n\n```sql\nSELECT defect_type, defect_pieces FROM ai.production')).toBe('rtl')
    expect(proseDirection('Defects fell 12% on **LM4** (شركة الأمل).')).toBe('ltr')
    expect(proseDirection('| # | % |\n|---|---|\n| 1 | 2 |')).toBe('ltr')
  })

  it('reads a block (a list, a quote) by the letters in it outside code; none in it, none', () => {
    const quote = el('blockquote', [el('p', [text('ملاحظة: '), el('code', [text('ai.production_between_with_a_long_name')]), text(' تشمل الورديات')])])
    expect(hastDirection(quote)).toBe('rtl')
    expect(hastDirection(el('ul', [el('li', [text('Scratch — 135')])]))).toBe('ltr')
    expect(hastDirection(el('ol', [el('li', [text('39')])]))).toBeNull()
  })
})

describe('a code block of an answer', () => {
  it('names its language as the model did, and nothing that is no language', () => {
    const pre = (className?: unknown) => el('pre', [el('code', [text('SELECT 1')], className === undefined ? {} : { className })])
    expect(codeLanguage(pre(['language-sql']))).toBe('sql')
    expect(codeLanguage(pre('language-json'))).toBe('json')
    expect(codeLanguage(pre())).toBeNull()
    expect(codeLanguage(pre(['language-<script>']))).toBeNull()
  })
})

describe('a table to the clipboard and to Excel', () => {
  it('writes tab-separated text, quoting a cell with a tab, a line break or a quote', () => {
    expect(tableTsv(['Machine', 'Note'], [['RF-01', 'ok'], ['RF-02', 'said "stop"\tnow'], ['RF-03', 'two\nlines']])).toBe(
      'Machine\tNote\r\nRF-01\tok\r\nRF-02\t"said ""stop""\tnow"\r\nRF-03\t"two\nlines"',
    )
  })

  it('makes a sheet of a markdown table: plain figures as numbers, the rest as written', () => {
    const sheet = textTableSheet('Table', ['Machine', 'Pieces', 'Rate'], [
      ['RF-01', '1,204', '1.29%'],
      ['RF-02', '—', '0.5%'],
      ['', '٣٩', ''],
    ])
    expect(sheet).toEqual({
      name: 'Table',
      header: ['Machine', 'Pieces', 'Rate'],
      rows: [
        ['RF-01', 1204, '1.29%'],
        ['RF-02', null, '0.5%'],
        [null, 39, null],
      ],
    })
  })
})

describe('a markdown table as the renderer holds it', () => {
  const table = () =>
    el('table', [
      el('thead', [row('th', ['العيب', 'القطع'])]),
      el('tbody', [row('td', [el('strong', [text('Weld porosity')]), '1,204']), row('td', ['خدش', el('em', [text('39')])]), el('tr', [el('td', [text('a'), el('br'), text('b')])])]),
    ])

  it('gives its words: the header and every row, as wide as the widest, line breaks as spaces', () => {
    expect(hastTableData(table())).toEqual({
      header: ['العيب', 'القطع'],
      rows: [
        ['Weld porosity', '1,204'],
        ['خدش', '39'],
        ['a b', ''],
      ],
    })
  })

  it('marks the table’s direction and the cells of a column of figures, dropping the model’s alignment there', () => {
    const t = table()
    const tbody = t.children![1]
    tbody.children![0].children![1].properties = { align: 'right' }
    tbody.children![0].children![0].properties = { align: 'center' }
    const tree = el('div', [t])
    rehypeAiTables()(tree)
    expect(t.properties?.dir).toBe('rtl')
    const [headRow] = t.children![0].children!
    expect(headRow.children!.map((c) => c.properties)).toEqual([{ dataAiDir: 'rtl' }, { dataAiDir: 'rtl', dataAiNumeric: 'true' }])
    const [first, , last] = tbody.children!
    expect(first.children![0].properties).toEqual({ align: 'center', dataAiDir: 'rtl' })
    expect(first.children![1].properties).toEqual({ dataAiDir: 'rtl', dataAiNumeric: 'true' })
    // A row shorter than the header: its cells are marked as far as they go.
    expect(last.children!).toHaveLength(1)
  })
})
