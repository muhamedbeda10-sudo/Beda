// ============================================================================
// §20 — the tables of an answer, as data: the markdown tables the model
// writes and the rows its queries return. Which columns hold figures (they
// align right, in left-to-right digits, whatever the language around them),
// which way a table reads, and the table as text for the clipboard or as a
// sheet for Excel. Pure functions, so they are tested without a browser.
// ============================================================================

import type { AiCell } from '@qc/shared/ai'
import type { CellValue, SheetSpec } from '@/lib/xlsxWrite'
import { EXCEL_CELL_MAX } from './exportAiResult'

/** A cell as text: blank for NULL, JSON for a structured value (a json column arrives parsed). */
export function cellText(v: AiCell | unknown): string {
  if (v === null || v === undefined) return ''
  if (typeof v === 'string') return v
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  return JSON.stringify(v)
}

// ---- Figures as people write them -----------------------------------------------------

/** Arabic-Indic and Persian digits, and the Arabic decimal, thousands and percent signs, as ASCII. */
export function asciiDigits(s: string): string {
  return s.replace(/[٠-٬۰-۹]/g, (c) => {
    const code = c.charCodeAt(0)
    if (code >= 0x0660 && code <= 0x0669) return String(code - 0x0660)
    if (code >= 0x06f0 && code <= 0x06f9) return String(code - 0x06f0)
    if (code === 0x066a) return '%'
    if (code === 0x066b) return '.'
    return ','
  })
}

/** What an empty cell may be written as: nothing, a dash, n/a. It leaves a column's kind alone. */
const BLANK = /^(?:|[-–—]|n\/?a|null|none|غير متاح|لا يوجد)$/i
/** A figure: a sign, a currency, digits (grouped by thousands or not), decimals, then %, pp, × or a short unit ("1.5 mm", "12 pcs"). */
const FIGURE = /^[+\-−]?(?:[$€£]\s?|(?:EGP|USD|EUR)\s)?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?(?:\s?(?:%|pp|[x×]|[a-z]{1,4}\.?))?$/i
/** A plain number: a sign, digits grouped by thousands or not, decimals. */
const PLAIN = /^[+\-−]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?$/

export const isBlankText = (text: string): boolean => BLANK.test(text.trim())

/** Whether a cell's text is a figure: "39", "1,234", "1.29%", "−4.5", "$3.20", "1.5 mm", "٣٩". */
export function looksNumeric(text: string): boolean {
  const t = asciiDigits(text.trim())
  return t !== '' && FIGURE.test(t)
}

/** A plain number written as text ("1,234", "-4.5", "١٢٣") as a number; anything else (units, %, words) null. */
export function plainNumber(text: string): number | null {
  const t = asciiDigits(text.trim())
  if (!PLAIN.test(t)) return null
  const n = Number(t.replace(/,/g, '').replace('−', '-'))
  return Number.isFinite(n) ? n : null
}

/** A value of a query as a number, for a chart: a number, or text holding one ("12", "1,204", "1.29%" read as 1.29). */
export function cellNumber(v: AiCell | unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v !== 'string') return null
  const t = v.trim()
  return plainNumber(t.endsWith('%') || t.endsWith('٪') ? t.slice(0, -1) : t)
}

/** Per column of text cells: whether it holds figures — at least one, and nothing else but blanks. */
export function numericTextColumns(width: number, rows: readonly (readonly string[])[]): boolean[] {
  return Array.from({ length: width }, (_, c) => {
    let figures = 0
    for (const r of rows) {
      const text = (r[c] ?? '').trim()
      if (isBlankText(text)) continue
      if (!looksNumeric(text)) return false
      figures++
    }
    return figures > 0
  })
}

/** Per column of a query's rows: whether it holds figures — numbers (or text that is one), and NULLs. */
export function numericColumns(columns: readonly string[], rows: readonly (readonly AiCell[])[]): boolean[] {
  return columns.map((_, c) => {
    let figures = 0
    for (const r of rows) {
      const v = r[c]
      if (v === null || v === undefined) continue
      if (typeof v === 'number') {
        figures++
        continue
      }
      if (typeof v !== 'string') return false
      if (isBlankText(v)) continue
      if (!looksNumeric(v)) return false
      figures++
    }
    return figures > 0
  })
}

// ---- Direction -------------------------------------------------------------------------

/** Letters that set a text right to left: Hebrew, Arabic and their presentation forms — not the Arabic digits, which are weak. */
const RTL_CHAR = /[֐-׿؀-ٟ٭-ۯۺ-ࣿיִ-﷿ﹰ-ﻼ]/
/** Letters that set it left to right: Latin, Greek, Cyrillic. */
const LTR_CHAR = /[A-Za-zÀ-ɏͰ-ϿЀ-ӿ]/

