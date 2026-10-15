// ============================================================================
// MTC — what Claude is asked to read from a supplier's certificate, and how
// its reply becomes the review's rows.
//
//   • One call per certificate, the PDF itself as a document block: Claude
//     reads its text and its pages as images, so a scanned or rotated
//     certificate is read too (the review marks what it was unsure of).
//   • Claude first tells which register the certificate belongs to — steel
//     coils, welding wire, mesh wire — then lists its items with that
//     register's fields and nothing more, plus the certificate's number (which
//     becomes the notes), the page of each row and the fields it was unsure of.
//     The reply is held to a JSON schema built from the registers' own
//     descriptions (structured outputs).
//   • The rules the factory chose are in the instructions, not left to the
//     model's taste: a coil number with a part number is joined ("213417-506"),
//     a galvanised grade keeps its coating ("S450GD+Z275"), the SM type is HR
//     or GI, suppliers are named by their short name, the notes are
//     "MTC <number>", a welding wire's strengths are the deposited metal's test
//     results, never the requirement.
//   • What comes back is checked and cleaned here again, field by field: the
//     schema says what may come, not that it is sensible.
// ============================================================================

import type Anthropic from '@anthropic-ai/sdk'
import { z } from 'zod'
import type { AiEffort } from '@qc/shared/ai'
import {
  MTC_KINDS,
  MTC_REGISTERS,
  MTC_SM_TYPES,
  MTC_SUPPLIERS,
  cleanMtcNumber,
  cleanMtcText,
  mtcKeyOf,
  type MtcExtractResult,
  type MtcExtractedRow,
  type MtcField,
  type MtcKind,
  type MtcRegister,
  type MtcValues,
} from '@qc/shared/mtc'
import type { ModelMessage, ModelParams } from '../ai/model'

/** Room for adaptive thinking and a long list: a hundred coils take about 8,000 tokens. */
export const MTC_MAX_TOKENS = 48_000
/** What the instructions and the schema add to the counted document, rounded up: for the cap's worst case. */
export const MTC_PROMPT_TOKENS = 6_000
const STRUCTURED_OUTPUTS_BETA: Anthropic.Beta.AnthropicBeta = 'structured-outputs-2025-11-13'

/** The reply's list for each register. */
const LIST: Record<MtcKind, string> = { coils: 'coils', 'welding-wire': 'weldingWires', 'mesh-wire': 'meshWires' }

