import { describe, expect, it } from 'vitest'
import {
  addMonths, calibrationStatus, codeDepartment, codeNumber, daysBetween, groupsFromTemplate, intervalLabel, judgeCertificate, monthsBetween, nameKey, nextDueOn,
  parseCalibrationCertificateLog, parseCalibrationRegister, parseCalibrationScrapLog, readingError, readingOk, suggestCode, workingDays,
} from './calibration'

describe('§27 calibration days', () => {
  it('adds months as PostgreSQL does: the month’s last day when it is shorter', () => {
    expect(addMonths('2025-09-01', 12)).toBe('2026-09-01')
    expect(addMonths('2025-01-31', 1)).toBe('2025-02-28')
    expect(addMonths('2024-01-31', 1)).toBe('2024-02-29')
    expect(addMonths('2024-02-29', 12)).toBe('2025-02-28')
    expect(addMonths('2025-11-30', 3)).toBe('2026-02-28')
    expect(addMonths('2025-12-15', -13)).toBe('2024-11-15')
    expect(addMonths('nope', 1)).toBe('')
  })

  it('works the next calibration out from the last and the interval, and nothing without them', () => {
    expect(nextDueOn('2026-04-15', 15)).toBe('2027-07-15')
    expect(nextDueOn('2026-04-15', 18)).toBe('2027-10-15')
    expect(nextDueOn(null, 12)).toBeNull()
    expect(nextDueOn('2026-04-15', 0)).toBeNull()
    expect(intervalLabel(12)).toBe('1 year')
    expect(intervalLabel(15)).toContain('15 months')
    expect(intervalLabel(36)).toBe('3 years')
    expect(intervalLabel(5)).toBe('5 months')
  })

  it('reads an instrument’s status on a day', () => {
    const today = '2026-10-29'
    expect(calibrationStatus({ nextDueOn: '2026-10-28', scrapped: false }, today)).toBe('overdue')
    expect(calibrationStatus({ nextDueOn: '2026-10-29', scrapped: false }, today)).toBe('due-soon')
    expect(calibrationStatus({ nextDueOn: '2026-11-28', scrapped: false }, today)).toBe('due-soon')
    expect(calibrationStatus({ nextDueOn: '2026-11-29', scrapped: false }, today)).toBe('valid')
    expect(calibrationStatus({ nextDueOn: null, scrapped: false }, today)).toBe('no-date')
    expect(calibrationStatus({ nextDueOn: '2020-01-01', scrapped: true }, today)).toBe('scrapped')
    expect(daysBetween(today, '2026-11-28')).toBe(30)
  })

  it('counts the days in use before scrapping, and the months between the plan’s two dates', () => {
    expect(workingDays('2021-10-26', '2025-10-25')).toBe(1460)
    expect(workingDays('2025-10-26', '2025-10-25')).toBeNull()
    expect(workingDays(null, '2025-10-25')).toBeNull()
    expect(monthsBetween('2026-09-20', '2026-12-20')).toBe(3)
    expect(monthsBetween('2025-06-04', '2026-06-04')).toBe(12)
    expect(monthsBetween('2025-01-31', '2025-02-28')).toBe(1)
    expect(monthsBetween('2026-01-01', '2026-01-01')).toBeNull()
  })
})

describe('§27 calibration codes', () => {
  it('reads the plan’s codes and suggests the next', () => {
    expect(codeNumber('V.171.QC.02')).toBe(171)
    expect(codeDepartment('V.171.QC.02')).toBe('QC.02')
    expect(codeDepartment('V-06-WE-03')).toBe('WE.03')
    expect(codeNumber('322/63C018/18/751/2026')).toBeNull()
    expect(suggestCode('v', 7, 'qc.01')).toBe('V.07.QC.01')
    expect(suggestCode('MI', 372, '')).toBe('MI.372')
    expect(suggestCode('', 3, 'QC')).toBe('')
  })

  it('compares names as the workbooks write them', () => {
    expect(nameKey('تنايات')).toBe(nameKey('التنايات'))
    expect(nameKey('ماكينةالسحب')).toBe(nameKey('ماكينة السحب'))
    expect(nameKey('الدهان ')).toBe(nameKey('دهان'))
    expect(nameKey('باكوليس/ Vernier\n150mm')).toBe(nameKey('باكوليس / vernier 150MM'))
    expect(nameKey('الجودة')).not.toBe(nameKey('اللحام'))
  })
})

describe('§27 a certificate’s readings', () => {
  const groups = [
    { name: 'External', readings: [{ nominal: 11.5, reading: 11.52 }, { nominal: 40, reading: 40.02 }] },
    { name: 'Internal', readings: [{ nominal: 10, reading: 9.97 }, { nominal: 100, reading: null }] },
  ]
  it('works each error out without float noise, and judges them against the tolerance', () => {
    expect(readingError({ nominal: 11.5, reading: 11.52 })).toBe(0.02)
    expect(readingError({ nominal: 10, reading: null })).toBeNull()
    expect(readingOk({ nominal: 70, reading: 70.02 }, 0.02)).toBe(true)
    expect(readingOk({ nominal: 70, reading: 70.03 }, 0.02)).toBe(false)
    expect(readingOk({ nominal: 70, reading: 70.03 }, null)).toBeNull()
    expect(judgeCertificate(groups, 0.03)).toEqual({ readings: 3, maxError: -0.03, result: 'pass' })
    expect(judgeCertificate(groups, 0.02).result).toBe('fail')
    expect(judgeCertificate(groups, null).result).toBe('no-tolerance')
    expect(judgeCertificate([], 0.02)).toEqual({ readings: 0, maxError: null, result: 'no-readings' })
  })

  it('starts a certificate from its category’s template', () => {
    expect(groupsFromTemplate([{ name: 'Depth', nominals: [10, 50] }])).toEqual([{ name: 'Depth', readings: [{ nominal: 10, reading: null }, { nominal: 50, reading: null }] }])
  })
})

