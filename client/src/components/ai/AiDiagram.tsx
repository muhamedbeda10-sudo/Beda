// ============================================================================
// §20 — a diagram the assistant drew (shared/aiDiagram.ts), drawn: a fishbone
// with its problem at the head and its causes on the bones, each with the
// figure the data showed it by; a 5 Whys chain down to its root
// cause and the actions against it; a flowchart in layers, its loops drawn
// back on the right; a mind map from its centre outwards, a colour per
// branch. Hand-made SVG as the charts are (the 5 Whys in plain HTML, which
// wraps on its own), both themes, laid out by ./diagramLayout with texts
// measured as the browser draws them. A diagram reads left to right, as the
// charts do; each text in its own direction, so an Arabic one reads right.
// ============================================================================

import { Fragment, useId, useMemo } from 'react'
import { ArrowDown } from 'lucide-react'
import type { AiDiagram, FiveWhysDiagram } from '@qc/shared/aiDiagram'
import { PIE_CLASSES, PIE_STROKES } from '@/components/dashboard/charts'
import { cn } from '@/lib/utils'
import { FONT, LINE, SMALL, SMALL_LINE, estimateWidth, layoutFishbone, layoutFlowchart, layoutMindMap, textDir, type Measure } from './diagramLayout'

const FAMILY = "Inter, 'IBM Plex Sans Arabic', system-ui, sans-serif"

let context: CanvasRenderingContext2D | null | undefined
/** A text's width as the browser draws it in the assistant's type; read from the characters where there is no canvas (a test). */
export const measureText: Measure = (text, size, bold = false) => {
  if (context === undefined) {
    try {
      context = typeof document === 'undefined' ? null : document.createElement('canvas').getContext('2d')
    } catch {
      context = null
    }
  }
  if (!context) return estimateWidth(text, size, bold)
  context.font = `${bold ? 700 : 400} ${size}px ${FAMILY}`
  return context.measureText(text).width
}

const INK = 'fill-slate-800 dark:fill-slate-100'
const HALO = 'stroke-white dark:stroke-slate-900'

/**
 * Lines of text from a first baseline: centred on x, or ending at x (its right edge, whichever its direction). An
 * Arabic line is set right to left, so its start is its right edge.
 */
function Lines({ lines, x, y, align, size = FONT, step = LINE, bold, className }: { lines: readonly string[]; x: number; y: number; align: 'middle' | 'right'; size?: number; step?: number; bold?: boolean; className: string }) {
  return (
    <>
      {lines.map((line, i) => {
        const dir = textDir(line)
        const anchor = align === 'middle' ? 'middle' : dir === 'rtl' ? 'start' : 'end'
        return (
          <text key={i} x={x} y={y + i * step} fontSize={size} fontWeight={bold ? 700 : 400} textAnchor={anchor} direction={dir} className={className}>
            {line}
          </text>
        )
      })}
    </>
  )
}

/** An SVG as wide as its layout, or (`fit`) as wide as the page, scaled — on paper. */
function Svg({ width, height, fit, label, children }: { width: number; height: number; fit: boolean; label: string; children: React.ReactNode }) {
  const id = useId()
  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-labelledby={`${id}-t`}
      className="mx-auto block h-auto"
      style={fit ? { width: '100%', maxWidth: width } : { width, maxWidth: 'none' }}
      fontFamily={FAMILY}
    >
      <title id={`${id}-t`}>{label}</title>
      {children}
    </svg>
  )
}

// ---- Fishbone -----------------------------------------------------------------------------