/** Which way a text reads, by its first strong letter (as dir="auto" decides); null when it has none. */
export function textDirection(text: string): 'rtl' | 'ltr' | null {
  for (const ch of text) {
    if (RTL_CHAR.test(ch)) return 'rtl'
    if (LTR_CHAR.test(ch)) return 'ltr'
  }
  return null
}

/** Which way most of a text's letters read; null when it has none. */
export function letterDirection(text: string): 'rtl' | 'ltr' | null {
  let rtl = 0
  let ltr = 0
  for (const ch of text) {
    if (RTL_CHAR.test(ch)) rtl++
    else if (LTR_CHAR.test(ch)) ltr++
  }
  return rtl === 0 && ltr === 0 ? null : rtl > ltr ? 'rtl' : 'ltr'
}

/** A markdown text's prose: without its code (a fence still open too, while it streams), link addresses and web addresses. */
function markdownProse(markdown: string): string {
  return markdown
    .replace(/^ {0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:^ {0,3}\1[ \t]*$|(?![\s\S]))/gm, ' ')
    .replace(/`+[^`\n]*`+/g, ' ')
    .replace(/\]\([^)]*\)/g, ']')
    .replace(/<[^<>\s]+>/g, ' ')
    .replace(/\bhttps?:\/\/\S+/gi, ' ')
}

/**
 * Which way an answer's text reads as a whole, set on it once: by most of its
 * letters, not its first — an Arabic answer may well open with a machine's
 * code ("LM4 …") — and never by its code or addresses. Set explicitly
 * because dir="auto" on the text would hear nothing: every paragraph, item
 * and heading in it says its own direction, and dir="auto" passes over
 * them, falling back to left to right. Without a letter, left to right.
 */
export function proseDirection(markdown: string): 'rtl' | 'ltr' {
  return letterDirection(markdownProse(markdown)) ?? 'ltr'
}

/** Which way a block of an answer reads (a list, a quote): by most of the letters in it outside code; null when it has none. */
export function hastDirection(node: HastNode): 'rtl' | 'ltr' | null {
  const out: string[] = []
  const walk = (n: HastNode) => {
    if (n.type === 'text') out.push(n.value ?? '')
    else if (!isEl(n, 'code') && !isEl(n, 'pre')) n.children?.forEach(walk)
  }
  walk(node)
  return letterDirection(out.join(' '))
}

/**
 * Which way a table reads: its header's, else its first cell that says.
 * Decided here and set on the table, because dir="auto" on every cell would
 * hide their words from the table's own dir="auto".
 */
export function tableDirection(header: readonly string[], rows: readonly (readonly string[])[]): 'rtl' | 'ltr' {
  const head = textDirection(header.join(' '))
  if (head) return head
  for (const r of rows) {
    for (const cell of r) {
      const d = textDirection(cell)
      if (d) return d
    }
  }
  return 'ltr'
}

// ---- To the clipboard and to Excel -----------------------------------------------------

/** One field of tab-separated text: quoted, its quotes doubled, when it holds a tab, a line break or a quote. */
function tsvField(text: string): string {
  return /["\t\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

/** A table as tab-separated text, header first: what Excel, Sheets and Word take as a table when pasted. */
export function tableTsv(header: readonly string[], rows: readonly (readonly string[])[]): string {
  return [header, ...rows].map((r) => r.map((c) => tsvField(c)).join('\t')).join('\r\n')
}

/** A query's preview rows as text cells. */
export function queryTextRows(rows: readonly (readonly AiCell[])[], width: number): string[][] {
  return rows.map((r) => Array.from({ length: width }, (_, c) => cellText(r[c])))
}

const excelText = (s: string) => (s.length > EXCEL_CELL_MAX ? s.slice(0, EXCEL_CELL_MAX) : s)

/**
 * A markdown table as a sheet: a plain number in a column of figures goes in
 * as a number ("1,234" as 1234), so Excel can add it up; a figure with a unit
 * or a percent sign stays as it was written.
 */
export function textTableSheet(name: string, header: readonly string[], rows: readonly (readonly string[])[]): SheetSpec {
  const numeric = numericTextColumns(header.length, rows)
  return {
    name,
    header: header.map(excelText),
    rows: rows.map((r) =>
      header.map((_, c): CellValue => {
        const text = (r[c] ?? '').trim()
        if (numeric[c]) {
          const n = plainNumber(text)
          if (n !== null) return n
          if (isBlankText(text)) return null
        }
        return text ? excelText(text) : null
      }),
    ),
  }
}

// ---- Markdown tables, as the renderer holds them ----------------------------------------

/** The little of a HTML syntax tree (hast) a table needs. */
export interface HastNode {
  type: string
  tagName?: string
  value?: string
  properties?: Record<string, unknown>
  children?: HastNode[]
}

const isEl = (n: HastNode, tag?: string) => n.type === 'element' && (tag === undefined || n.tagName === tag)

/** A node's words, one space for a line break, white space folded. */
export function hastText(node: HastNode): string {
  const out: string[] = []
  const walk = (n: HastNode) => {
    if (n.type === 'text') out.push(n.value ?? '')
    else if (isEl(n, 'br')) out.push(' ')
    else n.children?.forEach(walk)
  }
  walk(node)
  return out.join('').replace(/\s+/g, ' ').trim()
}

/** A code block's language as the model named it ("```sql": "sql"); null when it named none, or nothing a language is called. */
export function codeLanguage(pre: HastNode): string | null {
  const code = pre.children?.find((c) => isEl(c, 'code'))
  const names = code?.properties?.className
  for (const name of Array.isArray(names) ? names : typeof names === 'string' ? names.split(/\s+/) : []) {
    const m = /^language-([a-z0-9][\w+#.-]{0,19})$/i.exec(String(name))
    if (m) return m[1]
  }
  return null
}

/** A node's text exactly as written (a code block's lines and indents kept). */
export function hastRawText(node: HastNode): string {
  if (node.type === 'text') return node.value ?? ''
  return (node.children ?? []).map(hastRawText).join('')
}

/** The rows of a table element: each a list of its cells' elements. */
function hastRows(table: HastNode): { head: HastNode[][]; body: HastNode[][] } {
  const head: HastNode[][] = []
  const body: HastNode[][] = []
  const cells = (tr: HastNode) => (tr.children ?? []).filter((c) => isEl(c, 'th') || isEl(c, 'td'))
  for (const section of table.children ?? []) {
    if (isEl(section, 'tr')) body.push(cells(section))
    else if (isEl(section, 'thead') || isEl(section, 'tbody') || isEl(section, 'tfoot')) {
      for (const tr of section.children ?? []) if (isEl(tr, 'tr')) (isEl(section, 'thead') ? head : body).push(cells(tr))
    }
  }
  return { head, body }
}

/** A markdown table as text: its header (the first header row) and its rows, each as wide as the widest. */
export function hastTableData(table: HastNode): { header: string[]; rows: string[][] } {
  const { head, body } = hastRows(table)
  const width = Math.max(head[0]?.length ?? 0, ...body.map((r) => r.length))
  const pad = (r: HastNode[]) => Array.from({ length: width }, (_, c) => (r[c] ? hastText(r[c]) : ''))
  return { header: head[0] ? pad(head[0]) : Array.from({ length: width }, () => ''), rows: body.map(pad) }
}

/** The marks a cell carries through to the renderer: a figure's (data-ai-numeric), and its table's direction (data-ai-dir). */
export const NUMERIC_PROP = 'dataAiNumeric'
export const DIR_PROP = 'dataAiDir'
/** The same marks as attributes, as React hands them to a cell's component. */
export const NUMERIC_ATTR = 'data-ai-numeric'
export const DIR_ATTR = 'data-ai-dir'

/**
 * A rehype step over an answer's markdown: every table learns which way it
 * reads, and every cell learns it too and whether its column holds figures,
 * so the renderer aligns the column as a whole (figures to the end, in
 * left-to-right digits; a column of words keeps any alignment the model
 * gave it). Numbers keep the separators the model wrote; nothing is
 * reformatted.
 */
export function rehypeAiTables() {
  return (tree: HastNode) => {
    const visit = (n: HastNode) => {
      if (isEl(n, 'table')) markTable(n)
      n.children?.forEach(visit)
    }
    visit(tree)
  }
}

function markTable(table: HastNode) {
  const { header, rows } = hastTableData(table)
  const numeric = numericTextColumns(header.length, rows)
  const dir = tableDirection(header, rows)
  table.properties = { ...table.properties, dir }
  const { head, body } = hastRows(table)
  for (const row of [...head, ...body]) {
    row.forEach((cell, c) => {
      if (!numeric[c]) {
        cell.properties = { ...cell.properties, [DIR_PROP]: dir }
        return
      }
      // A column of figures sits at the table's end, whatever side the model's "---:" named (it writes them left to right).
      const { align: _align, ...properties } = cell.properties ?? {}
      cell.properties = { ...properties, [DIR_PROP]: dir, [NUMERIC_PROP]: 'true' }
    })
  }
}
