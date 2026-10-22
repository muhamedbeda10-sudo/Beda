import { z } from 'zod'
import { COMPLAINT_ISSUES, EFFECTIVENESS, NCR_DISPOSITIONS, NCR_SOURCES } from '@qc/shared/qualityRecords'

export const qualityDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((s) => {
  const d = new Date(`${s}T00:00:00Z`)
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === s && s >= '0001-01-01'
}, 'Choose a valid date.')
const optionalDay = z.union([z.literal(''), qualityDay]).default('')
const text = (max = 4000) => z.string().trim().max(max).default('')
const required = (max = 4000) => z.string().trim().min(1).max(max)
const unique = <T>(v: T[]) => Array.from(new Set(v))
const choices = <T extends readonly [string, ...string[]]>(values: T) => z.array(z.enum(values)).max(values.length).default([]).transform(unique)

export const ncrDataSchema = z.object({
  kind: z.literal('ncr'), orderNumber: text(500), customer: text(500),
  factories: z.array(required(120)).max(100).default([]).transform((v) => unique(v).sort()),
  machineIds: z.array(z.string().uuid()).max(500).default([]).transform((v) => unique(v).sort()),
  process: text(200), raisedBy: required(200), assignedTo: text(200),
  sources: choices(NCR_SOURCES).refine((v) => v.length > 0, 'Select a source.'), sourceOther: text(500),
  totalQuantity: text(200), rejectedQuantity: text(200), description: required(),
  immediateAction: text(), responsiblePerson: text(200), dispositions: choices(NCR_DISPOSITIONS),
  correctiveActionRequired: z.boolean().nullable().default(null), rootCause: text(), completedBy: text(200),
  correctiveActions: z.array(z.object({ description: required(2000), responsibility: text(200), completionDate: optionalDay })).max(50).default([]),
  effectivenessDetails: text(), effectiveness: z.enum(EFFECTIVENESS).default('Pending'), effectivenessDate: optionalDay,
}).superRefine((v, ctx) => {
  if (v.sources.includes('Product non-conformity')) {
    if (!v.totalQuantity) ctx.addIssue({ code: 'custom', path: ['totalQuantity'], message: 'Enter the total quantity.' })
    if (!v.rejectedQuantity) ctx.addIssue({ code: 'custom', path: ['rejectedQuantity'], message: 'Enter the rejected quantity.' })
    if (/^-?\d+(\.\d+)?$/.test(v.totalQuantity) && /^-?\d+(\.\d+)?$/.test(v.rejectedQuantity)) {
      const total = Number(v.totalQuantity), rejected = Number(v.rejectedQuantity)
      if (total < 0 || rejected < 0 || rejected > total) ctx.addIssue({ code: 'custom', path: ['rejectedQuantity'], message: 'Rejected quantity must be between zero and the total quantity.' })
    }
  }
  if (v.effectiveness !== 'Pending' && !v.effectivenessDate) ctx.addIssue({ code: 'custom', path: ['effectivenessDate'], message: 'Enter the effectiveness check date.' })
})

export const complaintDataSchema = z.object({
  kind: z.literal('customer-complaint'), orderNumber: required(500), customer: text(500), productName: required(1000), itemCode: text(500),
  contactPerson: text(200), email: z.union([z.literal(''), z.string().trim().email().max(320)]).default(''), telephone: text(80),
  dimensions: text(500), colour: text(200), invoiceNumber: text(200), invoiceDate: optionalDay, quantity: text(200), nonComplianceDetails: text(),
  issues: choices(COMPLAINT_ISSUES).refine((v) => v.length > 0, 'Select a product issue.'), issueOther: text(500), description: required(),
  processedQuantity: text(200), lostQuantity: text(200), reportDate: optionalDay, reportName: text(200), signature: text(500),
})
export const qualitySaveSchema = z.object({
  reference: text(120), date: qualityDay, data: z.unknown(), imageIds: z.array(z.string().uuid()).max(50).default([]).transform(unique),
})
