// ============================================================================
// §16 — one notice as the reader sees it: how serious, what it says, what it
// is aimed at, its photos and documents. Shared by the bell, the gate and
// the administrator's list so a notice always reads the same.
// ============================================================================

import { useState, type ReactNode } from 'react'
import { AlertOctagon, AlertTriangle, Download, FileSpreadsheet, FileText, Info, Loader2 } from 'lucide-react'
import { NOTICE_TARGET_LABEL, type Notice, type NoticeFile, type NoticeSeverity } from '@qc/shared/types'
import { Badge, type BadgeTone } from '@/components/ui'
import { ImagePicker } from '@/components/inspection/ImagePicker'
import { PdfViewer } from '@/components/documents/WorkInstructionViewer'
import { apiBlob } from '@/lib/api'
import { cn, formatDate } from '@/lib/utils'
import { useApp } from '@/store/AppContext'

export const SEVERITY_META: Record<NoticeSeverity, { label: string; tone: BadgeTone; icon: typeof Info; ring: string; iconBg: string }> = {
  info: { label: 'Information', tone: 'blue', icon: Info, ring: 'ring-brand-200 dark:ring-brand-500/30', iconBg: 'bg-brand-100 text-brand-700 dark:bg-brand-500/15 dark:text-brand-200' },
  warning: { label: 'Warning', tone: 'amber', icon: AlertTriangle, ring: 'ring-amber-200 dark:ring-amber-500/30', iconBg: 'bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300' },
  critical: { label: 'Critical', tone: 'red', icon: AlertOctagon, ring: 'ring-rose-200 dark:ring-rose-500/30', iconBg: 'bg-rose-100 text-rose-700 dark:bg-rose-500/15 dark:text-rose-300' },
}

export function SeverityBadge({ severity }: { severity: NoticeSeverity }) {
  const m = SEVERITY_META[severity]
  return (
    <Badge tone={m.tone} icon={<m.icon className="h-3 w-3" />}>
      {m.label}
    </Badge>
  )
}

export function validityText(n: Pick<Notice, 'validFrom' | 'validTo'>): string {
  const from = formatDate(n.validFrom)
  return n.validTo ? (n.validTo === n.validFrom ? from : `${from} – ${formatDate(n.validTo)}`) : `from ${from}`
}

function fileSize(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`
}

/** A document attached to a notice: a PDF opens in the app, a workbook is downloaded. */
export function NoticeFileRow({ file, path, compact = false }: { file: NoticeFile; /** Where the bytes are served; a notice file by default. */ path?: string; compact?: boolean }) {
  const src = path ?? `/notices/files/${file.id}/content`
  const { toast } = useApp()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const pdf = file.mimeType === 'application/pdf'
  const download = async () => {
    setBusy(true)
    try {
      const blob = await apiBlob(src)
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = file.originalFilename
      a.click()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
    } catch {
      toast('The file could not be downloaded.', 'error')
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      <button
        type="button"
        onClick={() => (pdf ? setOpen(true) : void download())}
        className={cn('flex w-full items-center gap-3 rounded-xl border border-slate-200 text-left transition-colors hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800/60', compact ? 'px-2 py-1.5' : 'px-3 py-2')}
      >
        <span className={cn('grid h-9 w-9 shrink-0 place-items-center rounded-lg', pdf ? 'bg-rose-100 text-rose-600 dark:bg-rose-500/15 dark:text-rose-300' : 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300')}>
          {pdf ? <FileText className="h-4 w-4" /> : <FileSpreadsheet className="h-4 w-4" />}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-semibold">{file.originalFilename}</span>
          <span className="block text-xs text-slate-400">
            {fileSize(file.byteSize)} · {pdf ? 'Open' : 'Download'}
          </span>
        </span>
        {busy ? <Loader2 className="h-4 w-4 animate-spin text-slate-400" /> : <Download className="h-4 w-4 text-slate-400" />}
      </button>
      {open && <PdfViewer path={src} title={file.originalFilename} subtitle={fileSize(file.byteSize)} onClose={() => setOpen(false)} />}
    </>
  )
}

export function TargetChips({ notice, className }: { notice: Pick<Notice, 'targets'> & Partial<Pick<Notice, 'matchMode'>>; className?: string }) {
  if (notice.targets.length === 0) return <Badge tone="neutral" className={className}>Everyone, everywhere</Badge>
  const kinds = new Set(notice.targets.map((t) => t.kind)).size
  return (
    <div className={cn('flex flex-wrap items-center gap-1.5', className)}>
      {/* The combining rule only matters once there is more than one thing to combine. */}
      {notice.targets.length > 1 && (
        <span title={notice.matchMode === 'any' ? 'One of these is enough' : kinds > 1 ? 'All kinds at once; any value of a kind' : 'Any of these'}>
          <Badge tone={notice.matchMode === 'any' ? 'amber' : 'blue'}>{notice.matchMode === 'any' ? 'ANY of' : kinds > 1 ? 'ALL of' : 'ANY of'}</Badge>
        </span>
      )}
      {notice.targets.map((t) => (
        <Badge key={`${t.kind}:${t.value}`} tone="neutral">
          <span className="font-normal text-slate-400">{NOTICE_TARGET_LABEL[t.kind]}</span> {t.label || t.value}
        </Badge>
      ))}
    </div>
  )
}

/** The full notice. `actions` sits under the body: an Acknowledge button, or nothing. */
export function NoticeCard({ notice, actions, showTargets = true, hideHeader = false, className }: { notice: Notice; actions?: ReactNode; showTargets?: boolean; /** The list row already shows the title. */ hideHeader?: boolean; className?: string }) {
  const m = SEVERITY_META[notice.severity]
  return (
    <article className={cn('rounded-2xl bg-white p-4 ring-1 dark:bg-slate-900', m.ring, className)}>
      {!hideHeader && <div className="flex items-start gap-3">
        <span className={cn('grid h-10 w-10 shrink-0 place-items-center rounded-xl', m.iconBg)}>
          <m.icon className="h-5 w-5" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <SeverityBadge severity={notice.severity} />
            {notice.requiresAck && <Badge tone="violet">Acknowledgement required</Badge>}
          </div>
          <h3 className="mt-1.5 text-base font-bold leading-snug">{notice.title}</h3>
          <p className="mt-0.5 text-xs text-slate-400">
            {notice.createdByName} · {validityText(notice)}
            {notice.withdrawnAt ? ' · withdrawn' : ''}
          </p>
        </div>
      </div>}
      {notice.body && <p className={cn('whitespace-pre-wrap text-sm leading-relaxed text-slate-700 dark:text-slate-200', !hideHeader && 'mt-3')}>{notice.body}</p>}
      {notice.imageIds.length > 0 && (
        <div className="mt-3">
          <ImagePicker imageIds={notice.imageIds} onChange={() => {}} readOnly />
        </div>
      )}
      {notice.files.length > 0 && (
        <div className="mt-3 space-y-1.5">
          {notice.files.map((f) => (
            <NoticeFileRow key={f.id} file={f} />
          ))}
        </div>
      )}
      {showTargets && <TargetChips notice={notice} className="mt-3" />}
      {actions && <div className="mt-4 flex flex-wrap justify-end gap-2">{actions}</div>}
    </article>
  )
}
