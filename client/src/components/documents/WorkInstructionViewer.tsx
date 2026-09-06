import { useEffect, useRef, useState } from 'react'
import { AlertTriangle, FileText, Loader2, Minus, Plus, X } from 'lucide-react'
import { createPortal } from 'react-dom'
import { apiBlob } from '@/lib/api'
import { cachedBlob } from '@/services/mediaCache'
import { cn } from '@/lib/utils'
import type { WorkInstruction } from '@qc/shared/types'

/**
 * Opens a controlled document inside the app. The PDF is fetched with the
 * access token (a plain <iframe> cannot carry one, and a phone browser would
 * download rather than show it), then every page is drawn with pdf.js at the
 * width of the screen. The renderer is loaded on first use so the wizard's
 * bundle stays small.
 */
export function WorkInstructionViewer({ instruction, onClose }: { instruction: WorkInstruction; onClose: () => void }) {
  const scroller = useRef<HTMLDivElement>(null)
  const [zoom, setZoom] = useState(1)
  const [state, setState] = useState<{ status: 'loading' | 'ready' | 'error'; pages: number; message?: string }>({ status: 'loading', pages: 0 })
  const [doc, setDoc] = useState<import('pdfjs-dist').PDFDocumentProxy | null>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    document.addEventListener('keydown', onKey)
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = ''
    }
  }, [onClose])

  // Fetch the bytes and open the document once.
  useEffect(() => {
    let cancelled = false
    let opened: import('pdfjs-dist').PDFDocumentProxy | null = null
    ;(async () => {
      try {
        const pdfjs = await import('pdfjs-dist')
        pdfjs.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).href
        // A controlled document is immutable per revision: fetched once per device.
        const blob = await cachedBlob(`/work-instructions/${instruction.id}/content`, () => apiBlob(`/work-instructions/${instruction.id}/content`))
        const data = new Uint8Array(await blob.arrayBuffer())
        opened = await pdfjs.getDocument({ data }).promise
        if (cancelled) return
        setDoc(opened)
        setState({ status: 'ready', pages: opened.numPages })
      } catch (e) {
        if (!cancelled) setState({ status: 'error', pages: 0, message: e instanceof Error ? e.message : 'The document could not be opened.' })
      }
    })()
    return () => {
      cancelled = true
      opened?.destroy().catch(() => undefined)
    }
  }, [instruction.id])

  return createPortal(
    <div className="fixed inset-0 z-[60] flex flex-col bg-slate-900 text-white">
      <header className="flex items-center gap-3 border-b border-white/10 px-3 py-2 sm:px-4 safe-top">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-white/10">
          <FileText className="h-5 w-5" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-bold leading-tight">{instruction.title}</p>
          <p className="truncate text-xs text-white/60">
            {instruction.code}
            {instruction.issueNo ? ` · Issue ${instruction.issueNo}` : ''}
            {instruction.issueDate ? ` · ${instruction.issueDate.slice(0, 10)}` : ''}
            {state.status === 'ready' ? ` · ${state.pages} page${state.pages === 1 ? '' : 's'}` : ''}
          </p>
        </div>
        <div className="hidden items-center gap-1 sm:flex">
          <button type="button" onClick={() => setZoom((z) => Math.max(0.5, +(z - 0.25).toFixed(2)))} className="rounded-lg p-2 hover:bg-white/10" aria-label="Zoom out">
            <Minus className="h-4 w-4" />
          </button>
          <span className="w-12 text-center text-xs tabular-nums text-white/70">{Math.round(zoom * 100)}%</span>
          <button type="button" onClick={() => setZoom((z) => Math.min(3, +(z + 0.25).toFixed(2)))} className="rounded-lg p-2 hover:bg-white/10" aria-label="Zoom in">
            <Plus className="h-4 w-4" />
          </button>
        </div>
        <button type="button" onClick={onClose} className="rounded-lg p-2 hover:bg-white/10" aria-label="Close document">
          <X className="h-6 w-6" />
        </button>
      </header>

      <div ref={scroller} className="flex-1 overflow-auto overscroll-contain px-2 py-3 sm:px-4">
        {state.status === 'loading' && (
          <p className="flex items-center justify-center gap-2 py-16 text-sm text-white/70">
            <Loader2 className="h-5 w-5 animate-spin" /> Opening the document…
          </p>
        )}
        {state.status === 'error' && (
          <p className="mx-auto mt-10 flex max-w-md items-start gap-2 rounded-2xl bg-rose-500/15 px-4 py-3 text-sm text-rose-100">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /> {state.message}
          </p>
        )}
        {doc && state.status === 'ready' && (
          <div className="mx-auto flex max-w-4xl flex-col items-center gap-3">
            {Array.from({ length: state.pages }, (_, i) => (
              <PdfPage key={i} doc={doc} pageNumber={i + 1} zoom={zoom} container={scroller} />
            ))}
          </div>
        )}
      </div>
    </div>,
    document.body,
  )
}

/** One page, drawn to fit the container's width times the zoom, sharp on a high-density screen. */
function PdfPage({
  doc,
  pageNumber,
  zoom,
  container,
}: {
  doc: import('pdfjs-dist').PDFDocumentProxy
  pageNumber: number
  zoom: number
  container: React.RefObject<HTMLDivElement>
}) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const [drawn, setDrawn] = useState(false)

  useEffect(() => {
    let cancelled = false
    let task: { cancel: () => void } | null = null
    ;(async () => {
      const page = await doc.getPage(pageNumber)
      if (cancelled || !canvas.current) return
      const available = Math.max(240, (container.current?.clientWidth ?? 800) - 24)
      const base = page.getViewport({ scale: 1 })
      const scale = (Math.min(available, 900) / base.width) * zoom
      const viewport = page.getViewport({ scale })
      const ratio = Math.min(window.devicePixelRatio || 1, 2)
      const el = canvas.current
      el.width = Math.floor(viewport.width * ratio)
      el.height = Math.floor(viewport.height * ratio)
      el.style.width = `${Math.floor(viewport.width)}px`
      el.style.height = `${Math.floor(viewport.height)}px`
      const ctx = el.getContext('2d')
      if (!ctx) return
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0)
      const render = page.render({ canvasContext: ctx, viewport })
      task = render
      try {
        await render.promise
        if (!cancelled) setDrawn(true)
      } catch {
        /* cancelled by a zoom change or close */
      }
    })()
    return () => {
      cancelled = true
      task?.cancel()
    }
  }, [doc, pageNumber, zoom, container])

  return (
    <div className={cn('relative rounded-lg bg-white shadow-lift', !drawn && 'min-h-[40vh] w-full max-w-[900px] animate-pulse bg-white/20')}>
      <canvas ref={canvas} className="block max-w-full rounded-lg" aria-label={`Page ${pageNumber}`} />
    </div>
  )
}
