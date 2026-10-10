// ============================================================================
// §21 — the words automations write: a case's title and body filled from its
// row, an automation's name in an alert or a chat line. A value that runs the
// other way from the words around it — an order number such as
// 20095-QC1-HYH in an Arabic title, an Arabic name in an English line — is
// set apart with Unicode's isolates (U+2068 … U+2069), so it keeps its own
// order wherever the text is shown: the bell, the chat, a follow-up, a card.
// The isolates are invisible; the text reads as typed.
// ============================================================================

import { renderAutomationTemplate } from '@qc/shared/automation'
import type { AiCell } from '@qc/shared/ai'

const FSI = '\u2068'
const PDI = '\u2069'

/** Text set apart from what is around it; blank text stays as it is (an empty value adds nothing). */
export const isolate = (text: string): string => (text.trim() === '' ? text : `${FSI}${text}${PDI}`)

/** Text without its isolates: what the model reads, the values as they are. */
export const withoutIsolates = (text: string): string => text.replace(/[\u2068\u2069]/g, '')

/** A template filled from a case's row, each value set apart: `{{column}}` → the cell, '' for an empty one. */
export function fillCaseTemplate(template: string, columns: readonly string[], row: readonly AiCell[]): string {
  return renderAutomationTemplate(
    template,
    columns,
    row.map((v) => (v === null || v === undefined ? v : isolate(String(v)))),
  )
}
