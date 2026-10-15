// ============================================================================
// MTC — what Claude is asked to read from a mill test certificate, and how
// its reply becomes the review's rows.
//
//   • One call per certificate, the PDF itself as a document block: Claude
//     reads its text and its pages as images, so a scanned or rotated
//     certificate is read too (the review marks what it was unsure of).
//   • The reply is held to a JSON schema (structured outputs): the register's
//     fields and nothing more, plus the certificate's number (which becomes
//     the notes), the page of each row and the fields Claude was unsure of.
//   • The rules the factory chose are in the instructions, not left to the
//     model's taste: a coil number with a part number is joined ("213417-506"),
//     a galvanised grade keeps its coating ("S450GD+Z275"), the SM type is HR
//     or GI, a mill is named by its short name, the notes are "MTC <number>".
//   • What comes back is checked and cleaned here again, field by field: the
//     schema says what may come, not that it is sensible.
// ============================================================================

import type Anthropic from '@anthropic-ai/sdk'
import { z } from 'zod'
import {
  MTC_COIL_FIELDS,
  MTC_MODEL,
  MTC_SM_TYPES,
  MTC_SUPPLIERS,
  MTC_TEXT_MAX,
  cleanMtcNumber,
  cleanMtcText,
  type MtcCoilField,
  type MtcExtractResult,
  type MtcExtractedCoil,
} from '@qc/shared/mtc'
import type { ModelMessage, ModelParams } from '../ai/model'

/** Room for adaptive thinking and a long list: a hundred coils take about 8,000 tokens. */
export const MTC_MAX_TOKENS = 48_000
/** What the instructions and the schema add to the counted document, rounded up: for the cap's worst case. */
export const MTC_PROMPT_TOKENS = 4_000
const STRUCTURED_OUTPUTS_BETA: Anthropic.Beta.AnthropicBeta = 'structured-outputs-2025-11-13'

export const MTC_SYSTEM = [
  'You read mill test certificates (MTC; inspection certificates to EN 10204 3.1 or 3.2) of steel coils received by a steel fabrication factory, and list every coil in them for the factory’s coil register.',
  'People will check your list against the paper before it is saved, so mark every value you are not sure of rather than guessing silently.',
  '',
  'Which coils:',
  '- Read every page. A file may hold one certificate or many (often one per page); list the coils of all of them.',
  '- One entry per physical coil. Skip totals, sums, blank rows and repeated headers. When one coil appears in more than one table (a chemical table and a tensile table, say), list it once with the values of both.',
  '',
  'The fields, for each coil:',
  '- coilNumber: the coil (or coil/pack) number exactly as printed, with its dashes, letters and leading zeros. Never the heat or cast number, the row’s serial number, or the certificate number. When the certificate identifies each coil by a coil number plus a separate part or sub-coil number (ArcelorMittal’s COILNO 213417 with PART 506, say), join them with a hyphen: "213417-506".',
  '- grade: the steel grade, upper case, without spaces ("S420 MC" is "S420MC"), without the standard’s number. For metallic-coated (galvanised) steel, the grade with its coating designation and coating mass but without surface finish or treatment suffixes: "S450GD+Z275-M-A-CO" is "S450GD+Z275". When the grade reads "S550GD+Z" and the coating mass (275 g/m², say) is given in a column or field of its own, add it: "S550GD+Z275".',
  `- smType: "${MTC_SM_TYPES[1]}" for galvanised, zinc-coated or hot-dip coated coils (+Z, +ZF, +AZ, DX51D…, S…GD grades); "${MTC_SM_TYPES[0]}" for hot-rolled black coils, pickled and oiled included. Null for anything else (cold-rolled uncoated, say), marked uncertain.`,
  `- supplier: the mill that made the steel, by its short name. Exactly one of ${MTC_SUPPLIERS.map((s) => `"${s}"`).join(', ')} when it is one of them (Baosteel includes Shanghai Meishan Iron & Steel; Ezz includes Al Ezz Dekheila Steel and Ezz Steel; Tosyali includes Tosyali Toyo Çelik). Any other mill: its shortest recognisable name in Latin letters ("POSCO", "JSW"). Never the customer, consignee, purchaser or a trader.`,
  '- thickness and width: in millimetres, the nominal dimensions of that coil. When the table has no such columns but the page’s header gives them for all its coils, use the header’s. Convert inches (× 25.4) and mark the field uncertain.',
  '- yield: the yield strength (ReH, ReL, Rp0.2, Re, YS, YP) in MPa; N/mm² is the same. Convert ksi (× 6.895) and mark it uncertain. When a coil has several yield results (head and tail, several tests), give the lowest. Never the tensile strength (Rm, TS).',
  '- certificateNumber: the number of the certificate the coil is listed in, as printed ("Certificate No.", "A03"). When pages carry different numbers, each coil takes its own page’s.',
  '- page: the page of the PDF its row is on, counting from 1.',
  '- uncertain: the fields you could not read with full confidence (blurred, rotated or small print, a stamp over it, a column you had to guess) or that you converted. A value you cannot read at all is null, and marked uncertain.',
  '',
  'Read numbers exactly as printed, without rounding; a decimal comma is a decimal point. Where a table scales its values (a header such as "×1000"), that applies to the chemistry only: thickness, width and yield are never scaled.',
  '',
  'documentKind: "coil-certificate" when the document certifies steel coils (strip or sheet in coils); "other" for anything else (wire, wire rod, welding consumables, pipes, an invoice, a letter): then list no coils and say in problem what the document is.',
  'problem: null, or one short sentence for the person when something kept you from reading part of the document (pages unreadable, cut off).',
].join('\n')

