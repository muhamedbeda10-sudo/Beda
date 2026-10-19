// ============================================================================
// The assistant's two parts in how reports look (shared/src/reportStyles.ts):
//
//   • a style from a sample — pages of a report the person likes, as images —
//     and/or a change put in words: it answers with the style's choices
//     (never code), where the logo sits on the first page, and a note;
//   • where a form's values go: from the form's sheets as the app reads them
//     and the report's sections (their columns) and inputs, it answers with a
//     mapping.
//
// Each is one call on its job's model (AI_JOBS), answered in JSON held to a
// schema, counted with the person's questions; what it answers goes through
// the same checks as anything a person types.
// ============================================================================

import Anthropic from '@anthropic-ai/sdk'
import {
  AI_JOBS,
  type AiJob,
} from '@qc/shared/ai'
import {
  BUILTIN_REPORT_STYLE,
  REPORT_FORM_AGGREGATES,
  REPORT_FORM_FIELDS,
  REPORT_STYLE_BORDERS,
  REPORT_STYLE_COLOR_KEYS,
  REPORT_STYLE_FIGURES,
  REPORT_STYLE_FONTS,
  REPORT_STYLE_LOGO_POSITIONS,
  REPORT_STYLE_LOGO_SIZES,
  REPORT_STYLE_ORIENTATIONS,
  REPORT_STYLE_RULES,
  type ReportFormField,
  type ReportFormMapping,
  type ReportFormSheetPreview,
  type ReportFormValue,
  type ReportStyleDraftResponse,
  type ReportStyleSpec,
} from '@qc/shared/reportStyles'
import type { Db } from '../db/pool'
import { HttpError } from '../lib/errors'
import { recordCutOffUsage, usageOf, watchStream } from '../ai/assistant'
import type { AiModelClient, ModelMessage, ModelParams } from '../ai/model'
import { worstCaseUsd } from '../ai/models'
import { keepUsage } from '../ai/transcript'
import { capPassed, holdUnderCaps, isGranted, personAvailability, releaseHold } from '../ai/access'
import { aiOwner } from '../ai/owner'
import { notGranted, tooClose, unavailable } from '../ai/refusals'
import type { AppContext } from '../context'
import { styleNameSchema, styleSpecSchema } from './styleSchema'

const DRAFT_MAX_TOKENS = 8_000
const DRAFT_TIMEOUT_MS = 120_000

const str = { type: 'string' }
const bool = { type: 'boolean' }
const enumOf = (values: readonly string[]) => ({ type: 'string', enum: [...values] })
const obj = (properties: Record<string, object>) => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false })
const nullable = (schema: object) => ({ anyOf: [schema, { type: 'null' }] })

const SPEC_SCHEMA = obj({
  colors: obj(Object.fromEntries(REPORT_STYLE_COLOR_KEYS.map((k) => [k, { type: 'string', description: '#RRGGBB' }]))),
  font: enumOf(REPORT_STYLE_FONTS),
  orientation: enumOf(REPORT_STYLE_ORIENTATIONS),
  logo: obj({ position: enumOf(REPORT_STYLE_LOGO_POSITIONS), size: enumOf(REPORT_STYLE_LOGO_SIZES) }),
  header: obj({ companyName: str, department: str, showKind: bool, rule: enumOf(REPORT_STYLE_RULES) }),
  docControl: obj({ enabled: bool, docNo: str, revision: str, issueDate: str }),
  table: obj({ borders: enumOf(REPORT_STYLE_BORDERS), stripes: bool, compact: bool }),
  figures: enumOf(REPORT_STYLE_FIGURES),
  numbering: bool,
  footer: obj({ text: str, pageNumbers: bool }),
  approvals: obj({ enabled: bool, labels: { type: 'array', items: str } }),
})

export const STYLE_DRAFT_SCHEMA = obj({
  name: { type: 'string', description: 'A short name for the style, at most 60 characters.' },
  spec: SPEC_SCHEMA,
  logoBox: nullable(obj({ x: { type: 'number' }, y: { type: 'number' }, w: { type: 'number' }, h: { type: 'number' } })),
  notes: { type: 'string', description: 'One or two short sentences for the person.' },
})

