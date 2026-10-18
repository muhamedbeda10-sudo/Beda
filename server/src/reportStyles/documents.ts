// ============================================================================
// What a report run and a delivered scheduled report put into a file: the
// values an Excel form's cells take (FormData) and the content of the styled
// workbook (WorkbookDoc). A run is a saved report run now, over its period
// and inputs; a delivery is what was sent, never run again.
// ============================================================================

import { describeAiDays, type AiDayRange, type AiReport, type AiReportSectionRun } from '@qc/shared/ai'
import { inputValueText, type AiReportInputValues } from '@qc/shared/aiReportInputs'
import type { AutomationDelivery } from '@qc/shared/automation'
import type { ReportFormField, ResolvedReportStyle } from '@qc/shared/reportStyles'
import { sectionSql, type RunPeriod } from '../ai/reports'
import type { ReportFormMapping } from '@qc/shared/reportStyles'
import { badRequest } from '../lib/errors'
import { FormFillError, fillForm, type FormData } from '../reportForms/formBook'
import { factoryStamp, type WorkbookDoc, type WorkbookSection } from './styledWorkbook'

/** The days a file covers, in words: "Last 7 days (3 Oct – 9 Oct 2026)". */
function periodWords(p: AiDayRange & { label: string }): string {
  const days = describeAiDays(p)
  const label = p.label.trim()
  return !label || label === days ? days : `${label} (${days})`
}

/** The report's own fields a form's cell can take. */
function fields(args: {
  title: string
  description?: string
  period: (AiDayRange & { label: string }) | null
  ranAt: string
  style: ResolvedReportStyle
  madeBy: string
  timeZone: string
}): Record<ReportFormField, string> {
  const stamp = factoryStamp(args.ranAt, args.timeZone)
  const doc = args.style.spec.docControl
  return {
    'report.title': args.title,
    'report.description': args.description ?? '',
    'period.label': args.period ? periodWords(args.period) : '',
    'period.from': args.period?.from ?? '',
    'period.to': args.period?.to ?? '',
    'ran.at': stamp,
    'ran.day': stamp.slice(0, 10),
    'doc.no': doc.docNo,
    'doc.revision': doc.revision,
    'doc.issueDate': doc.issueDate,
    'printed.by': args.madeBy,
  }
}

export interface ReportRunFile {
  report: AiReport
  period: RunPeriod | null
  values: AiReportInputValues
  sections: { title: string; ok: boolean; error?: string; columns: string[]; rows: AiReportSectionRun['rows']; truncated: boolean }[]
  ranAt: string
  style: ResolvedReportStyle
  madeBy: string
  timeZone: string
}

export function reportFormData(f: ReportRunFile): FormData {
  return {
    fields: fields({ title: f.report.title, description: f.report.description, period: f.period, ranAt: f.ranAt, style: f.style, madeBy: f.madeBy, timeZone: f.timeZone }),
    inputs: Object.fromEntries(f.report.inputs.map((i) => [i.name, inputValueText(f.values[i.name] ?? null)])),
    sections: f.sections,
  }
}

export function reportWorkbookDoc(f: ReportRunFile): WorkbookDoc {
  const about: WorkbookDoc['about'] = [
    f.report.description ? ['Shows', f.report.description] : ['Question', f.report.question],
    ...f.report.inputs.map((i): [string, string] => [i.label, inputValueText(f.values[i.name] ?? null)]),
    ['Period', f.period ? `${periodWords(f.period)}${f.period.overridden ? ', chosen for this file' : ''}` : 'As the queries were asked'],
    ['Run at', factoryStamp(f.ranAt, f.timeZone)],
  ]
  const sections: WorkbookSection[] = f.sections.map((s, i) => {
    const saved = f.report.sections[i]
    return { ...s, ...(saved?.sql ? { sql: sectionSql(f.report, saved, f.period, f.values) } : {}) }
  })
  return {
    kind: 'Saved report',
    title: f.report.title,
    about,
    sections,
    truncatedNote: (rows) => `No — only the first ${rows.toLocaleString('en-US')} rows`,
    madeBy: f.madeBy,
    madeAt: new Date().toISOString(),
    timeZone: f.timeZone,
  }
}

export interface DeliveryFile {
  delivery: AutomationDelivery
  /** Its saved report's inputs, by name: a delivery keeps each value under its label. */
  inputNames: { name: string; label: string }[]
  reportDescription?: string
  style: ResolvedReportStyle
  madeBy: string
  timeZone: string
}

export function deliveryFormData(f: DeliveryFile): FormData {
  const d = f.delivery
  const byLabel = new Map((d.inputs ?? []).map((i) => [i.label, i.value]))
  return {
    fields: fields({ title: d.report?.title ?? d.automationName, description: f.reportDescription, period: d.period, ranAt: d.ranAt, style: f.style, madeBy: f.madeBy, timeZone: f.timeZone }),
    inputs: Object.fromEntries(f.inputNames.map((i) => [i.name, byLabel.get(i.label) ?? ''])),
    sections: d.sections,
  }
}

export function deliveryWorkbookDoc(f: DeliveryFile): WorkbookDoc {
  const d = f.delivery
  const about: WorkbookDoc['about'] = [
    ['Delivered', factoryStamp(d.ranAt, f.timeZone)],
    ...(d.report ? [['Saved report', d.report.title] as [string, string]] : []),
    ...(d.inputs ?? []).map((i): [string, string] => [i.label, i.value]),
    ['Period', d.period ? periodWords(d.period) : d.report ? 'As the report covers' : 'Its queries take no period'],
  ]
  if (d.summary) about.push(['Summary', d.summary])
  else if (d.summaryNote) about.push(['Summary', d.summaryNote])
  return {
    kind: 'Scheduled report',
    title: d.automationName,
    about,
    sections: d.sections.map((s) => ({ title: s.title, ok: s.ok, error: s.error, columns: s.columns, rows: s.rows, truncated: s.truncated })),
    truncatedNote: (rows) => `No — only the first ${rows.toLocaleString('en-US')} rows were delivered`,
    madeBy: f.madeBy,
    madeAt: new Date().toISOString(),
    timeZone: f.timeZone,
  }
}

/** QC-Report-Top-defects-2026-10-09-1405.xlsx: the report's name, and when it ran, where the factory sits. */
export function reportFileName(title: string, ranAt: string, timeZone: string, suffix = ''): string {
  const name = title
    // eslint-disable-next-line no-control-regex
    .replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, ' ')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, 50)
    .replace(/[-.]+$/, '')
  const at = factoryStamp(ranAt, timeZone).replace(' ', '-').replace(':', '')
  return `${name ? `QC-Report-${name}` : 'QC-Report'}${suffix}-${at}.xlsx`
}

/** A form filled; what stops it (a section that failed, a column gone) is the person's to read. */
export async function filledForm(bytes: Buffer, mapping: ReportFormMapping, data: FormData): Promise<Buffer> {
  try {
    return await fillForm(bytes, mapping, data)
  } catch (e) {
    if (e instanceof FormFillError) throw badRequest(e.message)
    throw e
  }
}