function Fishbone({ diagram, fit }: { diagram: Extract<AiDiagram, { kind: 'fishbone' }>; fit: boolean }) {
  const layout = useMemo(() => layoutFishbone(diagram.problem, diagram.bones, measureText), [diagram])
  const { width, height, spineY, spineFrom, head } = layout
  const label = `${diagram.problem}: ${diagram.bones.map((b) => `${b.category} — ${b.causes.map((c) => `${c.text} (${c.evidence})`).join('; ')}`).join('. ')}`
  return (
    <Svg width={width} height={height} fit={fit} label={label}>
      <line x1={spineFrom} y1={spineY} x2={head.x} y2={spineY} strokeWidth={3} strokeLinecap="round" className="stroke-slate-700 dark:stroke-slate-300" />
      <path d={`M ${head.x - 12} ${spineY - 7} L ${head.x} ${spineY} L ${head.x - 12} ${spineY + 7}`} fill="none" strokeWidth={3} strokeLinejoin="round" className="stroke-slate-700 dark:stroke-slate-300" />
      {layout.bones.map((b, i) => (
        <g key={i}>
          <line x1={b.from.x} y1={b.from.y} x2={b.to.x} y2={b.to.y} strokeWidth={2} className="stroke-slate-500 dark:stroke-slate-400" />
          <rect x={b.label.x} y={b.label.y} width={b.label.w} height={b.label.h} rx={6} className="fill-brand-600" />
          <Lines lines={[b.bone.category]} x={b.label.x + b.label.w / 2} y={b.label.y + 17} align="middle" bold className="fill-white" />
          {b.causes.map((c, j) => (
            <g key={j}>
              {/* Where its figures came from, read out on hover. */}
              <title>{`${c.cause.text}: ${c.cause.evidence}${c.cause.sources.length > 0 ? ` — from: ${c.cause.sources.join('; ')}` : ''}`}</title>
              <line x1={c.x - c.width} y1={c.y} x2={c.x} y2={c.y} strokeWidth={1.25} className="stroke-slate-400 dark:stroke-slate-500" />
              <circle cx={c.x} cy={c.y} r={3} className="fill-slate-600 dark:fill-slate-300" />
              <Lines lines={c.lines} x={c.textX} y={c.top} align="right" className={INK} />
              {c.evidence.length > 0 && <Lines lines={c.evidence} x={c.textX} y={c.top + c.lines.length * LINE} align="right" size={SMALL} step={SMALL_LINE} bold className="fill-brand-700 dark:fill-brand-300" />}
            </g>
          ))}
        </g>
      ))}
      <rect x={head.x} y={head.y} width={head.w} height={head.h} rx={8} className="fill-rose-600" />
      <Lines lines={layout.headLines} x={head.x + head.w / 2} y={head.y + (head.h - layout.headLines.length * LINE) / 2 + FONT} align="middle" bold className="fill-white" />
    </Svg>
  )
}

/** What a fishbone's figures are. */
export function FishboneKey() {
  return <span>Every cause is one the data shows: the figure under it is what a query returned (hover a cause for its query).</span>
}

// ---- 5 Whys -------------------------------------------------------------------------------