export const STYLE_DRAFT_SYSTEM = `You design how a manufacturing company's quality reports look when printed (PDF) and exported (Excel). You never write code: you choose from a fixed set of options, which the app draws.

The input may hold: images of a sample report the person wants their reports to look like; the style as it stands now (JSON); and an instruction in the person's words.

Return a complete style:
- colors: every colour as #RRGGBB. primary is the letterhead's main colour (its rule, section numbers, figure accents); accent is the rule's second colour; heading for titles; text for body text; tableHeaderBg and tableHeaderText for a table's header row (keep strong contrast between them); tableStripe for every other row (very light); tableBorder for lines (light grey or a tint of primary).
- font: one of the listed typefaces, the closest to the sample's.
- orientation: portrait unless the sample is landscape.
- logo: where the sample's logo sits (left, right, center) and how large it looks (small, medium, large).
- header: companyName and department as the sample writes them (empty when it has none), showKind (whether to print the kind of report, e.g. "Scheduled report", under the department), rule: the line under the letterhead (double: two colours; single; none).
- docControl: enabled when the sample has a document control box (Doc. No., Rev., Issue date, a form number like QF-07); copy its docNo, revision and issueDate as written; otherwise disabled with empty values.
- table: borders (all: a grid; rows: lines between rows; none), stripes, compact (tight rows).
- figures: how headline figures look: cards, boxed, or plain.
- numbering: whether sections are numbered.
- footer: text at the foot of every page (often the company and department, or a confidentiality line), and pageNumbers.
- approvals: enabled when the sample has signature boxes; labels as written (at most 4, e.g. Prepared by, Reviewed by, Approved by).
Without a sample, change only what the instruction asks and keep every other choice as it stands. With a sample and a current style, take the sample's look and keep the current values the sample does not show.
logoBox: where the logo is on the first image, as fractions of the image's width and height (x and y its top left corner, w and h its size, each between 0 and 1), tight around the logo; null when there is no image or no logo.
notes: what you carried over and anything you could not (a typeface not available, a layout the options do not have), in one or two short sentences in the language of the instruction (English when there is none).`

export const FORM_MAP_SCHEMA = obj({
  mapping: obj({
    sheet: str,
    cells: {
      type: 'array',
      items: obj({
        ref: { type: 'string', description: 'A1 reference of the cell that takes the value.' },
        kind: enumOf(['field', 'input', 'section', 'text']),
        field: nullable(enumOf(REPORT_FORM_FIELDS)),
        input: nullable(str),
        section: nullable({ type: 'integer' }),
        column: nullable(str),
        aggregate: nullable(enumOf(REPORT_FORM_AGGREGATES)),
        text: nullable(str),
      }),
    },
    tables: {
      type: 'array',
      items: obj({
        section: { type: 'integer' },
        startRow: { type: 'integer' },
        lastRow: nullable({ type: 'integer' }),
        overflow: enumOf(['insert', 'next-sheet']),
        columns: { type: 'array', items: obj({ col: str, column: str }) },
      }),
    },
  }),
  notes: str,
})

