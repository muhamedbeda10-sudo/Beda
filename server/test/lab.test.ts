import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { emptyLabTest, judge, type LabCoilLookup, type LabGrade, type LabImportResult, type LabOptions, type LabTest, type LabTestData, type LabTestList, type LabLogRow } from '@qc/shared/lab'
import type { ApiErrorBody } from '@qc/shared/api'
import { runReadOnlyQuery } from '../src/ai/runQuery'
import { TestApp, type Session } from './harness'

// §26 — the lab: the material testing report and the machine log as one
// record; the grade's limits by thickness, judged on every specimen; the coil
// register behind a sheet's specimen code; the log's workbook imported.

const app = new TestApp()
let admin: Session, writer: Session, reader: Session, outsider: Session
const day = '2026-07-16'

const test = (patch: Partial<LabTestData> = {}): LabTestData => ({
  ...emptyLabTest(day, 'Awny Erian', 'GALDABINI - Quasar 200 T'),
  specimenType: 'Black Sheet', specimenCode: '456596-0-0-0', size: '2.4 mm', grade: 'S420MC', certificate: 'Link Misr 06-07-2025 ezz', cusNo: '20121',
  specimens: [{ tensile: 511.7, yield: 423.6, elongation: 31.6 }, { tensile: 509.5, yield: 408.9, elongation: 33.2 }, { tensile: 510.8, yield: 405.7, elongation: 25.1 }],
  indenter: '120° Diamond Indenter', hardnessScale: 'HRC', hardness: 2, mtcTensile: 524, mtcYield: 430, mtcElongation: 23,
  ...patch,
})
const post = (data: LabTestData, as = writer, submissionId: string = randomUUID()) => app.api<LabTest & ApiErrorBody>('POST', '/api/lab', { token: as.token, body: { ...data, submissionId } })
const put = (t: LabTest, patch: Partial<LabTestData> = {}, as = writer) => app.api<LabTest & ApiErrorBody>('PUT', `/api/lab/${t.id}`, { token: as.token, body: { ...t, ...patch, version: t.version } })
const ai = async (sql: string) => {
  const res = await runReadOnlyQuery(app.aiReader.poolFor(['materials'])!, sql, { maxRows: 100, timeoutMs: 10_000, timeZone: app.config.FACTORY_TIMEZONE })
  if (!res.ok) throw new Error(res.error)
  return res.rows
}

beforeAll(async () => {
  await app.start(); await app.resetDatabase()
  admin = await app.register('admin', 'Administrator')
  const sessions: Session[] = []
  for (const [username, role] of [['labwriter', 'supervisor'], ['labreader', 'inspector'], ['outsider', 'viewer']] as const) {
    expect((await app.api('POST', '/api/users', { token: admin.token, body: { username, password: 'Password#1', name: username, role } })).status).toBe(201)
    sessions.push(await app.login(username))
  }
  ;[writer, reader, outsider] = sessions
  expect((await app.api('POST', '/api/coils/import', { token: admin.token, body: { rows: [{ coilNumber: '456596-0-0-0', grade: 'S420MC', supplier: 'Ezz Steel', thickness: 2.4, yield: 430 }] } })).status).toBe(200)
})
afterAll(() => app.stop())