const nullable = (schema: object) => ({ anyOf: [schema, { type: 'null' }] })

/** What a reply must look like: the register's fields, the certificate's number, the page, what was unsure. */
export const MTC_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['documentKind', 'problem', 'coils'],
  properties: {
    documentKind: { type: 'string', enum: ['coil-certificate', 'other'] },
    problem: nullable({ type: 'string' }),
    coils: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['coilNumber', 'grade', 'smType', 'supplier', 'thickness', 'width', 'yield', 'certificateNumber', 'page', 'uncertain'],
        properties: {
          coilNumber: { type: 'string' },
          grade: nullable({ type: 'string' }),
          smType: nullable({ type: 'string', enum: [...MTC_SM_TYPES] }),
          supplier: nullable({ type: 'string' }),
          thickness: nullable({ type: 'number' }),
          width: nullable({ type: 'number' }),
          yield: nullable({ type: 'number' }),
          certificateNumber: nullable({ type: 'string' }),
          page: { type: 'integer' },
          uncertain: {
            type: 'array',
            items: { type: 'string', enum: ['coilNumber', 'grade', 'smType', 'supplier', 'thickness', 'width', 'yield', 'certificateNumber'] },
          },
        },
      },
    },
  },
} as const

/** The PDF and what to do with it: the one user message, the same for counting and for reading. */
export function mtcMessages(pdf: Buffer, fileName: string): Anthropic.Beta.BetaMessageParam[] {
  const title = fileName.replace(/[\s]+/g, ' ').trim().slice(0, 255) || 'certificate.pdf'
  return [
    {
      role: 'user',
      content: [
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdf.toString('base64') }, title },
        { type: 'text', text: 'List every coil in this certificate for the coil register.' },
      ],
    },
  ]
}

/** The whole request. Thinking is not shown to anyone, so it is not sent back. */
export function mtcRequest(pdf: Buffer, fileName: string): ModelParams {
  return {
    model: MTC_MODEL,
    max_tokens: MTC_MAX_TOKENS,
    betas: [STRUCTURED_OUTPUTS_BETA],
    system: MTC_SYSTEM,
    thinking: { type: 'adaptive', display: 'omitted' },
    output_config: { effort: 'high', format: { type: 'json_schema', schema: MTC_OUTPUT_SCHEMA as unknown as Record<string, unknown> } },
    messages: mtcMessages(pdf, fileName),
  }
}

/** A reply that could not be turned into rows: the person is told why, in words. */
export class MtcReadError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MtcReadError'
  }
}