export const FORM_MAP_SYSTEM = `You fill a company's Excel form from a saved report of its quality-control system. The input is JSON: the form's sheets as read (each with the cells that hold text near the top, A1 references, bold and fill, and merged ranges), the report's sections (index, title, the columns its rows have, and how it shows them), its inputs (name, label), and the report's own fields.

Return where each value goes:
- sheet: the sheet to fill (the form's main sheet).
- cells: single cells that take one value, usually the empty cell right of (or under) a label: "Date:" takes ran.day or period.label, "Order No." an input or a section's first value, "Doc. No." doc.no, "Rev." doc.revision. kind field uses field (one of the listed fields); kind input uses input (an input's name); kind section uses section (index), column (exactly as listed) and aggregate (first for a value of the first row, sum/count/average/min/max over every row: a "Total" cell under a table column is a sum); kind text writes text as given. Leave the other properties null. Never fill a label's own cell, and never a cell inside a table's rows.
- tables: each table of the form that takes a section's rows: section (index), startRow (the first empty row under the table's header row, 1-based), columns (each form column letter under a header and the section's column that matches it; leave out header columns nothing matches, such as a running number), overflow: insert when something sits under the table's rows (totals, signatures) or the table has a single empty row; next-sheet with lastRow (the last row of the table's printed grid) when the form has a fixed number of ruled rows and a fixed page.
Match by meaning, in English or Arabic (Machine = الماكينة, Date = التاريخ, Inspector = المفتش, Qty = الكمية…). Only use the sections and columns listed. Put nothing you are not reasonably sure of.
notes: one or two short sentences for the person: what you matched, and what was left for them to set.`

/** The request for one of the two calls, on its job's model and effort: built first, so its worst case is judged against the caps before it is sent. */
export function structuredParams(args: { job: AiJob; system: string; schema: object; content: Anthropic.Beta.BetaContentBlockParam[] }): ModelParams {
  const run = AI_JOBS[args.job]
  return {
    model: run.model,
    max_tokens: DRAFT_MAX_TOKENS,
    thinking: { type: 'adaptive' },
    output_config: { effort: run.effort, format: { type: 'json_schema', schema: args.schema } },
    system: [{ type: 'text', text: args.system }],
    messages: [{ role: 'user', content: args.content }],
  } as ModelParams
}

/** The most tokens one picture is read as, whatever its size: the model scales a larger one down. */
const IMAGE_MAX_TOKENS = 5_000

/**
 * A call's worst case: its text as worstCaseUsd judges it, and each picture
 * at the most a picture is read as (its base64 is not text: counted as text,
 * a page would look a hundred times dearer than it is).
 */
export function structuredWorstCaseUsd(params: ModelParams): number {
  const messages = params.messages.map((m) =>
    typeof m.content === 'string'
      ? m
      : { ...m, content: m.content.map((b) => (b.type === 'image' ? { type: 'text' as const, text: 'x'.repeat(IMAGE_MAX_TOKENS * 3) } : b)) },
  ) as ModelParams['messages']
  return worstCaseUsd({ ...params, messages })
}

/**
 * One call, its answer read as JSON; counted with the person's questions, as far as it got when it fails, settling
 * the hold it was made under (`holdId`, callForPerson). A failure is a 502 the person can retry.
 */
export async function structuredCall(args: {
  db: Db
  model: AiModelClient
  apiKey: string
  userId: string
  params: ModelParams
  what: string
  holdId?: string | null
}): Promise<unknown> {
  const params = args.params
  const owner = { userId: args.userId, conversationId: null, turnId: null }
  // Let go when the call ends with no cost kept under it; null once its cost is kept, or could not be (it then lapses).
  let holdId = args.holdId ?? null
  let message: ModelMessage
  let requestId: string | null = null
  try {
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), DRAFT_TIMEOUT_MS)
    timer.unref()
    const stream = args.model.stream(args.apiKey, params, { signal: ac.signal })
    const watch = watchStream(stream)
    try {
      message = await stream.finalMessage()
    } catch (e) {
      // A stream that failed on its own may still be reading the response, which would go uncounted: stop it.
      if (!(e instanceof Anthropic.APIUserAbortError)) stream.abort()
      if ((await recordCutOffUsage(args.db, { ...owner, holdId }, stream, watch, params)) === 'lost') holdId = null
      console.warn(`[report-styles] ${args.what}: no answer from the assistant:`, e instanceof Error ? e.message : String(e))
      throw new HttpError(502, 'ai_unavailable', `${args.what} did not work: the assistant did not answer. Try again in a moment.`)
    } finally {
      clearTimeout(timer)
    }
    requestId = stream.request_id ?? null
    const usage = usageOf(message, params.model)
    await keepUsage(args.db, { ...owner, model: usage.model, tokens: usage.tokens, costUsd: usage.costUsd, requestId, holdId })
    holdId = null
  } finally {
    await releaseHold(args.db, holdId).catch((e: unknown) => console.warn("[report-styles] a call's hold could not be let go; it lapses on its own:", e instanceof Error ? e.message : String(e)))
  }
  const text = message.content
    .filter((b): b is Extract<typeof b, { type: 'text' }> => b.type === 'text')
    .map((b) => b.text)
    .join('')
  try {
    return JSON.parse(text)
  } catch {
    throw new HttpError(502, 'ai_unavailable', `${args.what} did not work: the assistant's answer could not be read. Try again.`)
  }
}

