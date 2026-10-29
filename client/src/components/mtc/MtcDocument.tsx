// ============================================================================
// MTC — a kept certificate or delivery note, opened from the register: a PDF
// in the app's viewer, photos of its pages one under another, a workbook
// downloaded. The bytes are fetched with the access token (a plain link
// cannot carry one).
// ============================================================================

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { FileText, Loader2 } from 'lucide-react'
import { Modal } from '@/components/ui'
import { PdfViewer } from '@/components/documents/WorkInstructionViewer'
import { apiBlob } from '@/lib/api'
import { cn, saveBlob } from '@/lib/utils'
import { mtcDocumentPath, useMtcDocument } from '@/services/mtc'
import { useApp } from '@/store/AppContext'

/** The document behind `id`, open until closed. */
export function MtcDocumentViewer({ id, title, onClose }: { id: string; title: string; onClose: () => void }) {
  const doc = useMtcDocument(id)
  const { toast } = useApp()
  const source = doc.data?.source

  // A workbook is not shown: it is saved once, and the viewer closes.
  const close = useRef(onClose)
  close.current = onClose
  const fileName = doc.data?.fileName
  useEffect(() => {
    if (source !== 'sheet' || !fileName) return
    apiBlob(mtcDocumentPath(id))
      .then((blob) => saveBlob(/\.xlsx$/i.test(fileName) ? fileName : `${fileName}.xlsx`, blob))
      .catch(() => toast('The file could not be downloaded.', 'error'))
      .finally(() => close.current())
  }, [source, fileName, id, toast])

  if (doc.isError) {
    return (
      <Modal open onClose={onClose} title={title} size="sm">
        <p className="text-sm text-muted">The file could not be opened.</p>
      </Modal>
    )
  }
  if (!doc.data || source === 'sheet') {
    return (
      <Modal open onClose={onClose} title={title} size="sm">
        <p className="flex items-center gap-2 text-sm text-muted">
          <Loader2 className="h-4 w-4 animate-spin" /> Opening…
        </p>
      </Modal>
    )
  }
  if (source === 'pdf') return <PdfViewer path={mtcDocumentPath(id)} title={title} subtitle={doc.data.fileName} onClose={onClose} />
  return (
    <Modal open onClose={onClose} title={title} size="xl">
      <p className="mb-2 text-xs text-muted">
        {doc.data.fileName} · {doc.data.pages} {doc.data.pages === 1 ? 'photo' : 'photos'}
      </p>
      <div className="space-y-3">
        {Array.from({ length: doc.data.pages }, (_, i) => (
          <Photo key={i} path={mtcDocumentPath(id, i + 1)} alt={`Page ${i + 1} of ${doc.data!.fileName}`} />
        ))}
      </div>
    </Modal>
  )
}

function Photo({ path, alt }: { path: string; alt: string }) {
  const [url, setUrl] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let made: string | null = null
    let live = true
    apiBlob(path)
      .then((blob) => {
        if (!live) return
        made = URL.createObjectURL(blob)
        setUrl(made)
      })
      .catch(() => live && setFailed(true))
    return () => {
      live = false
      if (made) URL.revokeObjectURL(made)
    }
  }, [path])
  if (failed) return <p className="text-sm text-muted">This page could not be loaded.</p>
  if (!url) return <div className="h-64 animate-pulse rounded-xl bg-slate-100 dark:bg-slate-800" />
  return <img src={url} alt={alt} className="w-full rounded-xl ring-1 ring-slate-200 dark:ring-slate-700" />
}

/** A cell's or a line's link to the kept document: the label, underlined, with a file mark. */
export function MtcDocumentLink({ id, title, children, className }: { id: string; title: string; children: ReactNode; className?: string }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button
        type="button"
        onClick={(e) => {
          // A row opens its details on a click: the link opens the file alone.
          e.stopPropagation()
          setOpen(true)
        }}
        data-tip="Open the certificate as it was uploaded"
        className={cn('inline-flex max-w-full items-center gap-1 font-semibold text-brand-700 underline-offset-2 hover:underline dark:text-brand-300', className)}
      >
        <FileText className="h-3.5 w-3.5 shrink-0" aria-hidden />
        <span className="truncate">{children}</span>
      </button>
      {open && <MtcDocumentViewer id={id} title={title} onClose={() => setOpen(false)} />}
    </>
  )
}