export const MTC_SYSTEM = [
  'You read mill test certificates (MTC; inspection certificates to EN 10204 3.1 or 3.2, analysis certificates) of materials received by a steel fabrication factory, and list every item in them for the factory’s material registers.',
  'People will check your list against the paper before it is saved, so mark every value you are not sure of rather than guessing silently.',
  '',
  'First decide what the document certifies (documentKind):',
  '- "coils": steel coils (strip or sheet in coils, hot-rolled, pickled, galvanised…). List them in coils.',
  '- "welding-wire": welding wire or another welding consumable sold by batch (solid wire, flux-cored wire). List them in weldingWires.',
  '- "mesh-wire": steel wire for mesh (galvanised or bright drawn wire, wire rod for mesh). List them in meshWires.',
  '- "other": anything else (pipes, an invoice, a letter): list nothing and say in problem what the document is.',
  'Leave the two other lists empty.',
  '',
  'For every list:',
  '- Read every page. A file may hold one certificate or many (often one per page); list the items of all of them.',
  '- One entry per item. Skip totals, sums, blank rows, repeated headers, and the specification’s required values (minimums, maximums): only the results of the items.',
  '- certificateNumber: the number of the certificate the item is listed in, as printed ("Certificate No.", "Certificato", "A03"); when pages carry different numbers, each item takes its own page’s; null when the document shows none.',
  '- page: the page of the PDF its row is on, counting from 1.',
  '- uncertain: the fields you could not read with full confidence (blurred, rotated or small print, a stamp over it, a column you had to guess) or that you converted. A value you cannot read at all is null, and marked uncertain.',
  '- supplier: the company that made the material, by its short name in Latin letters, never the customer, consignee, purchaser or a trader. For steel mills use exactly one of ' +
    MTC_SUPPLIERS.map((s) => `"${s}"`).join(', ') +
    ' when it is one of them (Baosteel includes Shanghai Meishan Iron & Steel; Ezz includes Al Ezz Dekheila Steel and Ezz Steel; Tosyali includes Tosyali Toyo Çelik). Any other maker: its shortest recognisable name ("POSCO", "Shiqiao" for Shijiazhuang Shiqiao Electric Welding Material, "TSG" for Trafilerie di San Giovanni).',
  '- Read numbers exactly as printed, without rounding; a decimal comma is a decimal point. Where a table scales its values (a header such as "×1000"), that applies to the chemistry only.',
  '- Measurements in millimetres and MPa (N/mm² is the same). Convert inches (× 25.4) and ksi (× 6.895), and mark the field uncertain.',
  '',
  'coils — for each steel coil:',
  '- coilNumber: the coil (or coil/pack) number exactly as printed, with its dashes, letters and leading zeros. Never the heat or cast number, the row’s serial number, or the certificate number. When the certificate identifies each coil by a coil number plus a separate part or sub-coil number (ArcelorMittal’s COILNO 213417 with PART 506, say), join them with a hyphen: "213417-506".',
  '- grade: the steel grade, upper case, without spaces ("S420 MC" is "S420MC"), without the standard’s number. For metallic-coated (galvanised) steel, the grade with its coating designation and coating mass but without surface finish or treatment suffixes: "S450GD+Z275-M-A-CO" is "S450GD+Z275". When the grade reads "S550GD+Z" and the coating mass (275 g/m², say) is given in a column or field of its own, add it: "S550GD+Z275".',
  `- smType: "${MTC_SM_TYPES[1]}" for galvanised, zinc-coated or hot-dip coated coils (+Z, +ZF, +AZ, DX51D…, S…GD grades); "${MTC_SM_TYPES[0]}" for hot-rolled black coils, pickled and oiled included. Null for anything else (cold-rolled uncoated, say), marked uncertain.`,
  '- thickness and width: the nominal dimensions of that coil. When the table has no such columns but the page’s header gives them for all its coils, use the header’s.',
  '- yield: the yield strength (ReH, ReL, Rp0.2, Re, YS, YP). When a coil has several yield results (head and tail, several tests), give the lowest. Never the tensile strength (Rm, TS).',
  '',
  'weldingWires — for each batch of welding wire:',
  '- batchNumber: the batch (lot) number exactly as printed. When one field holds both an invoice number and the batch number ("INVOICE NO. / BATCH NO.: SQY210520-11 22285"), the batch is its own number ("22285").',
  '- classification: the wire’s classification without the standard’s name, upper case, without spaces: "AWS A5.20 E71T-1C" is "E71T-1C"; "ER70S-6"; for a trade name with no classification, null and uncertain.',
  '- wireType: "Flux-cored" for flux-cored (tubular, 药芯) wire, "Solid" for solid wire; null for anything else, marked uncertain.',
  '- diameter: the wire’s diameter or size (Φ1.2 is 1.2).',
  '- weightKg: the weight of the batch delivered, in kilograms (tonnes × 1000).',
  '- yield and tensile: the deposited metal’s (or all-weld metal’s) test results, never the required values ("≥400" is a requirement; "485" in the test-result row is the result).',
  '',
  'meshWires — for each wire line (a cast drawn to one diameter):',
  '- castNumber: the cast or heat number ("Colata N.", "Cast No.", "No. de coulée") exactly as printed.',
  '- diameter: the wire’s diameter.',
  '- product: "Galvanized" for galvanised or zinc-coated wire, "Bright" for bright, black or uncoated drawn wire; null for anything else, marked uncertain.',
  '- grade: the steel grade, upper case, without spaces ("FE 360 B" is "FE360B").',
  '- tensile: the tensile strength (Rm) result.',
  '',
  'problem: null, or one short sentence for the person when something kept you from reading part of the document (pages unreadable, cut off).',
].join('\n')

