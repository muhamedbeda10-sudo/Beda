// ============================================================================
// §27 — A calibration certificate drawn as the paper (the certificates log's
// "الشهادة" sheet), in Arabic and English as it is written: the letterhead,
// the certificate's number and days, the device's data, the reference it was
// checked against, the readings by group with their errors, and who
// calibrated and approved it. Read on screen (mode "view") or printed alone
// on an A4 page (mode "paper"); an external calibration names its laboratory
// and the PDF kept with it.
// ============================================================================

import type { ReactNode } from 'react'
import { CALIBRATION_KIND_NAMES, CERTIFICATE_RESULT_NAMES, intervalLabel, readingError, readingOk, type CalibrationCertificate } from '@qc/shared/calibration'
import { cn } from '@/lib/utils'
import { calDay } from './common'

const border = 'border border-slate-400 dark:border-slate-600'
const headCell = (tight: boolean) => cn(border, 'bg-slate-50 px-2 font-bold text-slate-900 dark:bg-slate-800/70 dark:text-slate-100', tight ? 'py-0.5 text-[11px]' : 'py-1.5 text-[12px]')
const bodyCell = (tight: boolean) => cn(border, 'px-2 text-slate-900 dark:text-slate-100', tight ? 'py-0.5 text-[11.5px]' : 'py-1.5 text-sm')
const band = cn(border, 'bg-yellow-300 px-2 py-1 text-center text-sm font-bold text-slate-900')

/** A label in both languages: Arabic first, as the paper writes it. */
const Both = ({ ar, en }: { ar: string; en: string }) => <span><span dir="rtl" lang="ar">{ar}</span> / {en}</span>
const fmt = (v: number | null) => (v === null ? '' : String(v))

