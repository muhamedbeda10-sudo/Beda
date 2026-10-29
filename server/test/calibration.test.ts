import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  addMonths, calibrationStatus, daysBetween, judgeCertificate, nextDueOn, parseCalibrationCertificateLog, parseCalibrationRegister, parseCalibrationScrapLog,
  type CalibrationCategory, type CalibrationCertificate, type CalibrationCertificateData, type CalibrationFile, type CalibrationImportResult, type CalibrationItem,
  type CalibrationItemData, type CalibrationItemDetail, type CalibrationItemList, type CalibrationOptions,
} from '@qc/shared/calibration'
import type { ApiErrorBody } from '@qc/shared/api'
import { runReadOnlyQuery } from '../src/ai/runQuery'
import { calendarDay, TestApp, type Session } from './harness'

// §27 — calibration: the plan of the measuring instruments (the next
// calibration worked out, never typed), their certificates (readings judged
// against the tolerance; the latest moves its instrument on), the outside
// laboratories' PDFs, scrapping and its log, the configuration, and the old
// workbooks imported.

const app = new TestApp()
let admin: Session, writer: Session, reader: Session, outsider: Session
let options: CalibrationOptions
let vernier: CalibrationCategory
const today = calendarDay()
const pdf = Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n')

const item = (patch: Partial<CalibrationItemData> = {}): CalibrationItemData => ({
  categoryId: vernier.id, name: 'باكوليس/ Vernier 150mm', deviceCode: '014088278', manufacturer: 'Insize', range: '150mm', resolution: '0.02 mm', tolerance: 0.03, unit: 'mm',
  departmentId: options.departments.find((d) => d.name === 'الجودة')!.id, holder: 'جرجس موريس', receivedOn: '2022-10-25', kind: 'internal', calibrationCode: 'V.01.QC.01',
  lastCalibratedOn: '2025-09-01', intervalMonths: 12, notes: '', ...patch,
})
const postItem = (data: CalibrationItemData, as = writer, submissionId: string = randomUUID()) =>
  app.api<CalibrationItem & ApiErrorBody>('POST', '/api/calibration/items', { token: as.token, body: { ...data, submissionId } })
const putItem = (i: CalibrationItem, patch: Partial<CalibrationItemData> = {}, as = writer) =>
  app.api<CalibrationItem & ApiErrorBody>('PUT', `/api/calibration/items/${i.id}`, { token: as.token, body: { ...i, ...patch, version: i.version } })
const detail = async (id: string) => (await app.api<CalibrationItemDetail>('GET', `/api/calibration/items/${id}`, { token: reader.token })).body
const certificate = (itemId: string, patch: Partial<CalibrationCertificateData> = {}): CalibrationCertificateData => ({
  itemId, certificateNo: '', kind: 'internal', calibratedOn: '2026-07-12', intervalMonths: 12, body: '', performedBy: 'أ/ يوسف فتحى', approvedBy: 'م/ مايكل بهجت',
  resolution: '0.01 mm', tolerance: 0.03, unit: 'mm', reference: { ...vernier.reference },
  groups: [
    { name: 'External', readings: [{ nominal: 11.5, reading: 11.52 }, { nominal: 40, reading: 40.02 }, { nominal: 70, reading: 70.02 }, { nominal: 135, reading: 135.02 }] },
    { name: 'Internal', readings: [{ nominal: 10, reading: 9.98 }, { nominal: 79.5, reading: 79.48 }, { nominal: 100, reading: null }] },
    { name: 'Empty', readings: [{ nominal: null, reading: null }] },
  ],
  fileId: null, notes: '', ...patch,
})
const postCert = (data: CalibrationCertificateData, as = writer) =>
  app.api<CalibrationCertificate & ApiErrorBody>('POST', '/api/calibration/certificates', { token: as.token, body: { ...data, submissionId: randomUUID() } })
const list = async (query: string) => (await app.api<CalibrationItemList>('GET', `/api/calibration/items?${query}`, { token: reader.token })).body
const upload = async (as: Session, bytes: Buffer = pdf, name = 'NIS certificate.pdf') => {
  const form = new FormData()
  form.append('file', new Blob([bytes], { type: 'application/pdf' }), name)
  return app.api<CalibrationFile & ApiErrorBody>('POST', '/api/calibration/files', { token: as.token, raw: form })
}
const ai = async (sql: string) => {
  const res = await runReadOnlyQuery(app.aiReader.poolFor(['materials'])!, sql, { maxRows: 100, timeoutMs: 10_000, timeZone: app.config.FACTORY_TIMEZONE })
  if (!res.ok) throw new Error(res.error)
  return res.rows
}

