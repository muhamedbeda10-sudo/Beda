// ============================================================================
// A saved report's look and its Excel forms, under its buttons. Its owner
// chooses the style it prints in (one of theirs or a shared one; none: the
// company's default) and adds the company's own workbooks (QF-07, an
// inspection sheet…), saying where its values go — by hand or by the
// assistant. Anyone who opens the report (and may have Excel) fills a form
// from it: the report runs again in full over the days and values on screen
// and the server writes the rows into the workbook, everything else in it as
// it was.
// ============================================================================

import { useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { FileSpreadsheet, FileUp, Loader2, Palette, Settings2, Trash2 } from 'lucide-react'
import type { AiDayRange, AiReport, AiReportRunResponse } from '@qc/shared/ai'
import { BUILTIN_REPORT_STYLE_NAME, REPORT_FORM_MAX_BYTES, type ReportForm } from '@qc/shared/reportStyles'
import { Button, Modal, Select } from '@/components/ui'
import { cn, saveBlob } from '@/lib/utils'
import { deleteReportForm, loadFilledReportForm, setReportStyle, uploadReportForm, useReportForms, useReportStyles } from '@/services/reportStyles'
import { useApp } from '@/store/AppContext'
import { aiReportFilename } from '@/components/ai/exportAiReport'
import { FormMapper } from './FormMapper'

const SMALL_BTN = 'btn-secondary h-8 min-h-0 gap-1.5 px-2.5 py-0 text-xs touch:h-11 touch:px-3'

export function ReportLookPanel({
  report,
  run,
  range,
  inputs,
  excel,
  canRun,
}: {
  report: AiReport
  /** The run on screen: its sections' columns are what a form is matched to. */
  run: AiReportRunResponse | undefined
  range: AiDayRange | null
  inputs: string
  /** The person may have Excel (§20). */
  excel: boolean
  canRun: boolean
}) {
  const qc = useQueryClient()
  const { toast } = useApp()
  const styles = useReportStyles(report.mine)
  const forms = useReportForms(report.id)
  const [busy, setBusy] = useState<string | null>(null)
  const [mapping, setMapping] = useState<ReportForm | null>(null)
  const [removing, setRemoving] = useState<ReportForm | null>(null)
  const upload = useRef<HTMLInputElement>(null)
  const list = forms.data?.forms ?? []
  const columns = report.sections.map((_, i) => {
    const s = run?.sections[i]
    return s && s.ok ? s.columns : null
  })

  const chooseStyle = async (styleId: string) => {
    setBusy('style')
    try {
      await setReportStyle(qc, report.id, styleId || null)
      toast('The report prints in that style now.', 'success')
    } catch (e) {
      toast(e instanceof Error ? e.message : 'The style could not be chosen.', 'error')
    } finally {
      setBusy(null)
    }
  }

  const add = async (file: File | undefined) => {
    if (!file) return
    if (file.size > REPORT_FORM_MAX_BYTES) {
      toast(`A form may be at most ${REPORT_FORM_MAX_BYTES / 1024 / 1024} MB. Remove pictures or sheets it does not need.`, 'error')
      return
    }
    setBusy('upload')
    try {
      const form = await uploadReportForm(qc, report.id, file)
      toast('Form added. Now say where the report’s values go.', 'success')
      setMapping(form)
    } catch (e) {
      toast(e instanceof Error ? e.message : 'The form could not be added.', 'error')
    } finally {
      setBusy(null)
    }
  }

  const fill = async (form: ReportForm) => {
    setBusy(form.id)
    try {
      saveBlob(aiReportFilename(form.name, new Date().toISOString()), await loadFilledReportForm(report.id, form.id, range, inputs))
      toast(`Filled the form “${form.name}”.`, 'success')
    } catch (e) {
      toast(e instanceof Error ? e.message : 'The form could not be filled.', 'error')
    } finally {
      setBusy(null)
    }
  }

  const remove = async (form: ReportForm) => {
    setBusy(form.id)
    try {
      await deleteReportForm(qc, form)
      toast('Form removed.', 'success')
      setRemoving(null)
    } catch (e) {
      toast(e instanceof Error ? e.message : 'The form could not be removed.', 'error')
    } finally {
      setBusy(null)
    }
  }

  // Nothing to show someone who can neither choose the style nor fill a form.
  if (!report.mine && (list.length === 0 || !excel)) return null

  const styleList = styles.data?.styles ?? []
  return (
    <div className="space-y-2 rounded-xl bg-slate-50 px-3 py-2.5 ring-1 ring-slate-200/70 dark:bg-slate-800/50 dark:ring-slate-800">
      {report.mine && (
        <label className="flex flex-wrap items-center gap-2 text-xs">
          <Palette className="h-3.5 w-3.5 text-muted" />
          <span className="font-semibold">Style</span>
          <Select className="h-8 min-h-0 w-auto min-w-[12rem] py-0 text-xs touch:h-11" value={report.styleId ?? ''} onChange={(e) => void chooseStyle(e.target.value)} disabled={busy === 'style' || styles.isLoading}>
            <option value="">Company default{styles.data ? ` (${styleList.find((s) => s.id === styles.data.defaultId)?.name ?? BUILTIN_REPORT_STYLE_NAME})` : ''}</option>
            {report.styleId && !styleList.some((s) => s.id === report.styleId) && <option value={report.styleId}>A style you can no longer see</option>}
            {styleList.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </Select>
          {busy === 'style' && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
        </label>
      )}

      {(list.length > 0 || report.mine) && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="flex items-center gap-1.5 text-xs font-semibold">
            <FileSpreadsheet className="h-3.5 w-3.5 text-muted" /> Excel forms
          </span>
          {list.map((f) => (
            <span key={f.id} className="inline-flex items-center gap-1">
              {excel && f.mapping && (
                <button type="button" className={SMALL_BTN} onClick={() => void fill(f)} disabled={busy !== null || !canRun} data-tip="Runs the report again in full and fills the form with it">
                  {busy === f.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FileSpreadsheet className="h-3.5 w-3.5" />} <span dir="auto">{f.name}</span>
                </button>
              )}
              {!f.mapping && (
                <span dir="auto" className="text-xs text-muted">
                  {f.name} (not set up yet)
                </span>
              )}
              {f.mine && (
                <>
                  <button type="button" className="icon-btn h-8 w-8 touch:h-11 touch:w-11" onClick={() => setMapping(f)} aria-label={`Set up ${f.name}`} data-tip="Where the report’s values go">
                    <Settings2 className="h-3.5 w-3.5" />
                  </button>
                  <button type="button" className="icon-btn h-8 w-8 hover:text-rose-600 touch:h-11 touch:w-11" onClick={() => setRemoving(f)} aria-label={`Remove ${f.name}`} data-tip="Remove the form">
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </>
              )}
            </span>
          ))}
          {report.mine && (
            <>
              <button type="button" className={cn(SMALL_BTN)} onClick={() => upload.current?.click()} disabled={busy !== null} data-tip="The company’s own workbook (.xlsx): the app fills it from this report">
                {busy === 'upload' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FileUp className="h-3.5 w-3.5" />} Add a form
              </button>
              <input
                ref={upload}
                type="file"
                accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                className="hidden"
                onChange={(e) => {
                  void add(e.target.files?.[0])
                  e.target.value = ''
                }}
              />
            </>
          )}
        </div>
      )}

      {mapping && <FormMapper form={mapping} report={report} columns={columns} onClose={() => setMapping(null)} />}
      <Modal
        open={removing !== null}
        onClose={() => setRemoving(null)}
        title="Remove this form?"
        size="sm"
        footer={
          <>
            <Button onClick={() => setRemoving(null)}>Keep it</Button>
            <Button variant="danger" onClick={() => removing && void remove(removing)} disabled={busy !== null}>
              Remove
            </Button>
          </>
        }
      >
        <p className="text-sm">
          “<span dir="auto">{removing?.name}</span>” will no longer be filled from this report, nor from its scheduled deliveries.
        </p>
      </Modal>
    </div>
  )
}