function FiveWhys({ diagram }: { diagram: FiveWhysDiagram }) {
  const last = diagram.steps.length - 1
  return (
    <ol className="mx-auto flex max-w-xl flex-col items-stretch text-13">
      <li className="rounded-xl bg-rose-50 px-3 py-2 ring-1 ring-rose-200 dark:bg-rose-500/10 dark:ring-rose-500/30">
        <p className="text-[11px] font-bold uppercase tracking-wide text-rose-700 dark:text-rose-300">Problem</p>
        <p dir="auto" className="mt-0.5 font-semibold text-slate-800 dark:text-slate-100">
          {diagram.problem}
        </p>
      </li>
      {diagram.steps.map((s, i) => (
        <Fragment key={i}>
          <li aria-hidden className="flex items-center justify-center gap-1 py-1 text-[11px] font-semibold text-muted">
            <ArrowDown className="h-3.5 w-3.5" /> Why?
          </li>
          <li
            className={cn(
              'rounded-xl px-3 py-2 ring-1',
              i === last ? 'bg-amber-50 ring-2 ring-amber-400 dark:bg-amber-500/10 dark:ring-amber-500/60' : 'bg-white ring-slate-200 dark:bg-slate-900 dark:ring-slate-700',
            )}
          >
            <p className={cn('text-[11px] font-bold uppercase tracking-wide', i === last ? 'text-amber-700 dark:text-amber-300' : 'text-muted')}>{i === last ? `Root cause · Why ${i + 1}` : `Why ${i + 1}`}</p>
            <p dir="auto" className="mt-0.5 text-slate-800 dark:text-slate-100">
              {s.because}
            </p>
            {s.evidence && (
              <p dir="auto" className="mt-1 inline-block rounded-md bg-brand-50 px-1.5 py-0.5 text-xs font-semibold text-brand-700 dark:bg-brand-500/15 dark:text-brand-300">
                {s.evidence}
              </p>
            )}
          </li>
        </Fragment>
      ))}
      {diagram.actions.length > 0 && (
        <>
          <li aria-hidden className="flex items-center justify-center gap-1 py-1 text-[11px] font-semibold text-muted">
            <ArrowDown className="h-3.5 w-3.5" /> Actions
          </li>
          <li className="rounded-xl bg-emerald-50 px-3 py-2 ring-1 ring-emerald-200 dark:bg-emerald-500/10 dark:ring-emerald-500/30">
            <p className="text-[11px] font-bold uppercase tracking-wide text-emerald-700 dark:text-emerald-300">Actions</p>
            <ul className="mt-1 list-disc space-y-0.5 ps-5 text-slate-800 dark:text-slate-100">
              {diagram.actions.map((a, i) => (
                <li key={i} dir="auto">
                  {a}
                </li>
              ))}
            </ul>
          </li>
        </>
      )}
    </ol>
  )
}

// ---- Flowchart ----------------------------------------------------------------------------

function Flowchart({ diagram, fit }: { diagram: Extract<AiDiagram, { kind: 'flowchart' }>; fit: boolean }) {
  const id = useId()
  const layout = useMemo(() => layoutFlowchart(diagram.nodes, diagram.edges, measureText), [diagram])
  const arrow = `${id}-arrow`
  const label = diagram.edges
    .map((e) => {
      const name = (nid: string) => diagram.nodes.find((n) => n.id === nid)?.label ?? nid
      return `${name(e.from)} → ${e.label ? `${e.label}: ` : ''}${name(e.to)}`
    })
    .join('; ')
  return (
    <Svg width={layout.width} height={layout.height} fit={fit} label={label}>
      <defs>
        <marker id={arrow} viewBox="0 0 10 10" refX={9} refY={5} markerWidth={7} markerHeight={7} orient="auto-start-reverse">
          <path d="M 0 0 L 10 5 L 0 10 z" className="fill-slate-500 dark:fill-slate-400" />
        </marker>
      </defs>
      {layout.edges.map((e, i) => (
        <path key={i} d={e.path} fill="none" strokeWidth={1.5} strokeDasharray={e.back ? '5 4' : undefined} markerEnd={`url(#${arrow})`} className="stroke-slate-500 dark:stroke-slate-400" />
      ))}
      {layout.nodes.map(({ node, lines, box }, i) => {
        const { x, y, w, h } = box
        const shape =
          node.shape === 'decision' ? (
            <polygon points={`${x + w / 2},${y} ${x + w},${y + h / 2} ${x + w / 2},${y + h} ${x},${y + h / 2}`} />
          ) : (
            <rect x={x} y={y} width={w} height={h} rx={node.shape === 'step' ? 6 : h / 2} />
          )
        const tone = node.highlight
          ? 'fill-rose-50 stroke-rose-500 dark:fill-rose-500/15'
          : node.shape === 'decision'
            ? 'fill-amber-50 stroke-amber-500 dark:fill-amber-500/10'
            : node.shape === 'step'
              ? 'fill-white stroke-slate-400 dark:fill-slate-900 dark:stroke-slate-500'
              : 'fill-brand-50 stroke-brand-500 dark:fill-brand-500/15'
        return (
          <g key={i}>
            <g strokeWidth={node.highlight ? 2.5 : 1.5} className={tone}>
              {shape}
            </g>
            <Lines lines={lines} x={x + w / 2} y={y + (h - lines.length * LINE) / 2 + FONT - 1} align="middle" bold={node.shape !== 'step' && node.shape !== 'decision'} className={INK} />
          </g>
        )
      })}
      {layout.edges.map(
        (e, i) =>
          e.labelAt && (
            <text key={i} x={e.labelAt.x} y={e.labelAt.y} fontSize={SMALL} fontWeight={600} strokeWidth={3} paintOrder="stroke" direction={textDir(e.edge.label ?? '')} className={cn('fill-slate-700 dark:fill-slate-200', HALO)}>
              {e.edge.label}
            </text>
          ),
      )}
    </Svg>
  )
}