const replySchema = z.object({
  documentKind: z.enum(['coil-certificate', 'other']),
  problem: z.string().nullable(),
  coils: z.array(
    z.object({
      coilNumber: z.string(),
      grade: z.string().nullable(),
      smType: z.string().nullable(),
      supplier: z.string().nullable(),
      thickness: z.number().nullable(),
      width: z.number().nullable(),
      yield: z.number().nullable(),
      certificateNumber: z.string().nullable(),
      page: z.number().int(),
      uncertain: z.array(z.string()),
    }),
  ),
})

/** The mills' names as the register spells them, whatever case the reply used. */
const SUPPLIER_SPELLING = new Map<string, string>(MTC_SUPPLIERS.map((s) => [s.toLowerCase(), s]))

/** Text cut to what the register takes. */
const fit = (v: string | null, max: number): string | undefined => {
  const t = cleanMtcText(v)
  return t === undefined ? undefined : t.slice(0, max)
}

/**
 * The review's rows from Claude's reply: each field cleaned as the register
 * keeps it, the certificate's number as the notes ("MTC 067711"), one row per
 * coil number (a coil listed twice keeps its first row, with the fields only
 * the second had). Throws MtcReadError when the reply is unusable.
 */
export function readMtcReply(message: ModelMessage, fileName: string): MtcExtractResult {
  if (message.stop_reason === 'refusal') throw new MtcReadError('Claude would not read this document. Check that it is a mill test certificate.')
  if (message.stop_reason === 'max_tokens') {
    throw new MtcReadError('This certificate lists too many coils to read in one go. Split the PDF into parts and upload them one by one.')
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

  const byKey = new Map<string, MtcExtractedCoil>()
  for (const c of reply.coils) {
    const coilNumber = fit(c.coilNumber, MTC_TEXT_MAX.coilNumber)
    if (!coilNumber) continue
    const uncertain = new Set<MtcCoilField>()
    for (const u of c.uncertain) {
      const field = u === 'certificateNumber' ? 'notes' : u
      if ((MTC_COIL_FIELDS as readonly string[]).includes(field)) uncertain.add(field as MtcCoilField)
    }
    const grade = fit(c.grade, MTC_TEXT_MAX.grade)?.replace(/\s+/g, '').toUpperCase()
    const supplier = fit(c.supplier, MTC_TEXT_MAX.supplier)
    const certificate = fit(c.certificateNumber, MTC_TEXT_MAX.notes - 4)
    const row: MtcExtractedCoil = {
      coilNumber,
      grade: grade || undefined,
      smType: c.smType && (MTC_SM_TYPES as readonly string[]).includes(c.smType) ? c.smType : undefined,
      supplier: supplier ? (SUPPLIER_SPELLING.get(supplier.toLowerCase()) ?? supplier) : undefined,
      thickness: cleanMtcNumber(c.thickness),
      width: cleanMtcNumber(c.width),
      yield: cleanMtcNumber(c.yield),
      notes: certificate ? `MTC ${certificate}` : undefined,
      page: c.page >= 1 ? c.page : undefined,
      uncertain: [],
    }
    // A value that came back empty, or was thrown out here, is one to look at.
    for (const f of MTC_COIL_FIELDS) if (row[f] === undefined) uncertain.add(f)
    row.uncertain = MTC_COIL_FIELDS.filter((f) => uncertain.has(f))

    const key = coilNumber.toLowerCase()
    const first = byKey.get(key)
    if (!first) {
      byKey.set(key, row)
      continue
    }
    for (const f of MTC_COIL_FIELDS) {
      if (first[f] === undefined && row[f] !== undefined) (first as unknown as Record<string, unknown>)[f] = row[f]
    }
    first.uncertain = MTC_COIL_FIELDS.filter((f) => first[f] === undefined || (first.uncertain.includes(f) && row.uncertain.includes(f)))
  }

  const result: MtcExtractResult = {
    fileName,
    coils: reply.documentKind === 'other' ? [] : Array.from(byKey.values()),
    notCoils: reply.documentKind === 'other',
  }
  const problem = cleanMtcText(reply.problem)
  if (problem) result.problem = problem.slice(0, 500)
  return result
}
