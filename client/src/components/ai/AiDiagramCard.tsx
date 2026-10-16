// ============================================================================
// §20 — a diagram the assistant drew, as a card in its answer: its title and
// kind, the drawing (./diagram), and under it what a reader needs to trust
// it — which boxes are hypotheses (dashed: the data does not show them) and
// the queries its figures came from, with their SQL. Full screen opens it to
// be read on a tablet, pinch to zoom; Download image saves it on the device
// as a PNG, drawn light with its typefaces inside.
//
// It is drawn at its own size where the answer is wide enough, scaled down
// to fit where it is not (never below MIN_SCALE: its words must stay
// readable), and scrolls sideways past that. A box's link opens its page
// as the answer's links do.
// ============================================================================

import { memo, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ChevronRight, Columns3, Fish, ImageDown, Loader2, Maximize2, Network, Rows3, Workflow } from 'lucide-react'
import { AI_DIAGRAM_LAYOUT_NAME, type AiDiagramLayout, type AiDiagramPart, type AiDiagramSpec } from '@qc/shared/aiDiagram'
import { cn } from '@/lib/utils'
import { textDirection } from '@/lib/direction'
import { useApp } from '@/store/AppContext'
import { TableTool } from './AiTable'
import { classifyAiLink } from './links'
import { DiagramDrawing } from './diagram/DiagramDrawing'
import { DiagramViewer } from './diagram/DiagramViewer'
import { downloadDiagramPng } from './diagram/exportDiagram'
import { layoutDiagram, type DiagramLayout } from './diagram/layout'
import { canvasMeasure, DIAGRAM_FONT_FAMILY } from './diagram/measure'

/** The least a diagram is scaled to fit the answer: below it, its words get too small to read, and it scrolls instead. */
export const MIN_SCALE = 0.8

const ICON: Record<AiDiagramLayout, typeof Workflow> = {
  flow: Workflow,
  swimlane: Rows3,
  tree: Network,
  fishbone: Fish,
  columns: Columns3,
}

/**
 * The diagram laid out with its words measured in the answer's typefaces —
 * again once the faces its words need have loaded (the Arabic one loads only
 * when an Arabic letter is first drawn), so the boxes fit them.
 */
export function useDiagramLayout(spec: AiDiagramSpec): DiagramLayout {
  const [faces, setFaces] = useState(0)
  useEffect(() => {
    const fonts = typeof document === 'undefined' ? undefined : document.fonts
    if (!fonts?.load) return
    let live = true
    const words = [spec.title, ...spec.groups.map((g) => g.label), ...spec.nodes.flatMap((n) => [n.label, n.detail ?? '', n.figure?.text ?? ''])].join(' ')
    Promise.all([400, 600, 700].map((w) => fonts.load(`${w} 12px ${DIAGRAM_FONT_FAMILY}`, words)))
      .then(() => live && setFaces((n) => n + 1))
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [spec])
  return useMemo(() => layoutDiagram(spec, canvasMeasure()), [spec, faces])
}

/** What a diagram is, on its card: its kind and how many boxes. */
export function diagramSubtitle(spec: AiDiagramSpec): string {
  const n = spec.nodes.length
  return `${AI_DIAGRAM_LAYOUT_NAME[spec.layout]} · ${n} ${n === 1 ? 'box' : 'boxes'}`
}

/** The width of the answer the card is in, measured before the first paint and as it changes. */
function useWidth() {
  const ref = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState<number | null>(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const read = () => setWidth(el.clientWidth)
    read()
    if (typeof ResizeObserver === 'undefined') return
    const watch = new ResizeObserver(read)
    watch.observe(el)
    return () => watch.disconnect()
  }, [])
  return { ref, width }
}

/** The figures' queries, folded away: what each counts, its rows, and its SQL. */
function Workings({ spec }: { spec: AiDiagramSpec }) {
  const [open, setOpen] = useState(false)
  const id = useId()
  const n = spec.sources.length
  if (n === 0) return null
  return (
    <div className="print-hidden">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        aria-controls={id}
        className="inline-flex min-h-[28px] items-center gap-1 rounded-md pe-1.5 text-xs font-semibold text-muted hover:text-slate-700 dark:hover:text-slate-200 touch:min-h-[44px]"
      >
        <ChevronRight aria-hidden className={cn('h-4 w-4 transition-transform duration-200', open ? 'rotate-90' : 'rtl:rotate-180')} />
        Figures from {n} {n === 1 ? 'query' : 'queries'}
      </button>
      <ul id={id} hidden={!open} className="mt-1 space-y-2 border-s-2 border-slate-200 ps-2.5 dark:border-slate-700">
        {spec.sources.map((s) => (
          <li key={s.id} className="text-xs">
            <p dir="auto" className="font-semibold text-slate-700 dark:text-slate-200">
              {s.purpose}
            </p>
            <p className="text-muted">
              {s.rows.toLocaleString('en-US')} {s.rows === 1 ? 'row' : 'rows'} · {(s.ms / 1000).toFixed(1)} s
            </p>
            <pre dir="ltr" className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-slate-50 p-2 font-mono text-[11px] text-slate-700 ring-1 ring-slate-200 dark:bg-slate-800/60 dark:text-slate-200 dark:ring-slate-700">
              {s.sql}
            </pre>
          </li>
        ))}
      </ul>
    </div>
  )
}

