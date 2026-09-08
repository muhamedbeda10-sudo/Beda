// Writes a workbook (.xlsx — Office Open XML SpreadsheetML) from plain grids,
// the mirror of ./xlsx which reads one. Scope, deliberately:
//   • One sheet per grid; a cell is a number, a string or empty. Strings are
//     written inline (no shared-string table), which every reader accepts and
//     keeps the writer to a page.
//   • A bold header row and column widths sized from the content, so the file
//     opens readable without a macro.
//   • Nothing else: no formulas, styles beyond bold, merged cells or charts.
//     A dashboard export is numbers a manager will chart in Excel anyway.
//
// The archive is built with `fflate`; the XML is escaped by hand because the
// parts are small and fixed in shape.

import { strToU8, zipSync } from 'fflate'

export type CellValue = string | number | null | undefined

export interface SheetSpec {
  /** Excel allows 31 characters and forbids : \ / ? * [ ]. Longer names are cut; bad characters replaced. */
  name: string
  header: string[]
  rows: CellValue[][]
}

const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
const MAIN_NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
const REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'

export function escapeXml(s: string): string {
  return s.replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c] ?? c)
}

/** Control characters are not allowed in XML 1.0 text; they are dropped, tab and newline kept. */
function cleanText(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '')
}

export function sheetName(raw: string, taken: Set<string>): string {
  let base = raw.replace(/[:\\/?*[\]]/g, ' ').trim().slice(0, 31) || 'Sheet'
  let name = base
  let n = 2
  while (taken.has(name.toLowerCase())) {
    const suffix = ` (${n++})`
    name = base.slice(0, 31 - suffix.length) + suffix
  }
  taken.add(name.toLowerCase())
  return name
}

/** 0 → A, 25 → Z, 26 → AA. */
export function columnLetter(index: number): string {
  let s = ''
  let n = index + 1
  while (n > 0) {
    const r = (n - 1) % 26
    s = String.fromCharCode(65 + r) + s
    n = Math.floor((n - 1) / 26)
  }
  return s
}

function cellXml(ref: string, v: CellValue, styleId: number): string {
  const s = styleId ? ` s="${styleId}"` : ''
  if (v === null || v === undefined || v === '') return ''
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return ''
    return `<c r="${ref}"${s}><v>${v}</v></c>`
  }
  return `<c r="${ref}" t="inlineStr"${s}><is><t xml:space="preserve">${escapeXml(cleanText(String(v)))}</t></is></c>`
}

function sheetXml(spec: SheetSpec): string {
  const widths = spec.header.map((h, c) => {
    let w = String(h).length
    for (const row of spec.rows) {
      const v = row[c]
      if (v === null || v === undefined) continue
      w = Math.max(w, String(v).length)
    }
    return Math.min(60, Math.max(8, w + 2))
  })
  const cols = widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('')
  const lines: string[] = []
  const header = spec.header.map((h, c) => cellXml(`${columnLetter(c)}1`, h, 1)).join('')
  lines.push(`<row r="1">${header}</row>`)
  spec.rows.forEach((row, r) => {
    const cells = row.map((v, c) => cellXml(`${columnLetter(c)}${r + 2}`, v, 0)).join('')
    lines.push(`<row r="${r + 2}">${cells}</row>`)
  })
  const lastCol = columnLetter(Math.max(0, spec.header.length - 1))
  const lastRow = spec.rows.length + 1
  return (
    XML_HEAD +
    `<worksheet xmlns="${MAIN_NS}" xmlns:r="${REL_NS}">` +
    `<dimension ref="A1:${lastCol}${lastRow}"/>` +
    `<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>` +
    `<sheetFormatPr defaultRowHeight="15"/>` +
    (cols ? `<cols>${cols}</cols>` : '') +
    `<sheetData>${lines.join('')}</sheetData>` +
    `</worksheet>`
  )
}

const STYLES =
  XML_HEAD +
  `<styleSheet xmlns="${MAIN_NS}">` +
  `<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>` +
  `<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>` +
  `<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>` +
  `<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>` +
  `<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs>` +
  `<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>` +
  `</styleSheet>`

/** The bytes of a workbook with one sheet per spec. */
export function writeWorkbook(sheets: SheetSpec[]): Uint8Array {
  if (sheets.length === 0) throw new Error('A workbook needs at least one sheet.')
  const taken = new Set<string>()
  const named = sheets.map((s) => ({ ...s, name: sheetName(s.name, taken) }))
  const files: Record<string, Uint8Array> = {}
  files['[Content_Types].xml'] = strToU8(
    XML_HEAD +
      `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
      `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
      `<Default Extension="xml" ContentType="application/xml"/>` +
      `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
      `<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>` +
      named.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('') +
      `</Types>`,
  )
  files['_rels/.rels'] = strToU8(
    XML_HEAD +
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>` +
      `</Relationships>`,
  )
  files['xl/workbook.xml'] = strToU8(
    XML_HEAD +
      `<workbook xmlns="${MAIN_NS}" xmlns:r="${REL_NS}"><sheets>` +
      named.map((s, i) => `<sheet name="${escapeXml(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('') +
      `</sheets></workbook>`,
  )
  files['xl/_rels/workbook.xml.rels'] = strToU8(
    XML_HEAD +
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      named.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('') +
      `<Relationship Id="rId${named.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
      `</Relationships>`,
  )
  files['xl/styles.xml'] = strToU8(STYLES)
  named.forEach((s, i) => {
    files[`xl/worksheets/sheet${i + 1}.xml`] = strToU8(sheetXml(s))
  })
  return zipSync(files, { level: 6 })
}

/** Hands the workbook to the browser as a download. */
export function downloadWorkbook(filename: string, sheets: SheetSpec[]): void {
  const bytes = writeWorkbook(sheets)
  const blob = new Blob([bytes as BlobPart], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename.endsWith('.xlsx') ? filename : `${filename}.xlsx`
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