/**
 * A call made for the person, after the checks every call to Claude passes:
 * given the assistant, the assistant able to answer, the call's worst case
 * within both caps — counting the calls under way, one check at a time — the
 * person's rate. Then the call, its worst case held against both caps while
 * it is under way (access.ts, holdUnderCaps), counted with their questions.
 */
export async function callForPerson(ctx: AppContext, userId: string, params: ModelParams, what: string): Promise<unknown> {
  const avail = await personAvailability(ctx.db, ctx.config, ctx.aiReader.ready, userId, await aiOwner(ctx.db, ctx.config))
  if (!isGranted(avail.access)) throw notGranted()
  if (!avail.me.available || !avail.app.apiKey) throw unavailable(avail)
  const access = avail.access
  const worst = structuredWorstCaseUsd(params)
  const held = await holdUnderCaps(ctx.db, userId, worst, (tx) => capPassed(tx, userId, worst, { appUsd: avail.app.status.capUsd, personalUsd: access.monthlyCapUsd }))
  if ('refused' in held) throw tooClose(held.refused, what, avail.me.owner)
  const wait = ctx.aiLimiter.hit(userId)
  if (wait > 0) {
    await releaseHold(ctx.db, held.holdId)
    throw new HttpError(429, 'rate_limited', `Too many requests to Claude in a short time. Try again in ${wait} seconds.`)
  }
  return structuredCall({ db: ctx.db, model: ctx.ai, apiKey: avail.app.apiKey, userId, params, what, holdId: held.holdId })
}

/** An image the person sent, as the model reads it. */
export function imageBlock(dataUrl: string): Anthropic.Beta.BetaImageBlockParam {
  const m = /^data:(image\/(?:png|jpeg));base64,([A-Za-z0-9+/]+={0,2})$/.exec(dataUrl)
  if (!m) throw new HttpError(400, 'validation', 'A sample page must be a PNG or JPEG picture.')
  return { type: 'image', source: { type: 'base64', media_type: m[1] as 'image/png' | 'image/jpeg', data: m[2] } }
}

const clamp01 = (n: number) => Math.min(1, Math.max(0, n))

/** The assistant's style, checked: a choice it got wrong takes the style as it stood (or the built-in's). */
export function readStyleDraft(raw: unknown, current: ReportStyleSpec | undefined): ReportStyleDraftResponse {
  const r = (raw ?? {}) as { name?: unknown; spec?: unknown; logoBox?: unknown; notes?: unknown }
  const base = current ?? BUILTIN_REPORT_STYLE
  const spec = styleSpecSchema.safeParse(r.spec)
  let chosen: ReportStyleSpec = base
  let notes = typeof r.notes === 'string' ? r.notes.slice(0, 600) : ''
  if (spec.success) chosen = spec.data
  else {
    // Choice by choice: what reads is kept, what does not keeps the current value.
    const merged = { ...base, ...(typeof r.spec === 'object' && r.spec ? (r.spec as object) : {}) } as Record<string, unknown>
    const again = styleSpecSchema.safeParse(
      Object.fromEntries(
        Object.entries(base).map(([k, v]) => {
          const one = styleSpecSchema.safeParse({ ...base, [k]: merged[k] })
          return [k, one.success ? merged[k] : v]
        }),
      ),
    )
    chosen = again.success ? again.data : base
    notes = [notes, 'Some choices could not be read and were kept as they were.'].filter(Boolean).join(' ')
  }
  const name = styleNameSchema.safeParse(typeof r.name === 'string' ? r.name.slice(0, 80) : '')
  const box = r.logoBox as { x?: unknown; y?: unknown; w?: unknown; h?: unknown } | null
  const logoBox =
    box && [box.x, box.y, box.w, box.h].every((n) => typeof n === 'number' && Number.isFinite(n))
      ? { x: clamp01(box.x as number), y: clamp01(box.y as number), w: clamp01(box.w as number), h: clamp01(box.h as number) }
      : null
  return { spec: chosen, name: name.success ? name.data : 'New style', logoBox: logoBox && logoBox.w > 0.01 && logoBox.h > 0.01 ? logoBox : null, notes }
}

