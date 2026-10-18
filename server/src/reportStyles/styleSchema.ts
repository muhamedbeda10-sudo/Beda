// ============================================================================
// A report style as the API takes it (shared/src/reportStyles.ts): every
// choice from its list, every colour a #RRGGBB hex, every line of text one
// line and short. What the assistant proposes goes through the same check,
// so nothing it writes can reach a report unchecked.
// ============================================================================

import { z } from 'zod'
import {
  REPORT_STYLE_BORDERS,
  REPORT_STYLE_FIGURES,
  REPORT_STYLE_FONTS,
  REPORT_STYLE_LOGO_MAX_CHARS,
  REPORT_STYLE_LOGO_POSITIONS,
  REPORT_STYLE_LOGO_SIZES,
  REPORT_STYLE_MAX_APPROVALS,
  REPORT_STYLE_NAME_MAX,
  REPORT_STYLE_ORIENTATIONS,
  REPORT_STYLE_RULES,
  REPORT_STYLE_TEXT_MAX,
  type ReportStyleSpec,
} from '@qc/shared/reportStyles'

/** One line of text: line breaks and runs of spaces as one space, control characters gone. */
// eslint-disable-next-line no-control-regex
const oneLine = (max: number) => z.string().transform((s) => s.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim()).pipe(z.string().max(max))

const hex = z
  .string()
  .regex(/^#?[0-9a-fA-F]{6}$/, 'A colour is written #RRGGBB.')
  .transform((s) => `#${s.replace('#', '').toUpperCase()}`)

export const styleSpecSchema: z.ZodType<ReportStyleSpec, z.ZodTypeDef, unknown> = z
  .object({
    colors: z
      .object({
        primary: hex,
        accent: hex,
        heading: hex,
        text: hex,
        tableHeaderBg: hex,
        tableHeaderText: hex,
        tableStripe: hex,
        tableBorder: hex,
      })
      .strict(),
    font: z.enum(REPORT_STYLE_FONTS),
    orientation: z.enum(REPORT_STYLE_ORIENTATIONS as [ReportStyleSpec['orientation'], ...ReportStyleSpec['orientation'][]]),
    logo: z
      .object({
        position: z.enum(REPORT_STYLE_LOGO_POSITIONS as [ReportStyleSpec['logo']['position'], ...ReportStyleSpec['logo']['position'][]]),
        size: z.enum(REPORT_STYLE_LOGO_SIZES as [ReportStyleSpec['logo']['size'], ...ReportStyleSpec['logo']['size'][]]),
      })
      .strict(),
    header: z
      .object({
        companyName: oneLine(REPORT_STYLE_TEXT_MAX),
        department: oneLine(REPORT_STYLE_TEXT_MAX),
        showKind: z.boolean(),
        rule: z.enum(REPORT_STYLE_RULES as [ReportStyleSpec['header']['rule'], ...ReportStyleSpec['header']['rule'][]]),
      })
      .strict(),
    docControl: z
      .object({
        enabled: z.boolean(),
        docNo: oneLine(60),
        revision: oneLine(20),
        issueDate: oneLine(30),
      })
      .strict(),
    table: z
      .object({
        borders: z.enum(REPORT_STYLE_BORDERS as [ReportStyleSpec['table']['borders'], ...ReportStyleSpec['table']['borders'][]]),
        stripes: z.boolean(),
        compact: z.boolean(),
      })
      .strict(),
    figures: z.enum(REPORT_STYLE_FIGURES as [ReportStyleSpec['figures'], ...ReportStyleSpec['figures'][]]),
    numbering: z.boolean(),
    footer: z.object({ text: oneLine(REPORT_STYLE_TEXT_MAX), pageNumbers: z.boolean() }).strict(),
    approvals: z
      .object({
        enabled: z.boolean(),
        labels: z.array(oneLine(40)).max(REPORT_STYLE_MAX_APPROVALS),
      })
      .strict()
      .transform((a) => ({ enabled: a.enabled, labels: a.labels.filter((l) => l !== '') })),
  })
  .strict()

export const styleNameSchema = oneLine(REPORT_STYLE_NAME_MAX).pipe(z.string().min(1, 'Give the style a name.'))

/** A logo as kept: a PNG or JPEG data URL whose bytes are what it says, and small. */
export const logoSchema = z
  .string()
  .max(REPORT_STYLE_LOGO_MAX_CHARS, 'The logo is too large: use a smaller picture (the app shrinks one you pick).')
  .regex(/^data:image\/(png|jpeg);base64,[A-Za-z0-9+/]+={0,2}$/, 'The logo must be a PNG or JPEG picture.')
  .refine((url) => {
    const [head, data] = url.split(',')
    const bytes = Buffer.from(data, 'base64').subarray(0, 4)
    return head.includes('png') ? bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 : bytes[0] === 0xff && bytes[1] === 0xd8
  }, 'The logo is not the picture it claims to be.')
  .nullable()
