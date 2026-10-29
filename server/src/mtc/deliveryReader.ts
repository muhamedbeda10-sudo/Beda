// ============================================================================
// Delivery notes — what Claude is asked to read from a supplier's delivery
// note (its number, day, PO, supplier and the coils received), and how its
// reply becomes the review's note. Read as a certificate is (mtc/reader.ts):
// one call, the file as the person has it, the reply held to a JSON schema
// with every field text, then checked and cleaned here again.
// ============================================================================

import type Anthropic from '@anthropic-ai/sdk'
import { z } from 'zod'
import type { AiEffort } from '@qc/shared/ai'
import { DELIVERY_NOTE_MAX_COILS, MTC_SUPPLIERS, cleanMtcNumber, cleanMtcText, type DeliveryNoteExtractResult } from '@qc/shared/mtc'
import type { ModelMessage, ModelParams } from '../ai/model'
import { MTC_MAX_TOKENS, MtcReadError, type MtcSource } from './reader'

export const DELIVERY_SYSTEM = [
  'You read delivery notes (delivery orders, packing lists, waybills, إذن تسليم / إذن صرف) of steel coils and sheets delivered to a steel fabrication factory, for the factory’s register of deliveries.',
  'A note comes as its PDF, as photos of its pages (in order: photo 1 is page 1), or as a spreadsheet given to you as text.',
  'People check your reading against the paper before it is saved, so mark every value you are not sure of rather than guessing silently.',
  '',
  '- isDeliveryNote: false when the document is not a delivery note of coils or sheets (a mill test certificate, an invoice alone, a letter): then leave everything else empty and say in problem what it is.',
  '- noteNumber: the note’s own number as printed ("Delivery Note No.", "DN No.", "رقم الإذن"); empty when there is none.',
  '- deliveryDate: the day of delivery (or, failing that, of the note), as YYYY-MM-DD. Day-first dates are the rule here: 05/03/2026 is 2026-03-05. Empty when there is none.',
  '- poNumber: the purchaser’s (the factory’s) purchase order number ("PO", "P.O. No.", "Order No.", "Customer order", "أمر شراء"); never the supplier’s own sales order when both are printed. Empty when there is none.',
  '- supplier: the company that delivers the material (the mill or the trader whose note it is), by its short name in Latin letters, never the customer or consignee. For steel mills use exactly one of ' +
    MTC_SUPPLIERS.map((s) => `"${s}"`).join(', ') +
    ' when it is one of them; any other: its shortest recognisable name.',
  '- coils: one entry per coil (or sheet pack) delivered, in the order listed. coilNumber exactly as printed with its dashes, letters and leading zeros (never the heat number or the line’s serial); weightKg the coil’s net weight in kilograms (tonnes × 1000), as plain digits with a decimal point, empty when not given. Skip totals and repeated headers.',
  '- uncertain: the fields you could not read with full confidence ("noteNumber", "deliveryDate", "poNumber", "supplier", "coils").',
  '- problem: empty, or one short sentence for the person when something kept you from reading part of it, or when the file holds several notes (read the first, and say so).',
].join('\n')

const HEADER_FIELDS = ['noteNumber', 'deliveryDate', 'poNumber', 'supplier'] as const

export const DELIVERY_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['isDeliveryNote', 'problem', ...HEADER_FIELDS, 'coils', 'uncertain'],
  properties: {
    isDeliveryNote: { type: 'boolean' },
    problem: { type: 'string' },
    noteNumber: { type: 'string' },
    deliveryDate: { type: 'string' },
    poNumber: { type: 'string' },
    supplier: { type: 'string' },
    coils: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['coilNumber', 'weightKg'],
        properties: { coilNumber: { type: 'string' }, weightKg: { type: 'string' } },
      },
    },
    uncertain: { type: 'array', items: { type: 'string', enum: [...HEADER_FIELDS, 'coils'] } },
  },
}

/** The note and what to do with it: the one user message, the same for counting and for reading. */
export function deliveryMessages(source: MtcSource, fileName: string): Anthropic.Beta.BetaMessageParam[] {
  const title = fileName.replace(/[\s]+/g, ' ').trim().slice(0, 255) || 'delivery note'
  const ask: Anthropic.Beta.BetaTextBlockParam = { type: 'text', text: 'Read this delivery note: its number, day, PO, supplier and every coil delivered.' }
  let content: Anthropic.Beta.BetaContentBlockParam[]
  if (source.kind === 'pdf') {
    content = [{ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: source.data.toString('base64') }, title }, ask]
  } else if (source.kind === 'images') {
    content = [
      { type: 'text', text: `${title}: ${source.images.length === 1 ? 'a photo of the note' : `photos of the note’s ${source.images.length} pages, in order`}.` },
      ...source.images.flatMap((img, i): Anthropic.Beta.BetaContentBlockParam[] => [
        { type: 'text', text: `Photo ${i + 1}:` },
        { type: 'image', source: { type: 'base64', media_type: img.type, data: img.data.toString('base64') } },
      ]),
      ask,
    ]
  } else {
    content = [{ type: 'text', text: `<spreadsheet name="${title.replace(/["<>]/g, '')}">\n${source.text}\n</spreadsheet>` }, ask]
  }
  return [{ role: 'user', content }]
}