/** What the form-mapping call is told. */
export function formMapInput(args: {
  sheets: ReportFormSheetPreview[]
  sections: { title: string; columns: string[]; display: string }[]
  inputs: { name: string; label: string }[]
}): string {
  return JSON.stringify(
    {
      sheets: args.sheets.map((s) => ({ name: s.name, rows: s.rowCount, columns: s.columnCount, cells: s.cells, merges: s.merges })),
      sections: args.sections.map((s, index) => ({ index, ...s })),
      inputs: args.inputs,
      fields: REPORT_FORM_FIELDS,
    },
    null,
    1,
  )
}

/** The assistant's mapping, in the app's terms: entries that do not read are left out (the checks after say what else is wrong). */
export function readFormMapping(raw: unknown, sheets: ReportFormSheetPreview[]): { mapping: ReportFormMapping; notes: string } {
  const r = (raw ?? {}) as { mapping?: { sheet?: unknown; cells?: unknown; tables?: unknown }; notes?: unknown }
  const m = r.mapping ?? {}
  const sheet = typeof m.sheet === 'string' && sheets.some((s) => s.name === m.sheet) ? m.sheet : (sheets[0]?.name ?? '')
  const cells: ReportFormMapping['cells'] = []
  for (const c of Array.isArray(m.cells) ? (m.cells as Record<string, unknown>[]) : []) {
    if (typeof c.ref !== 'string') continue
    let value: ReportFormValue | null = null
    if (c.kind === 'field' && typeof c.field === 'string' && (REPORT_FORM_FIELDS as readonly string[]).includes(c.field)) value = { kind: 'field', field: c.field as ReportFormField }
    else if (c.kind === 'input' && typeof c.input === 'string') value = { kind: 'input', name: c.input }
    else if (c.kind === 'section' && Number.isInteger(c.section) && typeof c.column === 'string')
      value = { kind: 'section', section: c.section as number, column: c.column, aggregate: (REPORT_FORM_AGGREGATES as readonly string[]).includes(c.aggregate as string) ? (c.aggregate as 'first') : 'first' }
    else if (c.kind === 'text' && typeof c.text === 'string') value = { kind: 'text', text: c.text.slice(0, 500) }
    if (value) cells.push({ ref: c.ref.trim().toUpperCase(), value })
  }
  const tables: ReportFormMapping['tables'] = []
  for (const t of Array.isArray(m.tables) ? (m.tables as Record<string, unknown>[]) : []) {
    if (!Number.isInteger(t.section) || !Number.isInteger(t.startRow) || !Array.isArray(t.columns)) continue
    const columns = (t.columns as Record<string, unknown>[])
      .filter((c) => typeof c.col === 'string' && typeof c.column === 'string')
      .map((c) => ({ col: (c.col as string).trim().toUpperCase(), column: c.column as string }))
    const overflow = t.overflow === 'next-sheet' && Number.isInteger(t.lastRow) ? 'next-sheet' : 'insert'
    tables.push({ section: t.section as number, startRow: t.startRow as number, ...(overflow === 'next-sheet' ? { lastRow: t.lastRow as number } : {}), overflow, columns })
  }
  return { mapping: { sheet, cells, tables }, notes: typeof r.notes === 'string' ? r.notes.slice(0, 600) : '' }
}