describe('§26 the lab', () => {
  it('opens to whoever may see the Lab, records for whoever may record, and sets up for administrators', async () => {
    for (const path of ['/api/lab', '/api/lab/options', `/api/lab/${randomUUID()}`, '/api/lab/coil?number=1']) expect((await app.api('GET', path, { token: outsider.token })).status).toBe(403)
    expect((await app.api<LabOptions>('GET', '/api/lab/options', { token: reader.token })).status).toBe(200)
    expect((await post(test(), reader)).status).toBe(403)
    expect((await app.api('POST', '/api/lab/grades', { token: writer.token, body: { family: 'wire', grade: 'FE360' } })).status).toBe(403)
    expect((await app.api('POST', '/api/lab/import', { token: writer.token, body: { rows: [] } })).status).toBe(403)
  })

  it('offers the workbook’s lists and grades, and the next number', async () => {
    const options = (await app.api<LabOptions>('GET', '/api/lab/options', { token: writer.token })).body
    expect(options.lists.filter((l) => l.list === 'sheet-thickness').map((l) => l.value)).toContain('2.4 mm')
    expect(options.lists.filter((l) => l.list === 'bolt-size').map((l) => l.value)).toEqual(['M8', 'M10', 'M12', 'M16'])
    expect(options.lists.find((l) => l.list === 'machine')?.value).toBe('GALDABINI - Quasar 200 T')
    expect(options.grades.filter((g) => g.grade === 'S420MC').map((g) => [g.thicknessFrom, g.thicknessTo, g.elongationMin])).toEqual([[null, 3], [3, null]].map(([a, b], i) => [a, b, [16, 19][i]]))
    expect(options.nextReference).toBe(`1-${String(new Date().getFullYear() % 100)}`)
  })

  it('finds a sheet’s coil in the register', async () => {
    const found = (await app.api<LabCoilLookup>('GET', '/api/lab/coil?number=456596-0-0-0', { token: writer.token })).body
    expect(found.coil).toMatchObject({ coilNumber: '456596-0-0-0', grade: 'S420MC', supplier: 'Ezz Steel', thickness: 2.4, yield: 430 })
    expect(found.tests).toEqual([])
    expect((await app.api<LabCoilLookup>('GET', '/api/lab/coil?number=nope', { token: writer.token })).body.coil).toBeNull()
  })

  it('records the report: its number, standards, the band’s limits, averages and verdict, as the screen works them out', async () => {
    const res = await post(test())
    expect(res.status, JSON.stringify(res.body)).toBe(201)
    const t = res.body
    expect(t.reference).toBe('1-26')
    expect(t).toMatchObject({ testStandard: 'EN 10002-1', materialStandard: 'EN 10149-2-2013', thickness: 2.4, coilFound: true, source: 'app', form: { code: 'F-Q-02-20' } })
    expect(t.limits).toEqual({ yieldMin: 420, yieldMax: null, tensileMin: 480, tensileMax: 620, elongationMin: 16 })
    // 405.7 and 408.9 are under 420: the test fails on yield though its average (412.73) is the only figure the log kept.
    const screen = judge(t.specimens, t.limits)
    expect({ tensileAvg: t.tensileAvg, yieldAvg: t.yieldAvg, elongationAvg: t.elongationAvg, tensileOk: t.tensileOk, yieldOk: t.yieldOk, elongationOk: t.elongationOk, result: t.result }).toEqual(screen)
    expect(t).toMatchObject({ tensileAvg: 510.67, yieldAvg: 412.73, elongationAvg: 29.97, tensileOk: true, yieldOk: false, elongationOk: true, result: 'fail' })
    expect(t.specimens).toHaveLength(3)
    const coil = (await app.api<LabCoilLookup>('GET', '/api/lab/coil?number=456596-0-0-0', { token: reader.token })).body
    expect(coil.tests).toEqual([{ id: t.id, reference: '1-26', testDate: day, result: 'fail' }])
    expect((await app.api('GET', '/api/lab/by-coils?numbers=456596-0-0-0,NONE', { token: reader.token })).body).toEqual([{ coilNumber: '456596-0-0-0', id: t.id, reference: '1-26', testDate: day, result: 'fail' }])
  })

  it('takes a thick sheet’s band, a bolt’s grade, and leaves a grade it does not know unjudged', async () => {
    const thick = (await post(test({ specimenCode: 'T-1', size: '3 mm', specimens: [{ tensile: 500, yield: 430, elongation: 18 }] }))).body
    expect(thick.limits.elongationMin).toBe(19)
    expect(thick.result).toBe('fail')
    const bolt = (await post(test({ specimenType: 'Bolt', specimenCode: 'KB-10*90', size: 'M10', grade: '8.8', specimens: [{ tensile: 1013, yield: 959.3, elongation: 5.5 }, { tensile: null, yield: null, elongation: null }] }))).body
    expect(bolt).toMatchObject({ testStandard: 'ISO 898-1', materialStandard: 'ISO 898-1', thickness: null, hardnessSpec: '22-32', result: 'fail', elongationOk: false, tensileOk: true })
    expect(bolt.specimens.filter((s) => s.tensile !== null)).toHaveLength(1)
    const wire = (await post(test({ specimenType: 'Wire', specimenCode: 'W-1', size: '4.3 mm', grade: 'FE360', specimens: [{ tensile: 702.1, yield: 655.7, elongation: 14.6 }] }))).body
    expect(wire).toMatchObject({ testStandard: '', thickness: 4.3, result: 'no-limits', limits: { yieldMin: null, tensileMin: null } })
    const empty = (await post(test({ specimenCode: 'E-1', specimens: [] }))).body
    expect(empty.result).toBe('no-results')
  })

  it('finds a coil’s grade through the configuration’s equivalences', async () => {
    expect((await app.api('POST', '/api/master/grade-mappings', { token: admin.token, body: { gradeA: 'S420', gradeB: 'S420MC' } })).status).toBe(201)
    const t = (await post(test({ specimenCode: 'EQ-1', grade: 'S420', specimens: [{ tensile: 560, yield: 470, elongation: 21 }] }))).body
    expect(t).toMatchObject({ materialStandard: 'EN 10149-2-2013', result: 'pass' })
  })

  it('is saved once for a submission, refuses its number twice, and continues the year’s numbers after one written by hand', async () => {
    const id = randomUUID()
    const first = await post(test({ specimenCode: 'IDEM' }), writer, id)
    const again = await post(test({ specimenCode: 'IDEM' }), writer, id)
    expect([first.status, again.status]).toEqual([201, 200])
    expect(again.body.id).toBe(first.body.id)
    expect((await post(test({ specimenCode: 'OTHER' }), writer, id)).status).toBe(409)
    expect((await post(test({ reference: first.body.reference }))).status).toBe(409)
    expect((await post(test({ reference: '93-26' }))).body.reference).toBe('93-26')
    expect((await post(test())).body.reference).toBe('94-26')
  })

  it('keeps the limits it was judged by until its grade, size or type changes; audits each correction; refuses a stale one', async () => {
    const t = (await post(test({ specimenCode: 'KEEP' }))).body
    const grades = (await app.api<LabOptions>('GET', '/api/lab/options', { token: admin.token })).body.grades
    const band = grades.find((g) => g.grade === 'S420MC' && g.thicknessTo === 3)!
    const changed = await app.api<LabGrade>('PUT', `/api/lab/grades/${band.id}`, { token: admin.token, body: { ...band, yieldMin: 400 } })
    expect(changed.status, JSON.stringify(changed.body)).toBe(200)
    const notes = await put(t, { notes: 'Re-checked' })
    expect(notes.status, JSON.stringify(notes.body)).toBe(200)
    expect(notes.body).toMatchObject({ notes: 'Re-checked', version: 1, limits: { yieldMin: 420 }, result: 'fail' })
    const regraded = (await put(notes.body, { size: '2.5 mm' })).body
    expect(regraded).toMatchObject({ limits: { yieldMin: 400 }, result: 'pass', version: 2 })
    const fixed = (await put(regraded, { specimens: [{ tensile: 700, yield: 450, elongation: 20 }] })).body
    expect(fixed).toMatchObject({ tensileOk: false, result: 'fail', tensileAvg: 700 })
    expect((await put(notes.body, { notes: 'stale' })).status).toBe(409)
    const moved = await put(fixed, { specimens: [{ tensile: null, yield: null, elongation: null }, { tensile: 700, yield: 450, elongation: 20 }] })
    expect(moved.body.version).toBe(fixed.version + 1)
    expect((await ai(`SELECT s.specimen_no FROM ai.lab_test_specimens s WHERE s.lab_test_id = '${t.id}'`))).toEqual([[2]])
    const unchanged = await put(moved.body)
    expect(unchanged.body.version).toBe(moved.body.version)
    const fields = (await app.db.query<{ field: string }>(`SELECT field FROM audit_log WHERE entity = 'LabTest' AND entity_id = $1 AND action = 'update'`, [t.id])).rows.map((e) => e.field)
    expect(fields).toEqual(expect.arrayContaining(['notes', 'size', 'limits', 'specimens']))
    await app.api('PUT', `/api/lab/grades/${band.id}`, { token: admin.token, body: { ...band } })
  })

  it('reads the curve’s image for whoever may see the Lab', async () => {
    const t = (await app.api<LabTestList>('GET', '/api/lab?q=456596', { token: reader.token })).body
    expect(t.tests.length).toBeGreaterThan(0)
    expect(t.tests.every((x) => x.specimens.length === 0)).toBe(true)
    const filtered = (await app.api<LabTestList>('GET', '/api/lab?result=no-limits&specimenType=Wire', { token: reader.token })).body
    expect(filtered.tests.map((x) => x.specimenCode)).toEqual(['W-1'])
  })

  it('imports the machine log: each row once, its averages as one specimen, the year’s numbers after the last', async () => {
    const row = (reference: string, patch: Partial<LabLogRow> = {}): LabLogRow => ({
      reference, testDate: '2025-05-28', specimenType: 'Black Sheet', specimenCode: '445869-0-0-10', size: '1.5', grade: 'S315MC', tensile: 509, yield: 434.6, elongation: 35,
      hardness: 11, certificate: '2025-02-27', cusNo: '', testedBy: 'Awny Erian', notes: '', mtcTensile: 484, mtcYield: 403, mtcElongation: 24, ...patch,
    })
    const first = await app.api<LabImportResult>('POST', '/api/lab/import', { token: admin.token, body: { rows: [row('132-25'), row('133-25', { grade: 'Black', yield: null })] } })
    expect(first.status, JSON.stringify(first.body)).toBe(200)
    expect(first.body).toEqual({ created: 2, existing: 0 })
    expect((await app.api<LabImportResult>('POST', '/api/lab/import', { token: admin.token, body: { rows: [row('132-25'), row('134-25')] } })).body).toEqual({ created: 1, existing: 1 })
    const list = (await app.api<LabTestList>('GET', '/api/lab?from=2025-01-01&to=2025-12-31', { token: reader.token })).body
    expect(list.total).toBe(3)
    const imported = list.tests.find((t) => t.reference === '132-25')!
    expect(imported).toMatchObject({ source: 'log-import', tensileAvg: 509, limits: { elongationMin: 20 }, result: 'pass', mtcYield: 403 })
    expect(list.tests.find((t) => t.reference === '133-25')!.result).toBe('no-limits')
    expect((await post(test({ testDate: '2025-06-01' }))).body.reference).toBe('135-25')
  })

  it('is read by the assistant, its figures as the screen shows them, joined to the coil register', async () => {
    const rows = await ai(`SELECT reference, coil_number, supplier, result, yield_avg, yield_vs_mtc, specimens FROM ai.lab_tests WHERE reference = '1-26'`)
    expect(rows).toEqual([['1-26', '456596-0-0-0', 'Ezz Steel', 'fail', 412.73, -17.27, 3]])
    const specimens = await ai(`SELECT s.specimen_no, s.yield_ok FROM ai.lab_test_specimens s JOIN ai.lab_tests t USING (lab_test_id) WHERE t.reference = '1-26' ORDER BY 1`)
    expect(specimens).toEqual([[1, true], [2, false], [3, false]])
    expect((await ai(`SELECT count(*) FROM ai.lab_grade_limits WHERE family = 'bolt'`))[0][0]).toBe(6)
  })

  it('deletes a test for whoever sets the lab up, keeping it out of every list and of the assistant', async () => {
    const t = (await post(test({ specimenCode: 'GONE' }))).body
    expect((await app.api('DELETE', `/api/lab/${t.id}`, { token: writer.token })).status).toBe(403)
    expect((await app.api('DELETE', `/api/lab/${t.id}`, { token: admin.token })).status).toBe(204)
    expect((await app.api('GET', `/api/lab/${t.id}`, { token: admin.token })).status).toBe(404)
    expect((await ai(`SELECT count(*) FROM ai.lab_tests WHERE specimen_code = 'GONE'`))[0][0]).toBe(0)
    // Its number may be given again.
    const again = await post(test({ specimenCode: 'GONE', reference: t.reference }))
    expect(again.status, JSON.stringify(again.body)).toBe(201)
  })

  it('keeps the setup’s lists: a value once, removed when asked', async () => {
    const added = await app.api<{ id: string }>('POST', '/api/lab/lists', { token: admin.token, body: { list: 'bolt-size', value: 'M20' } })
    expect(added.status).toBe(201)
    expect((await app.api('POST', '/api/lab/lists', { token: admin.token, body: { list: 'bolt-size', value: 'm20' } })).status).toBe(409)
    expect((await app.api('DELETE', `/api/lab/lists/${added.body.id}`, { token: admin.token })).status).toBe(204)
    const grade = await app.api<LabGrade>('POST', '/api/lab/grades', { token: admin.token, body: { family: 'wire', grade: 'FE360', standard: '', thicknessFrom: null, thicknessTo: null, yieldMin: 360, yieldMax: null, tensileMin: null, tensileMax: null, elongationMin: null, hardness: '' } })
    expect(grade.status, JSON.stringify(grade.body)).toBe(201)
    expect((await app.api('POST', '/api/lab/grades', { token: admin.token, body: { family: 'sheet', grade: 'X', tensileMin: 600, tensileMax: 500 } })).status).toBe(400)
  })
})