const nullable = (schema: object) => ({ anyOf: [schema, { type: 'null' }] })

/** The fields Claude returns for one register: its own (the notes come from the certificate's number), then the reading's own. */
function itemSchema(register: MtcRegister) {
  const fields = register.fields.filter((f) => f.key !== 'notes')
  const properties: Record<string, object> = {}
  for (const f of fields) {
    if (f.type === 'number') properties[f.key] = nullable({ type: 'number' })
    else if (f.choices) properties[f.key] = nullable({ type: 'string', enum: [...f.choices] })
    else if (f.key === mtcIdFieldKey(register)) properties[f.key] = { type: 'string' }
    else properties[f.key] = nullable({ type: 'string' })
  }
  properties.certificateNumber = nullable({ type: 'string' })
  properties.page = { type: 'integer' }
  properties.uncertain = { type: 'array', items: { type: 'string', enum: [...fields.map((f) => f.key), 'certificateNumber'] } }
  return { type: 'object', additionalProperties: false, required: Object.keys(properties), properties }
}
const mtcIdFieldKey = (register: MtcRegister) => register.fields[0].key

/** What a reply must look like: which register, then a list for each (all but one empty). */
export const MTC_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['documentKind', 'problem', ...MTC_KINDS.map((k) => LIST[k])],
  properties: {
    documentKind: { type: 'string', enum: [...MTC_KINDS, 'other'] },
    problem: nullable({ type: 'string' }),
    ...Object.fromEntries(MTC_KINDS.map((k) => [LIST[k], { type: 'array', items: itemSchema(MTC_REGISTERS[k]) }])),
  },
}

/** The PDF and what to do with it: the one user message, the same for counting and for reading. */
export function mtcMessages(pdf: Buffer, fileName: string): Anthropic.Beta.BetaMessageParam[] {
  const title = fileName.replace(/[\s]+/g, ' ').trim().slice(0, 255) || 'certificate.pdf'
  return [
    {
      role: 'user',
      content: [
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdf.toString('base64') }, title },
        { type: 'text', text: 'Tell what this certificate certifies and list every item in it for the register.' },
      ],
    },
  ]
}

/** The whole request, on the model and effort the owner set for certificates (Models). Thinking is shown to nobody, so it is not sent back. */
export function mtcRequest(pdf: Buffer, fileName: string, run: { model: string; effort: AiEffort }): ModelParams {
  return {
    model: run.model,
    max_tokens: MTC_MAX_TOKENS,
    betas: [STRUCTURED_OUTPUTS_BETA],
    system: MTC_SYSTEM,
    thinking: { type: 'adaptive', display: 'omitted' },
    output_config: { effort: run.effort, format: { type: 'json_schema', schema: MTC_OUTPUT_SCHEMA as unknown as Record<string, unknown> } },
    messages: mtcMessages(pdf, fileName),
  }
}

/** A reply that could not be turned into rows: the person is told why, in words. */
export class MtcReadError extends Error {
  constructor(
    message: string,
    /** The list ran past the reply's room: a stronger model would run past it too. */
    readonly tooLong = false,
  ) {
    super(message)
    this.name = 'MtcReadError'
  }
}

const itemShape = z.record(z.unknown())
const replySchema = z.object({
  documentKind: z.enum([...MTC_KINDS, 'other']),
  problem: z.string().nullable(),
  coils: z.array(itemShape),
  weldingWires: z.array(itemShape),
  meshWires: z.array(itemShape),
})

/** The steel mills' names as the coil register spells them, whatever case the reply used. */
const SUPPLIER_SPELLING = new Map<string, string>(MTC_SUPPLIERS.map((s) => [s.toLowerCase(), s]))

/** One field of the reply, as the register keeps it. */
function cleanField(field: MtcField, v: unknown): string | number | undefined {
  if (field.type === 'number') return cleanMtcNumber(v)
  let t = cleanMtcText(v)
  if (t === undefined) return undefined
  if (field.compact) t = t.replace(/\s+/g, '').toUpperCase()
  if (field.choices) return field.choices.find((c) => c.toLowerCase() === t!.toLowerCase())
  if (field.key === 'supplier') t = SUPPLIER_SPELLING.get(t.toLowerCase()) ?? t
  return field.max !== undefined ? t.slice(0, field.max) : t
}