beforeAll(async () => {
  await app.start(); await app.resetDatabase()
  admin = await app.register('admin', 'Administrator')
  const sessions: Session[] = []
  for (const [username, role] of [['calwriter', 'supervisor'], ['calreader', 'inspector'], ['outsider', 'viewer']] as const) {
    expect((await app.api('POST', '/api/users', { token: admin.token, body: { username, password: 'Password#1', name: username, role } })).status).toBe(201)
    sessions.push(await app.login(username))
  }
  ;[writer, reader, outsider] = sessions
  options = (await app.api<CalibrationOptions>('GET', '/api/calibration/options', { token: reader.token })).body
  vernier = options.categories.find((c) => c.codePrefix === 'V')!
})
afterAll(() => app.stop())

describe('§27 calibration', () => {
  it('opens to whoever may see Calibration, records for whoever may record, and sets up for administrators', async () => {
    for (const path of ['/api/calibration/items', '/api/calibration/options', `/api/calibration/items/${randomUUID()}`, `/api/calibration/files/${randomUUID()}/content`]) {
      expect((await app.api('GET', path, { token: outsider.token })).status, path).toBe(403)
    }
    expect((await postItem(item(), reader)).status).toBe(403)
    expect((await upload(reader)).status).toBe(403)
    expect((await app.api('POST', '/api/calibration/categories', { token: writer.token, body: { name: 'X', intervalMonths: 12, kind: 'internal' } })).status).toBe(403)
    expect((await app.api('POST', '/api/calibration/departments', { token: writer.token, body: { name: 'X' } })).status).toBe(403)
    expect((await app.api('POST', '/api/calibration/import', { token: writer.token, body: { kind: 'register', rows: [] } })).status).toBe(403)
  })

  it('starts from the workbooks’ configuration: the vernier’s certificate template and reference, the departments', () => {
    expect(vernier).toMatchObject({ intervalMonths: 12, kind: 'internal', resolution: '0.02 mm' })
    expect(vernier.template.map((g) => g.nominals)).toEqual([[11.5, 40, 70, 135], [10, 79.5, 100], [10, 50, 100]])
    expect(vernier.reference).toMatchObject({ serial: 'LS 8076', certificateNo: '322/63C007/12/661/2026' })
    expect(options.categories.find((c) => c.codePrefix === 'M')?.intervalMonths).toBe(3)
    expect(options.departments.map((d) => d.name)).toContain('التنايات')
    expect(options).toMatchObject({ nextCodeNumber: 1, holders: [], today })
  })

  it('works the next calibration out in the database as the screen does, month ends included', async () => {
    const days = ['2025-01-31', '2024-02-29', '2025-08-31', '2025-11-30', '2025-12-31', '2026-03-15']
    for (const months of [1, 3, 12, 15, 18]) {
      const { rows } = await app.db.query<{ d: string; n: string }>(`SELECT d::text AS d, (d::date + make_interval(months => $1))::date::text AS n FROM unnest($2::text[]) d`, [months, days])
      for (const r of rows) expect(addMonths(r.d, months), `${r.d} + ${months}`).toBe(r.n)
    }
  })

  it('adds an instrument: its next calibration, status and days left worked out', async () => {
    const res = await postItem(item())
    expect(res.status, JSON.stringify(res.body)).toBe(201)
    const i = res.body
    expect(i).toMatchObject({ nextDueOn: '2026-09-01', categoryName: vernier.name, departmentName: 'الجودة', certificates: 0, scrap: null, source: 'app' })
    expect(i.status).toBe(calibrationStatus({ nextDueOn: '2026-09-01', scrapped: false }, today))
    expect(i.daysLeft).toBe(daysBetween(today, '2026-09-01'))
    // A year and a half.
    const longer = await putItem(i, { intervalMonths: 18 })
    expect(longer.body).toMatchObject({ intervalMonths: 18, nextDueOn: nextDueOn('2025-09-01', 18), version: 1 })
    // Nothing to change is no change.
    expect((await putItem(longer.body)).body.version).toBe(1)
    // An old copy is refused.
    expect((await putItem(i, { holder: 'x' })).status).toBe(409)
    const history = (await detail(i.id)).history
    expect(history.find((h) => h.field === 'intervalMonths')).toMatchObject({ oldValue: '12', newValue: '18', userName: 'calwriter' })
    expect(history.some((h) => h.action === 'create')).toBe(true)
  })

  it('keeps a calibration code to one instrument in use, and the same submission saved once', async () => {
    expect((await postItem(item({ deviceCode: 'other' }))).status).toBe(409)
    const id = randomUUID()
    const a = await postItem(item({ calibrationCode: 'V.02.QC.01' }), writer, id)
    const b = await postItem(item({ calibrationCode: 'V.02.QC.01' }), writer, id)
    expect([a.status, b.status]).toEqual([201, 200])
    expect(b.body.id).toBe(a.body.id)
    expect((await postItem(item({ calibrationCode: 'V.03.QC.01', lastCalibratedOn: null }), writer, id)).status).toBe(409)
    expect((await app.api<CalibrationOptions>('GET', '/api/calibration/options', { token: reader.token })).body.nextCodeNumber).toBe(3)
  })

  it('lists the plan by status, period and words, with every status counted', async () => {
    const overdue = (await postItem(item({ calibrationCode: 'M.10.PB.03', name: 'شريط قياس صلب 5 M', lastCalibratedOn: addMonths(today, -4), intervalMonths: 3 }))).body
    const soon = (await postItem(item({ calibrationCode: 'M.11.PB.03', name: 'شريط قياس صلب 10 M', lastCalibratedOn: addMonths(today, -2), intervalMonths: 3 }))).body
    const never = (await postItem(item({ calibrationCode: '', name: 'Feeler', lastCalibratedOn: null }))).body
    expect(overdue.status).toBe('overdue')
    expect(soon.status).toBe(daysBetween(today, soon.nextDueOn!) <= 30 ? 'due-soon' : 'valid')
    expect(never).toMatchObject({ status: 'no-date', nextDueOn: null, daysLeft: null })
    const all = await list('')
    expect(all.counts.total).toBe(all.counts.inService)
    for (const s of ['overdue', 'due-soon', 'valid', 'no-date'] as const) expect(all.counts[s], s).toBe(all.items.filter((i) => i.status === s).length)
    expect(all.counts.overdue + all.counts['due-soon'] + all.counts.valid + all.counts['no-date']).toBe(all.counts.inService)
    // Earliest first, the ones without a date last.
    expect(all.items.map((i) => i.nextDueOn ?? '9999')).toEqual(all.items.map((i) => i.nextDueOn ?? '9999').sort())
    expect(all.items.at(-1)!.id).toBe(never.id)
    for (const s of ['overdue', 'due-soon', 'valid', 'no-date'] as const) {
      const found = await list(`status=${s}`)
      expect(found.items.every((i) => i.status === s), s).toBe(true)
      expect(found.total).toBe(all.counts[s])
    }
    expect((await list('status=overdue')).items.map((i) => i.id)).toContain(overdue.id)
    expect((await list('q=شريط')).items).toHaveLength(2)
    expect((await list('q=014088278')).total).toBe(all.total)
    const window = await list(`dueFrom=${addMonths(today, -2)}&dueTo=${today}`)
    expect(window.items.map((i) => i.id)).toContain(overdue.id)
    expect(window.items.every((i) => i.nextDueOn! >= addMonths(today, -2) && i.nextDueOn! <= today)).toBe(true)
    expect((await list(`departmentId=${options.departments.find((d) => d.name === 'المكابس')!.id}`)).total).toBe(0)
    expect((await app.api('GET', '/api/calibration/items?dueFrom=2026-02-01&dueTo=2026-01-01', { token: reader.token })).status).toBe(400)
  })

  it('records a certificate: the errors judged against the tolerance, and the instrument moved on', async () => {
    const i = (await postItem(item({ calibrationCode: 'V.171.QC.02' }))).body
    const res = await postCert(certificate(i.id))
    expect(res.status, JSON.stringify(res.body)).toBe(201)
    const c = res.body
    // The empty group and reading are left out; the number is the instrument's code.
    expect(c.groups.map((g) => g.name)).toEqual(['External', 'Internal'])
    expect(c).toMatchObject({ certificateNo: 'V.171.QC.02', nextDueOn: '2027-07-12', readings: 6, maxError: 0.02, result: 'pass', item: { name: i.name, departmentName: 'الجودة' } })
    expect(judgeCertificate(c.groups, 0.01).result).toBe('fail')
    const moved = (await detail(i.id))
    expect(moved.item).toMatchObject({ lastCalibratedOn: '2026-07-12', nextDueOn: '2027-07-12', certificates: 1, version: 1 })
    expect(moved.certificates.map((x) => x.id)).toEqual([c.id])
    expect(moved.history.filter((h) => h.entity === 'CalibrationCertificate').map((h) => h.action)).toEqual(['create'])
    expect(moved.history.find((h) => h.field === 'lastCalibratedOn')).toMatchObject({ oldValue: '2025-09-01', newValue: '2026-07-12' })

    // Corrected: out of tolerance now.
    const fixed = await app.api<CalibrationCertificate>('PUT', `/api/calibration/certificates/${c.id}`, { token: writer.token, body: { ...c, tolerance: 0.01, version: c.version } })
    expect(fixed.body).toMatchObject({ result: 'fail', tolerance: 0.01, version: 1 })

    // An older certificate entered afterwards leaves the instrument where it is.
    const older = await postCert(certificate(i.id, { calibratedOn: '2025-07-12', certificateNo: 'V.171.QC.01' }))
    expect(older.status).toBe(201)
    expect((await detail(i.id)).item).toMatchObject({ lastCalibratedOn: '2026-07-12', calibrationCode: 'V.171.QC.02', certificates: 2 })

    // The latest deleted (setup only): the instrument goes back to the one before.
    expect((await app.api('DELETE', `/api/calibration/certificates/${c.id}`, { token: writer.token })).status).toBe(403)
    expect((await app.api('DELETE', `/api/calibration/certificates/${c.id}`, { token: admin.token })).status).toBe(204)
    expect((await detail(i.id)).item).toMatchObject({ lastCalibratedOn: '2025-07-12', calibrationCode: 'V.171.QC.01', nextDueOn: '2026-07-12', certificates: 1 })
    expect((await app.api('GET', `/api/calibration/certificates/${c.id}`, { token: reader.token })).status).toBe(404)
  })

  it('keeps an outside laboratory’s certificate as its PDF', async () => {
    const i = (await postItem(item({ calibrationCode: '322/63C018/18/751/2025', name: 'Protractor', kind: 'external', lastCalibratedOn: '2025-02-19' }))).body
    expect((await upload(writer, Buffer.from('not a pdf'), 'x.pdf')).status).toBe(400)
    const file = (await upload(writer)).body
    expect(file).toMatchObject({ fileName: 'NIS certificate.pdf', byteSize: pdf.length })
    // Another person's upload is not theirs to attach.
    const theirs = (await upload(admin)).body
    expect((await postCert(certificate(i.id, { kind: 'external', fileId: theirs.id }))).status).toBe(403)
    const c = (await postCert(certificate(i.id, { kind: 'external', certificateNo: '322/63C018/18/751/2026', calibratedOn: '2026-02-19', body: 'المعهد القومى للمعايرة NIS', groups: [], fileId: file.id }))).body
    expect(c).toMatchObject({ result: 'no-readings', fileName: 'NIS certificate.pdf', readings: 0 })
    // The laboratory's number becomes the instrument's code, as the register writes it.
    expect((await detail(i.id)).item).toMatchObject({ calibrationCode: '322/63C018/18/751/2026', kind: 'external', nextDueOn: '2027-02-19' })
    const content = await fetch(`${app.baseUrl}/api/calibration/files/${file.id}/content`, { headers: { authorization: `Bearer ${reader.token}` } })
    expect(content.status).toBe(200)
    expect(content.headers.get('content-type')).toBe('application/pdf')
    expect(Buffer.from(await content.arrayBuffer()).equals(pdf)).toBe(true)
  })

  it('scraps an instrument with its day and reason, into the scrap log, and restores one scrapped by mistake', async () => {
    const i = (await postItem(item({ calibrationCode: 'V.25.WE.05', receivedOn: '2021-10-26' }))).body
    const scrap = (body: object, as = writer) => app.api<CalibrationItem & ApiErrorBody>('POST', `/api/calibration/items/${i.id}/scrap`, { token: as.token, body: { version: i.version, ...body } })
    expect((await scrap({ scrappedOn: '2025-10-25', reason: '' })).status).toBe(400)
    expect((await scrap({ scrappedOn: '2021-01-01', reason: 'Worn out' })).status).toBe(400)
    expect((await scrap({ scrappedOn: addMonths(today, 1), reason: 'Worn out' })).status).toBe(400)
    expect((await scrap({ scrappedOn: '2025-10-25', reason: 'Worn out' }, reader)).status).toBe(403)
    const done = await scrap({ scrappedOn: '2025-10-25', reason: 'Worn out', details: 'الفكين متآكلين' })
    expect(done.status, JSON.stringify(done.body)).toBe(200)
    expect(done.body).toMatchObject({ status: 'scrapped', workingDays: daysBetween('2021-10-26', '2025-10-25'), scrap: { scrappedOn: '2025-10-25', reason: 'Worn out', details: 'الفكين متآكلين', byName: 'calwriter' } })
    expect((await scrap({ scrappedOn: '2025-10-25', reason: 'again', version: done.body.version })).status).toBe(400)
    // Out of the plan, into the log; its code free for another instrument.
    expect((await list('')).items.map((x) => x.id)).not.toContain(i.id)
    expect((await list('view=scrap')).items.map((x) => x.id)).toEqual([i.id])
    expect((await list('status=scrapped')).items.map((x) => x.id)).toEqual([i.id])
    const history = (await detail(i.id)).history
    expect(history.find((h) => h.field === 'status')).toMatchObject({ oldValue: 'In service', newValue: 'Scrapped' })
    expect(history.find((h) => h.field === 'scrapReason')?.newValue).toBe('Worn out')
    const replacement = (await postItem(item({ calibrationCode: 'V.25.WE.05', deviceCode: 'NEW' }))).body
    // Restoring needs its code back.
    const restore = (as: Session, version = done.body.version) => app.api<CalibrationItem & ApiErrorBody>('POST', `/api/calibration/items/${i.id}/restore`, { token: as.token, body: { version } })
    expect((await restore(writer)).status).toBe(403)
    expect((await restore(admin)).status).toBe(409)
    expect((await app.api('DELETE', `/api/calibration/items/${replacement.id}`, { token: admin.token })).status).toBe(204)
    const back = await restore(admin)
    expect(back.body).toMatchObject({ scrap: null, workingDays: null })
    expect(back.body.status).not.toBe('scrapped')
  })

  it('keeps categories and departments, and refuses to remove one still in use', async () => {
    const made = await app.api<CalibrationCategory & ApiErrorBody>('POST', '/api/calibration/categories', { token: admin.token, body: {
      name: 'Height gauge', codePrefix: 'hg', intervalMonths: 15, kind: 'external', resolution: '0.01 mm', tolerance: 0.02, unit: 'mm',
      template: [{ name: 'Height', nominals: [100, 200, 300] }], reference: { name: 'Gauge blocks', manufacturer: '', serial: '', certificateNo: '', body: '' },
    } })
    expect(made.status, JSON.stringify(made.body)).toBe(201)
    expect(made.body).toMatchObject({ codePrefix: 'HG', intervalMonths: 15, template: [{ name: 'Height', nominals: [100, 200, 300] }] })
    expect((await app.api('POST', '/api/calibration/categories', { token: admin.token, body: { name: 'height gauge', intervalMonths: 12, kind: 'internal' } })).status).toBe(409)
    expect((await app.api('POST', '/api/calibration/categories', { token: admin.token, body: { name: 'Bad', codePrefix: 'TOOLONG', intervalMonths: 12, kind: 'internal' } })).status).toBe(400)
    const i = (await postItem(item({ categoryId: made.body.id, calibrationCode: 'HG.40.QC.01' }))).body
    expect((await app.api('DELETE', `/api/calibration/categories/${made.body.id}`, { token: admin.token })).status).toBe(400)
    expect((await app.api('DELETE', `/api/calibration/items/${i.id}`, { token: admin.token })).status).toBe(204)
    expect((await app.api('DELETE', `/api/calibration/categories/${made.body.id}`, { token: admin.token })).status).toBe(204)
    const dept = await app.api<{ id: string; code: string }>('POST', '/api/calibration/departments', { token: admin.token, body: { name: 'الزراعة', code: 'ag.01' } })
    expect(dept.body.code).toBe('AG.01')
    expect((await app.api('PUT', `/api/calibration/departments/${dept.body.id}`, { token: admin.token, body: { name: 'الزراعة', code: 'AGR' } })).status).toBe(200)
    expect((await app.api('DELETE', `/api/calibration/departments/${dept.body.id}`, { token: admin.token })).status).toBe(204)
  })

  it('imports the register, the certificates log and the scrap form, each again without doubling', async () => {
    const register = parseCalibrationRegister([
      ['خطة المعايرة وحصر اجهزة القياس'],
      ['م', 'القسم', 'اسم الجهاز', 'كود الجهاز', 'مستلم الجهاز', 'تاريخ الاستلام', 'نوع المعايرة', '', 'كود المعايرة', 'تاريخ اخر معايرة', 'تاريخ المعايرة القادمة', 'KPI'],
      ['1', 'البنش', 'باكوليس/ Vernier\n150mm', '014088278', 'جرجس موريس يوسف سعيد', '2022-10-25', 'داخلى 1', '', 'V.501.PU.01', '2026-09-16', '2027-09-16', 'متاح'],
      ['2', 'تنايات', 'باكوليس/ Vernier\n150mm', '3107190190', 'محمد احمد عوض نصار', '2021-10-26', 'داخلى 1', '', 'V.509.PB.03', '2025-11-26', '2026-11-26', 'هالك'],
      ['3', 'الجودة', 'شريط قياس صلب 10 M', 'BMI', 'ايمن رافت رفلة شنودة', '2021-10-26', 'داخلى 1', '', 'M.579.QC.01', '2026-09-20', '2026-12-20', 'متاح'],
      ['4', 'ورشة جديدة', 'Protractor زاوية قياس متحركة', '1306188101', 'محمد على مصطفى صالح', '2021-10-26', 'خارجي 1', '', '322/63C018/18/751/2099', '2026-02-19', '2027-02-19', 'متاح'],
      ['5', 'التنايات', 'شريط قياس صلب 5 M', 'APT', 'صبري علي سرحان جوده', '2024-06-02', 'داخلى 2', '', '', '', '', ''],
      ['', '', '', '', '', '', '', '', '', '', '', ''],
      ['Eng. Mohamed Mahmoud', 'Approved by:'],
    ])
    expect(register.rows).toHaveLength(5)
    const run = async (body: object) => (await app.api<CalibrationImportResult & ApiErrorBody>('POST', '/api/calibration/import', { token: admin.token, body })).body
    expect(await run({ kind: 'register', rows: register.rows })).toEqual({ created: 5, updated: 0, existing: 0, unmatched: 0 })
    expect(await run({ kind: 'register', rows: register.rows })).toEqual({ created: 0, updated: 0, existing: 5, unmatched: 0 })
    const imported = (await list('q=V.501.PU.01')).items[0]
    expect(imported).toMatchObject({ categoryName: vernier.name, departmentName: 'البنش', intervalMonths: 12, nextDueOn: '2027-09-16', source: 'import', notes: 'Register type: داخلى 1' })
    expect((await list('q=M.579.QC.01')).items[0]).toMatchObject({ intervalMonths: 3, nextDueOn: '2026-12-20' })
    // تنايات is التنايات; a department not in the configuration is added; departments take their instruments' codes.
    const o = (await app.api<CalibrationOptions>('GET', '/api/calibration/options', { token: reader.token })).body
    expect(o.departments.find((d) => d.name === 'التنايات')?.code).toBe('PB.03')
    expect(o.departments.find((d) => d.name === 'البنش')?.code).toBe('PU.01')
    expect(o.departments.some((d) => d.name === 'ورشة جديدة')).toBe(true)
    expect(o.departments.filter((d) => d.name.includes('تنايات'))).toHaveLength(1)
    const scrapped = (await list('view=scrap&q=V.509')).items[0]
    expect(scrapped).toMatchObject({ status: 'scrapped', scrap: { scrappedOn: null } })

    const certs = parseCalibrationCertificateLog([
      ['سجل شهادات المعايرة للباكوليس'],
      ['كود المعايرة', 'اسم الجهاز ', 'جهة الصنع ', 'المدى', 'قيمة  التدريجة ( Resolution )', 'تاريخ المعايرة ', 'تاريخ إعادة المعايرة ', 'القياسات الخارجية ', '', '', '', '', '', 'القياسات الداخلية', '', '', 'قياسات العمق'],
      ['', '', '', '', '', '', '', 'قيمة القالب', 'القراءة', 'الخطا', 'قيمة القالب', 'القراءة', 'الخطا'],
      ['V.501.PU.01', 'باكوليس/ Vernier 150mm', 'Insize', '150mm', '0.02 mm', '2027-09-01', '2028-09-01', '11.5', '11.55', '0.05', '40', '40.05', '0.05', '10', '10.05', '0.05', '10', '9.95', '-0.05'],
      ['V.999.XX.01', 'باكوليس', 'Insize', '150mm', '0.02 mm', '2025-09-01', '2026-09-01', '11.5', '11.5', '0'],
    ])
    expect(certs.rows[0].groups.map((g) => g.readings.length)).toEqual([2, 1, 1])
    expect(await run({ kind: 'certificates', rows: certs.rows })).toEqual({ created: 1, updated: 0, existing: 0, unmatched: 1 })
    expect(await run({ kind: 'certificates', rows: certs.rows })).toEqual({ created: 0, updated: 0, existing: 1, unmatched: 1 })
    const withCert = await detail(imported.id)
    expect(withCert.item).toMatchObject({ manufacturer: 'Insize', range: '150mm', resolution: '0.02 mm', lastCalibratedOn: '2027-09-01', certificates: 1 })
    expect(withCert.certificates[0]).toMatchObject({ source: 'import', readings: 4, maxError: 0.05, reference: { serial: 'LS 8076' } })

    const scrapLog = parseCalibrationScrapLog([
      ['تكهين العدة'],
      ['م', 'القسم', 'اسم الجهاز', 'مستلم الجهاز', 'تاريخ الإستلام', 'تاريخ التكهين', 'أيام العمل'],
      ['1', 'التنايات', 'باكوليس/ Vernier\n150mm', 'محمد احمد عوض نصار', '2021-10-26', '2025-10-25'],
      ['2', '', 'شريط قياس صلب 5 M', 'صبري علي سرحان جوده', '2024-06-02', '2025-09-18'],
      ['3', 'الجودة', 'باكوليس ديجيتال 150mm', 'ايمن رافت رفلة شنودة', '2022-10-25', '2025-07-22'],
      ['4'],
    ])
    expect(scrapLog.rows.map((r) => r.department)).toEqual(['التنايات', 'التنايات', 'الجودة'])
    expect(await run({ kind: 'scrap', rows: scrapLog.rows })).toEqual({ created: 1, updated: 2, existing: 0, unmatched: 0 })
    expect(await run({ kind: 'scrap', rows: scrapLog.rows })).toEqual({ created: 0, updated: 0, existing: 3, unmatched: 0 })
    expect((await list('view=scrap&q=V.509')).items[0]).toMatchObject({ scrap: { scrappedOn: '2025-10-25' }, workingDays: daysBetween('2021-10-26', '2025-10-25') })
    expect((await list('view=scrap&q=صبري')).items[0]).toMatchObject({ scrap: { scrappedOn: '2025-09-18', reason: 'Imported from the scrap form F-Q-05-03' } })
  })

  it('is read by the assistant as the screens read it', async () => {
    const [row] = await ai(`SELECT instrument, category, department, status, next_due_on::text AS next, interval_months, certificates, scrapped FROM ai.calibration_items WHERE calibration_code = 'V.501.PU.01'`)
    expect(row).toEqual(['باكوليس/ Vernier 150mm', vernier.name, 'البنش', calibrationStatus({ nextDueOn: '2028-09-01', scrapped: false }, today), '2028-09-01', 12, 1, false])
    const scrapped = await ai(`SELECT scrap_reason, working_days FROM ai.calibration_items WHERE scrapped AND scrapped_on = '2025-10-25' AND calibration_code = 'V.509.PB.03'`)
    expect(scrapped).toEqual([['Imported from the scrap form F-Q-05-03', daysBetween('2021-10-26', '2025-10-25')]])
    const readings = await ai(`SELECT r.group_no, r.reading_no, r.nominal, r.reading, r.error FROM ai.calibration_readings r JOIN ai.calibration_certificates c USING (calibration_certificate_id)
      WHERE c.certificate_no = 'V.501.PU.01' ORDER BY 1, 2`)
    expect(readings).toEqual([[1, 1, 11.5, 11.55, 0.05], [1, 2, 40, 40.05, 0.05], [2, 1, 10, 10.05, 0.05], [3, 1, 10, 9.95, -0.05]])
    const [external] = await ai(`SELECT kind, has_pdf, result FROM ai.calibration_certificates WHERE certificate_no = '322/63C018/18/751/2026'`)
    expect(external).toEqual(['external', true, 'no-readings'])
  })
})