export const AiDiagramCard = memo(function AiDiagramCard({ part }: { part: AiDiagramPart }) {
  const { spec } = part
  const layout = useDiagramLayout(spec)
  const navigate = useNavigate()
  const { toast } = useApp()
  const { ref, width } = useWidth()
  const [full, setFull] = useState(false)
  const [busy, setBusy] = useState(false)
  const scale = width ? Math.min(1, Math.max(MIN_SCALE, width / layout.width)) : 1
  const Icon = ICON[spec.layout]
  const hypotheses = spec.nodes.filter((n) => n.hypothesis).length
  const open = (to: string) => {
    const link = classifyAiLink(to)
    if (link?.kind !== 'app') return
    setFull(false)
    navigate(link.to)
  }
  const download = async () => {
    if (busy) return
    setBusy(true)
    try {
      await downloadDiagramPng(layout, spec.title)
    } catch (e) {
      toast(e instanceof Error ? e.message : 'The diagram could not be downloaded. Try again.', 'error')
    } finally {
      setBusy(false)
    }
  }
  const drawing = <DiagramDrawing layout={layout} title={spec.title} onOpen={open} />
  return (
    <figure className="ai-figure my-3 rounded-2xl bg-white p-3 shadow-card ring-1 ring-slate-200/80 dark:bg-slate-900 dark:ring-slate-800 sm:p-4">
      <figcaption dir={textDirection(spec.title) ?? 'ltr'} className="mb-2 flex items-start gap-2.5">
        <span aria-hidden className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-brand-50 text-brand-600 dark:bg-brand-500/15 dark:text-brand-300">
          <Icon className="h-4 w-4" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-bold leading-snug text-slate-900 dark:text-white">{spec.title}</span>
          <span className="block text-[11px] leading-snug text-muted">
            <bdi>{diagramSubtitle(spec)}</bdi>
          </span>
        </span>
      </figcaption>
      <div ref={ref} className="overflow-x-auto overscroll-x-contain">
        {/* Scaled to the answer's width, never below MIN_SCALE; wider than that, it scrolls. */}
        <div style={{ width: layout.width * scale, height: layout.height * scale }}>
          <div className="origin-top-left" style={{ width: layout.width, height: layout.height, transform: scale === 1 ? undefined : `scale(${scale})` }}>
            {drawing}
          </div>
        </div>
      </div>
      {hypotheses > 0 && (
        <p className="mt-2 flex items-center gap-2 text-[11px] text-muted">
          <svg aria-hidden width="22" height="12" className="shrink-0">
            <rect x="1" y="1" width="20" height="10" rx="3" fill="none" strokeDasharray="4 3" className="stroke-slate-400" strokeWidth="1.25" />
          </svg>
          Dashed: {hypotheses === 1 ? 'a hypothesis' : `${hypotheses} hypotheses`} to check — the data does not show {hypotheses === 1 ? 'it' : 'them'}.
        </p>
      )}
      <div className="mt-1.5 flex flex-wrap items-start justify-between gap-x-2 gap-y-1">
        <Workings spec={spec} />
        <div className="print-hidden ms-auto flex flex-wrap justify-end gap-1 text-xs text-muted">
          <TableTool onClick={() => setFull(true)} icon={<Maximize2 className="h-3.5 w-3.5" />} tip="Open it on the whole screen, to zoom in">
            Full screen
          </TableTool>
          <TableTool onClick={() => void download()} disabled={busy} icon={busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ImageDown className="h-3.5 w-3.5" />} tip="Save it on this device as an image (PNG)">
            Download image
          </TableTool>
        </div>
      </div>
      {full && (
        <DiagramViewer width={layout.width} height={layout.height} title={spec.title} onClose={() => setFull(false)}>
          {drawing}
        </DiagramViewer>
      )}
    </figure>
  )
})

/** A diagram on paper: its title, the drawing in light colours across the page, and which boxes are hypotheses. */
export function DiagramPrint({ part }: { part: AiDiagramPart }) {
  const { spec } = part
  const layout = useDiagramLayout(spec)
  const hypotheses = spec.nodes.filter((n) => n.hypothesis).length
  return (
    <figure className="print-keep">
      <figcaption dir="auto" className="mb-1 text-[12px] font-bold">
        {spec.title} <span className="font-normal text-slate-500">· {diagramSubtitle(spec)}</span>
      </figcaption>
      <DiagramDrawing layout={layout} title={spec.title} paper className="h-auto max-w-full" />
      {hypotheses > 0 && <p className="mt-1 text-[10px] text-slate-600">Dashed boxes are hypotheses to check: the data does not show them.</p>}
    </figure>
  )
}