export function CertificateSheet({ cert, mode }: { cert: CalibrationCertificate; mode: 'view' | 'paper' }) {
  // On paper the certificate keeps to one A4 page: tighter rows.
  const head = headCell(mode === 'paper')
  const cell = bodyCell(mode === 'paper')
  const value = (v: string | null | undefined) => (v ? <span dir="auto">{v}</span> : <span className="text-muted">—</span>)
  const unit = cert.unit ? ` (${cert.unit})` : ''
  const pair = (label: ReactNode, v: ReactNode) => <>
    <div className={cn(head, 'col-span-2 flex items-center sm:col-span-1')}>{label}</div>
    <div className={cn(cell, 'col-span-2 flex items-center sm:col-span-1')}>{v}</div>
  </>
  return <div className={cn('calibration-sheet text-slate-900 dark:text-slate-100', mode === 'paper' ? 'w-full text-[13px]' : 'mx-auto w-full max-w-[860px]')}>
    <div className="grid grid-cols-[1fr_2fr_1fr] items-stretch">
      <div className={cn(border, 'flex flex-col justify-center px-2 py-3 text-sm font-bold')}><span>Quality Department</span><span dir="rtl" lang="ar" className="text-xs font-semibold">إدارة الجودة</span></div>
      <div className={cn(border, 'flex flex-col items-center justify-center px-2 py-3 text-center')}>
        <h2 className="text-lg font-bold sm:text-xl"><span dir="rtl" lang="ar">شهادة معايرة</span> / Calibration Certificate</h2>
        <span className="text-xs text-muted">{CALIBRATION_KIND_NAMES[cert.kind]} calibration</span>
      </div>
      <div className={cn(border, 'flex items-center justify-center p-2')}><span className="rounded bg-white p-1"><img src="/brand/logo.svg" alt="Link Misr" className="h-8 w-auto max-w-full sm:h-10" /></span></div>
    </div>
    <div className="grid grid-cols-2 sm:grid-cols-4">
      {pair(<Both ar="رقم الشهادة" en="Certificate No" />, <span dir="ltr" className="font-semibold">{cert.certificateNo || '—'}</span>)}
      {pair(<Both ar="تاريخ المعايرة" en="Calibration Date" />, calDay(cert.calibratedOn))}
      {pair(<Both ar="تاريخ إعادة المعايرة" en="Re-Calibration Date" />, <span className="font-semibold">{calDay(cert.nextDueOn)}</span>)}
      {pair(<Both ar="فترة المعايرة" en="Interval" />, intervalLabel(cert.intervalMonths))}
    </div>

    <div className={band}><Both ar="بيانات الجهاز" en="Device Data" /></div>
    <div className="grid grid-cols-2 sm:grid-cols-4">
      {pair(<Both ar="اسم الجهاز" en="Device Name" />, value(cert.item.name))}
      {pair(<Both ar="قيمة التدريجة" en="Scale Value" />, value(cert.resolution))}
      {pair(<Both ar="جهة الصنع" en="Manufacturer" />, value(cert.item.manufacturer))}
      {pair(<Both ar="التجاوز المسموح (±)" en="Allowed tolerance" />, cert.tolerance === null ? value('') : `± ${cert.tolerance}${cert.unit ? ` ${cert.unit}` : ''}`)}
      {pair(<Both ar="كود الجهاز" en="Device Code" />, value(cert.item.deviceCode))}
      {pair(<Both ar="كود المعايرة" en="Calibration Code" />, <span dir="ltr">{cert.item.calibrationCode || '—'}</span>)}
      {pair(<Both ar="المدى" en="Device Range" />, value(cert.item.range))}
      {pair(<Both ar="القسم / المستلم" en="Department / Holder" />, value([cert.item.departmentName, cert.item.holder].filter(Boolean).join(' · ')))}
    </div>

    {cert.kind === 'external' && <>
      <div className={band}><Both ar="جهة المعايرة" en="Calibration Body" /></div>
      <div className="grid grid-cols-2 sm:grid-cols-4">
        {pair(<Both ar="المعمل" en="Laboratory" />, value(cert.body))}
        {pair(<Both ar="الشهادة الأصلية" en="Laboratory certificate" />, cert.fileName ? <span dir="auto">{cert.fileName} (PDF)</span> : value(''))}
      </div>
    </>}

    {(cert.kind === 'internal' || Object.values(cert.reference).some(Boolean)) && <>
      <div className={band}><Both ar="بيانات المرجــع" en="Reference Data" /></div>
      <div className="grid grid-cols-2 sm:grid-cols-4">
        {pair(<Both ar="اسم المرجع" en="Reference Name" />, value(cert.reference.name))}
        {pair(<Both ar="جهة الصنع" en="Manufacturer" />, value(cert.reference.manufacturer))}
        {pair(<Both ar="رقم العلبة" en="Serial No" />, value(cert.reference.serial))}
        {pair(<Both ar="شهادة معايرة رقم" en="Calibration Certificate No" />, value(cert.reference.certificateNo))}
        {pair(<Both ar="جهة المعايرة" en="Calibration Body" />, value(cert.reference.body))}
      </div>
    </>}

    {cert.groups.length > 0 && <>
      <div className={band}><Both ar="نتائج المعايرة" en="Calibration Results" /></div>
      {cert.groups.map((g, gi) => <div key={gi} className="break-inside-avoid">
        <div className={cn(head, 'text-center text-sm')} dir="auto">{g.name || `Group ${gi + 1}`}</div>
        <div className="grid grid-cols-[1fr_1fr_1fr_auto]">
          <div className={cn(head, 'text-center')}><Both ar="قيمة القالب الفعلية" en={`Nominal${unit}`} /></div>
          <div className={cn(head, 'text-center')}><Both ar="القراءة الفعلية" en={`Actual Reading${unit}`} /></div>
          <div className={cn(head, 'text-center')}><Both ar="الخطأ" en={`Error${unit}`} /></div>
          <div className={cn(head, 'w-12 text-center')}><span className="sr-only">Within tolerance</span>±</div>
          {g.readings.map((r, ri) => {
            const ok = readingOk(r, cert.tolerance)
            return <div key={ri} className="contents">
              <div className={cn(cell, 'text-center tabular-nums')}>{fmt(r.nominal)}</div>
              <div className={cn(cell, 'text-center tabular-nums')}>{fmt(r.reading)}</div>
              <div className={cn(cell, 'text-center tabular-nums', ok === false && 'bg-danger-50 font-semibold text-danger-800 dark:bg-danger-500/15 dark:text-danger-300')}>{fmt(readingError(r))}</div>
              <div className={cn(cell, 'w-12 text-center font-bold')}>{ok === null ? '' : ok ? <><span aria-hidden>✓</span><span className="sr-only">Within tolerance</span></> : <><span aria-hidden>✕</span><span className="sr-only">Out of tolerance</span></>}</div>
            </div>
          })}
        </div>
      </div>)}
    </>}
    <div className={cn(cell, 'flex flex-wrap items-center justify-between gap-2')}>
      <span><span className="font-bold"><Both ar="النتيجة" en="Result" />:</span> {CERTIFICATE_RESULT_NAMES[cert.result]}{cert.maxError !== null ? ` · largest error ${cert.maxError}${cert.unit ? ` ${cert.unit}` : ''}` : ''}</span>
      {cert.notes && <span dir="auto" className="text-xs">{cert.notes}</span>}
    </div>
    <p className={cn(cell, 'text-center text-xs')} dir="rtl" lang="ar">لا تعتبر هذه الشهادة معتمدة إلا بالختم.</p>
    <div className="grid grid-cols-2 text-center">
      <div className={cn(cell, mode === 'paper' ? 'pb-8' : '')}><div className="font-bold"><Both ar="القائم بالمعايرة" en="Calibrated by" /></div><div dir="auto">{cert.performedBy || '—'}</div></div>
      <div className={cn(cell, mode === 'paper' ? 'pb-8' : '')}><div className="font-bold"><Both ar="مدير الجودة" en="Quality Manager" /></div><div dir="auto">{cert.approvedBy || '—'}</div></div>
    </div>
  </div>
}

/** The certificate alone on paper: what the browser prints. */
export function CertificatePaper({ cert }: { cert: CalibrationCertificate }) {
  return <div className="print-sheet"><CertificateSheet cert={cert} mode="paper" /></div>
}