export function deliveryRequest(source: MtcSource, fileName: string, run: { model: string; effort: AiEffort }): ModelParams {
  return {
    model: run.model,
    max_tokens: MTC_MAX_TOKENS,
    system: DELIVERY_SYSTEM,
    thinking: { type: 'adaptive', display: 'omitted' },
    output_config: { effort: run.effort, format: { type: 'json_schema', schema: DELIVERY_OUTPUT_SCHEMA as unknown as Record<string, unknown> } },
    messages: deliveryMessages(source, fileName),
  }
}

const replySchema = z.object({
  isDeliveryNote: z.boolean(),
  problem: z.string().nullable(),
  noteNumber: z.string().nullable(),
  deliveryDate: z.string().nullable(),
  poNumber: z.string().nullable(),
  supplier: z.string().nullable(),
  coils: z.array(z.object({ coilNumber: z.unknown(), weightKg: z.unknown() }).passthrough()),
  uncertain: z.array(z.string()).nullable(),
})

const SUPPLIER_SPELLING = new Map<string, string>(MTC_SUPPLIERS.map((s) => [s.toLowerCase(), s]))

/** A day as YYYY-MM-DD when it is a real one, else undefined. */
export function cleanDay(v: unknown): string | undefined {
  const t = cleanMtcText(v)
  if (!t || !/^\d{4}-\d{2}-\d{2}$/.test(t)) return undefined
  const d = new Date(`${t}T00:00:00Z`)
  const year = Number(t.slice(0, 4))
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === t && year >= 2000 && year <= 2100 ? t : undefined
}

/** The review's note from Claude's reply. Throws MtcReadError when the reply is unusable. */
export function readDeliveryReply(message: ModelMessage, fileName: string): DeliveryNoteExtractResult {
  if (message.stop_reason === 'refusal') throw new MtcReadError('Claude would not read this document. Check that it is a delivery note.')
  if (message.stop_reason === 'max_tokens') {
    throw new MtcReadError('This delivery note lists too many coils to read in one go. Split it into parts and upload them one by one.', true)
  }
  const text = message.content
    .filter((b): b is Extract<(typeof message.content)[number], { type: 'text' }> => b.type === 'text')
    .map((b) => b.text)
    .join('')
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    throw new MtcReadError('Claude’s reading of this delivery note came back incomplete. Try again.')
  }
  const parsed = replySchema.safeParse(json)
  if (!parsed.success) throw new MtcReadError('Claude’s reading of this delivery note came back incomplete. Try again.')
  const reply = parsed.data
  const problem = cleanMtcText(reply.problem)?.slice(0, 500)
  if (!reply.isDeliveryNote) return { fileName, note: null, ...(problem ? { problem } : {}) }

  const seen = new Set<string>()
  const coils: { coilNumber: string; weightKg: number | null }[] = []
  for (const c of reply.coils) {
    const coilNumber = cleanMtcText(c.coilNumber)?.slice(0, 120)
    if (!coilNumber || seen.has(coilNumber.toLowerCase())) continue
    seen.add(coilNumber.toLowerCase())
    coils.push({ coilNumber, weightKg: cleanMtcNumber(c.weightKg) ?? null })
    if (coils.length >= DELIVERY_NOTE_MAX_COILS) break
  }
  const deliveryDate = cleanDay(reply.deliveryDate)
  const supplier = cleanMtcText(reply.supplier)?.slice(0, 200)
  const said = new Set((reply.uncertain ?? []).filter((u) => (HEADER_FIELDS as readonly string[]).includes(u) || u === 'coils'))
  // A day that could not be read, or no coils, is one to look at.
  if (!deliveryDate) said.add('deliveryDate')
  if (coils.length === 0) said.add('coils')
  return {
    fileName,
    note: {
      noteNumber: cleanMtcText(reply.noteNumber)?.slice(0, 120) ?? '',
      deliveryDate: deliveryDate ?? '',
      poNumber: cleanMtcText(reply.poNumber)?.slice(0, 120) ?? '',
      supplier: supplier ? (SUPPLIER_SPELLING.get(supplier.toLowerCase()) ?? supplier) : '',
      notes: '',
      coils,
      uncertain: [...said],
    },
    ...(problem ? { problem } : {}),
  }
}