/**
 * The review's rows from Claude's reply: the register it named, each field
 * cleaned as that register keeps it, the certificate's number as the notes
 * ("MTC 067711"), one row per key (an item listed twice keeps its first row,
 * with the fields only the second had). Throws MtcReadError when the reply is
 * unusable.
 */
export function readMtcReply(message: ModelMessage, fileName: string): MtcExtractResult {
  if (message.stop_reason === 'refusal') throw new MtcReadError('Claude would not read this document. Check that it is a material certificate.')
  if (message.stop_reason === 'max_tokens') {
    throw new MtcReadError('This certificate lists too many items to read in one go. Split the PDF into parts and upload them one by one.', true)
  }
  const text = message.content
    .filter((b): b is Extract<(typeof message.content)[number], { type: 'text' }> => b.type === 'text')
    .map((b) => b.text)
    .join('')
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    throw new MtcReadError('Claude’s reading of this certificate came back incomplete. Try again.')
  }
  const parsed = replySchema.safeParse(json)
  if (!parsed.success) throw new MtcReadError('Claude’s reading of this certificate came back incomplete. Try again.')
  const reply = parsed.data
  const problem = cleanMtcText(reply.problem)?.slice(0, 500)

  if (reply.documentKind === 'other') {
    const result: MtcExtractResult = { fileName, kind: null, rows: [] }
    if (problem) result.problem = problem
    return result
  }
  const kind = reply.documentKind
  const register = MTC_REGISTERS[kind]
  const items = reply[LIST[kind] as 'coils' | 'weldingWires' | 'meshWires']
  const notesMax = register.fields.find((f) => f.key === 'notes')?.max ?? 1000

  const byKey = new Map<string, MtcExtractedRow>()
  const unkeyed: MtcExtractedRow[] = []
  for (const item of items) {
    const values: MtcValues = {}
    for (const f of register.fields) {
      if (f.key === 'notes') continue
      const v = cleanField(f, item[f.key])
      if (v !== undefined) values[f.key] = v
    }
    const certificate = cleanMtcText(item.certificateNumber)
    if (certificate) values.notes = `MTC ${certificate}`.slice(0, notesMax)
    // An item with no identifier at all is no item: a stray row.
    if (values[register.fields[0].key] === undefined) continue

    const said = new Set(Array.isArray(item.uncertain) ? item.uncertain.map((u) => (u === 'certificateNumber' ? 'notes' : String(u))) : [])
    // A value that came back empty, or was thrown out here, is one to look at (a certificate with no number is no doubt).
    const missing = (v: MtcValues, f: MtcField) => f.key !== 'notes' && v[f.key] === undefined
    const uncertain = register.fields.filter((f) => said.has(f.key) || missing(values, f)).map((f) => f.key)
    const page = typeof item.page === 'number' && Number.isInteger(item.page) && item.page >= 1 ? item.page : undefined
    const row: MtcExtractedRow = { values, uncertain, ...(page ? { page } : {}) }

    const key = mtcKeyOf(register, values)
    if (!key) {
      // A key field could not be read (a mesh wire's diameter, say): kept for the person to complete.
      unkeyed.push(row)
      continue
    }
    const first = byKey.get(key)
    if (!first) {
      byKey.set(key, row)
      continue
    }
    for (const f of register.fields) {
      if (first.values[f.key] === undefined && values[f.key] !== undefined) first.values[f.key] = values[f.key]
    }
    first.uncertain = register.fields
      .filter((f) => missing(first.values, f) || (first.uncertain.includes(f.key) && uncertain.includes(f.key)))
      .map((f) => f.key)
  }

  const result: MtcExtractResult = { fileName, kind, rows: [...byKey.values(), ...unkeyed] }
  if (problem) result.problem = problem
  return result
}