// ---- Mind map -----------------------------------------------------------------------------

const branchFill = (k: number) => PIE_CLASSES[k % (PIE_CLASSES.length - 1)]
const branchStroke = (k: number) => PIE_STROKES[k % (PIE_STROKES.length - 1)]

function MindMap({ diagram, fit }: { diagram: Extract<AiDiagram, { kind: 'mind-map' }>; fit: boolean }) {
  const layout = useMemo(() => layoutMindMap(diagram.center, diagram.branches, measureText), [diagram])
  const label = `${diagram.center}: ${layout.nodes
    .filter((n) => n.depth > 0)
    .map((n) => n.label)
    .join(', ')}`
  return (
    <Svg width={layout.width} height={layout.height} fit={fit} label={label}>
      {layout.nodes.map((n, i) => {
        if (n.parent === null) return null
        const p = layout.nodes[n.parent].box
        const x1 = p.x + p.w
        const y1 = p.y + p.h / 2
        const x2 = n.box.x
        const y2 = n.box.y + n.box.h / 2
        const mid = (x1 + x2) / 2
        return <path key={i} d={`M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}`} fill="none" strokeWidth={n.depth === 1 ? 2.5 : 1.5} className={branchStroke(n.branch)} />
      })}
      {layout.nodes.map((n, i) => {
        const { x, y, w, h } = n.box
        const filled = n.depth <= 1
        return (
          <g key={i}>
            <rect
              x={x}
              y={y}
              width={w}
              height={h}
              rx={n.depth === 0 ? h / 2 : 7}
              strokeWidth={filled ? 0 : 1.5}
              className={n.depth === 0 ? 'fill-slate-800 dark:fill-slate-200' : filled ? branchFill(n.branch) : cn('fill-white dark:fill-slate-900', branchStroke(n.branch))}
            />
            <Lines
              lines={n.lines}
              x={x + w / 2}
              y={y + (h - n.lines.length * LINE) / 2 + FONT - 1}
              align="middle"
              size={n.depth === 0 ? FONT + 1 : FONT}
              bold={n.depth <= 1}
              className={n.depth === 0 ? 'fill-white dark:fill-slate-900' : filled ? 'fill-white' : INK}
            />
          </g>
        )
      })}
    </Svg>
  )
}

/** A diagram drawn: at its own size (`fit` false: its card scrolls it), or as wide as the page allows (on paper). */
export function DiagramDrawing({ diagram, fit = false }: { diagram: AiDiagram; fit?: boolean }) {
  switch (diagram.kind) {
    case 'fishbone':
      return <Fishbone diagram={diagram} fit={fit} />
    case 'five-whys':
      return <FiveWhys diagram={diagram} />
    case 'flowchart':
      return <Flowchart diagram={diagram} fit={fit} />
    case 'mind-map':
      return <MindMap diagram={diagram} fit={fit} />
  }
}