describe('§27 the old workbooks', () => {
  it('reads the register wherever its columns are, its foot left out', () => {
    const { rows, skipped } = parseCalibrationRegister([
      ['خطة المعايرة وحصر اجهزة القياس', '', 'LinkMisr International'],
      ['م  ', 'القسم', 'اسم الجهاز', 'كود الجهاز', 'مستلم الجهاز', 'تاريخ الاستلام', 'نوع المعايرة', '', 'كود المعايرة', 'تاريخ اخر معايرة', 'تاريخ المعايرة القادمة', 'KPI'],
      ['1', 'البنش', 'باكوليس/ Vernier\n150mm', '014088278', 'جرجس موريس', '2022-10-25', 'داخلى 1', '', 'V.01.PU.01', '2026-09-16', '2027-09-16', 'متاح'],
      ['3', 'تنايات', 'شريط قياس صلب 5 M', 'APT', 'محمد', '44834', 'خارجي 2', '', 'M.48.PB.03', '2026-03-01', '2026-06-01', 'هالك'],
      ['4', 'QA', 'Gauge Blocks set', 'LS 8076', 'يوسف', '', 'خارجي', '', '322/63C007/12/661/2026', '2026-02-16', '', 'متاح'],
      ['', '', 'اسم الجهاز'],
      ['', 'Form Code:', '', '', '', '', '', '', 'F-Q-05-01'],
    ])
    expect(skipped).toBe(1)
    expect(rows).toEqual([
      { department: 'البنش', name: 'باكوليس/ Vernier 150mm', deviceCode: '014088278', holder: 'جرجس موريس', receivedOn: '2022-10-25', kind: 'internal', calibrationCode: 'V.01.PU.01',
        lastCalibratedOn: '2026-09-16', intervalMonths: 12, scrapped: false, notes: 'Register type: داخلى 1' },
      { department: 'تنايات', name: 'شريط قياس صلب 5 M', deviceCode: 'APT', holder: 'محمد', receivedOn: '2022-09-30', kind: 'external', calibrationCode: 'M.48.PB.03',
        lastCalibratedOn: '2026-03-01', intervalMonths: 3, scrapped: true, notes: 'Register type: خارجي 2' },
      { department: 'QA', name: 'Gauge Blocks set', deviceCode: 'LS 8076', holder: 'يوسف', receivedOn: null, kind: 'external', calibrationCode: '322/63C007/12/661/2026',
        lastCalibratedOn: '2026-02-16', intervalMonths: 12, scrapped: false, notes: '' },
    ])
    expect(parseCalibrationRegister([['nothing', 'here']])).toEqual({ rows: [], skipped: 0 })
  })

  it('reads the certificates log’s readings in threes under their groups', () => {
    const { rows } = parseCalibrationCertificateLog([
      ['كود المعايرة', 'اسم الجهاز ', 'كود الجهاز ', 'جهة الصنع ', 'المدى', 'قيمة  التدريجة ( Resolution )', 'تاريخ المعايرة ', 'تاريخ إعادة المعايرة ', 'القياسات الخارجية ', '', '', '', '', '', 'قياسات العمق'],
      ['V.01.PU.02', 'باكوليس', 'X', 'Insize', '150mm', '0.02 mm', '2025-09-01', '2026-09-01', '11.5', '11.55', '0.05', '40', '', '', '10', '9.95', '-0.05'],
      ['', 'no code', '', '', '', '', '2025-09-01'],
    ])
    expect(rows).toEqual([{
      calibrationCode: 'V.01.PU.02', name: 'باكوليس', manufacturer: 'Insize', range: '150mm', resolution: '0.02 mm', calibratedOn: '2025-09-01', intervalMonths: 12,
      groups: [
        { name: 'القياسات الخارجية / External Measurements', readings: [{ nominal: 11.5, reading: 11.55 }, { nominal: 40, reading: null }] },
        { name: 'قياسات العمق / Depth Measurements', readings: [{ nominal: 10, reading: 9.95 }] },
      ],
    }])
  })

  it('reads the scrap form, the department carried down its merged cells', () => {
    const { rows, skipped } = parseCalibrationScrapLog([
      ['م', 'القسم', 'اسم الجهاز', 'مستلم الجهاز', 'تاريخ الإستلام', 'تاريخ التكهين', 'أيام العمل'],
      ['1', 'البناطة', 'باكوليس', 'محمد', '2021-10-26', '2025-10-25'],
      ['2', '', 'شريط', 'صبري', '2024-06-02', '2025-09-18'],
      ['3', '', 'شريط', 'صبري', '2024-06-02', ''],
      ['4'],
    ])
    expect(skipped).toBe(1)
    expect(rows).toEqual([
      { department: 'البناطة', name: 'باكوليس', holder: 'محمد', receivedOn: '2021-10-26', scrappedOn: '2025-10-25' },
      { department: 'البناطة', name: 'شريط', holder: 'صبري', receivedOn: '2024-06-02', scrappedOn: '2025-09-18' },
    ])
  })
})
