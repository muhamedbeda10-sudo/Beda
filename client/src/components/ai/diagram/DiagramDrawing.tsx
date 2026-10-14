// ============================================================================
// §20 — a diagram drawn: the layout (./layout) as SVG. Boxes in their shape
// and colour, a hypothesis dashed, a figure in bold under its label, arrows
// with their words, lanes and columns behind, a fishbone's spine, bones and
// the names of its bones. In the app it takes the theme's colours (classes,
// both themes); on paper and in a downloaded file (`paper`), fixed light
// colours written on each element, so the drawing stands on its own.
// ============================================================================

import { useId, type ReactNode, type SVGProps } from 'react'
import type { AiDiagramTone } from '@qc/shared/aiDiagram'
import { DETAIL_FONT, EDGE_FONT, FIGURE_FONT, GROUP_FONT, LABEL_FONT, type DiagramLayout, type PlacedNode } from './layout'
import { textDirection } from '@/lib/direction'
import { DIAGRAM_FONT_FAMILY } from './measure'

/** What each part is painted as: a role, coloured by the theme's classes or the paper's colours. */
type Role =
  | `box-${AiDiagramTone}`
  | `head-${AiDiagramTone}`
  | 'text'
  | 'text-head'
  | 'detail'
  | 'detail-head'
  | 'figure'
  | 'figure-head'
  | 'edge'
  | 'edge-label'
  | 'edge-label-bg'
  | 'lane'
  | 'lane-alt'
  | 'lane-header'
  | 'region-text'
  | 'column'
  | 'spine'
  | 'bone'
  | 'tick'
  | 'tag'
  | 'tag-text'
  | 'chevron'

const THEME: Record<Role, string> = {
  'box-neutral': 'fill-white stroke-slate-300 dark:fill-slate-800 dark:stroke-slate-600',
  'box-accent': 'fill-brand-50 stroke-brand-400 dark:fill-brand-500/15 dark:stroke-brand-400',
  'box-good': 'fill-emerald-50 stroke-emerald-500 dark:fill-emerald-500/15 dark:stroke-emerald-400',
  'box-warning': 'fill-amber-50 stroke-amber-500 dark:fill-amber-500/15 dark:stroke-amber-400',
  'box-bad': 'fill-rose-50 stroke-rose-500 dark:fill-rose-500/15 dark:stroke-rose-400',
  'head-neutral': 'fill-slate-700 stroke-slate-700 dark:fill-slate-200 dark:stroke-slate-200',
  'head-accent': 'fill-brand-600 stroke-brand-600 dark:fill-brand-500 dark:stroke-brand-500',
  'head-good': 'fill-emerald-600 stroke-emerald-600',
  'head-warning': 'fill-amber-600 stroke-amber-600',
  'head-bad': 'fill-rose-600 stroke-rose-600',
  text: 'fill-slate-800 dark:fill-slate-100',
  'text-head': 'fill-white dark:fill-slate-900',
  detail: 'fill-slate-500 dark:fill-slate-400',
  'detail-head': 'fill-white/80 dark:fill-slate-900/80',
  figure: 'fill-brand-700 dark:fill-brand-300',
  'figure-head': 'fill-white dark:fill-slate-900',
  edge: 'stroke-slate-400 dark:stroke-slate-500',
  'edge-label': 'fill-slate-600 dark:fill-slate-300',
  'edge-label-bg': 'fill-white dark:fill-slate-900',
  lane: 'fill-slate-50 stroke-slate-200 dark:fill-slate-800/40 dark:stroke-slate-700',
  'lane-alt': 'fill-white stroke-slate-200 dark:fill-slate-900 dark:stroke-slate-700',
  'lane-header': 'fill-slate-100 dark:fill-slate-800',
  'region-text': 'fill-slate-700 dark:fill-slate-200',
  column: 'fill-slate-50 stroke-slate-200 dark:fill-slate-800/40 dark:stroke-slate-700',
  spine: 'stroke-slate-700 dark:stroke-slate-300',
  bone: 'stroke-slate-500 dark:stroke-slate-400',
  tick: 'stroke-slate-400 dark:stroke-slate-500',
  tag: 'fill-brand-600 dark:fill-brand-500',
  'tag-text': 'fill-white',
  chevron: 'stroke-slate-400 dark:stroke-slate-500',
}

/** The same roles on paper: slate, the brand's blue and the tones, light. */
const PAPER: Record<Role, { fill?: string; stroke?: string }> = {
  'box-neutral': { fill: '#ffffff', stroke: '#cbd5e1' },
  'box-accent': { fill: '#eef3fc', stroke: '#5479d8' },
  'box-good': { fill: '#ecfdf5', stroke: '#10b981' },
  'box-warning': { fill: '#fffbeb', stroke: '#f59e0b' },
  'box-bad': { fill: '#fff1f2', stroke: '#f43f5e' },
  'head-neutral': { fill: '#334155', stroke: '#334155' },
  'head-accent': { fill: '#1e46a8', stroke: '#1e46a8' },
  'head-good': { fill: '#059669', stroke: '#059669' },
  'head-warning': { fill: '#d97706', stroke: '#d97706' },
  'head-bad': { fill: '#e11d48', stroke: '#e11d48' },
  text: { fill: '#1e293b' },
  'text-head': { fill: '#ffffff' },
  detail: { fill: '#64748b' },
  'detail-head': { fill: '#f1f5f9' },
  figure: { fill: '#193a8a' },
  'figure-head': { fill: '#ffffff' },
  edge: { stroke: '#94a3b8' },
  'edge-label': { fill: '#475569' },
  'edge-label-bg': { fill: '#ffffff' },
  lane: { fill: '#f8fafc', stroke: '#e2e8f0' },
  'lane-alt': { fill: '#ffffff', stroke: '#e2e8f0' },
  'lane-header': { fill: '#f1f5f9' },
  'region-text': { fill: '#334155' },
  column: { fill: '#f8fafc', stroke: '#e2e8f0' },
  spine: { stroke: '#334155' },
  bone: { stroke: '#64748b' },
  tick: { stroke: '#94a3b8' },
  tag: { fill: '#1e46a8' },
  'tag-text': { fill: '#ffffff' },
  chevron: { stroke: '#94a3b8' },
}

type Paint = (role: Role) => SVGProps<SVGElement>

/** A box that is no hypothesis is drawn whole; a hypothesis dashed, its fill a little faded. */
const HYPOTHESIS = { strokeDasharray: '5 4', fillOpacity: 0.6 }

/** A box's outline, by its shape. */
function shapeOf(n: PlacedNode, props: SVGProps<SVGElement>): ReactNode {
  const { x, y, w, h } = n
  const p = props as SVGProps<SVGPathElement>
  switch (n.shape) {
    case 'decision':
      return <path d={`M${x + w / 2},${y} L${x + w},${y + h / 2} L${x + w / 2},${y + h} L${x},${y + h / 2} Z`} {...p} />
    case 'terminal':
      return <rect x={x} y={y} width={w} height={h} rx={h / 2} {...(props as SVGProps<SVGRectElement>)} />
    case 'inspection': {
      // A box with its corners cut: a check on the way.
      const c = Math.min(10, h / 3)
      return <path d={`M${x + c},${y} L${x + w - c},${y} L${x + w},${y + h / 2} L${x + w - c},${y + h} L${x + c},${y + h} L${x},${y + h / 2} Z`} {...p} />
    }
    case 'store': {
      // A cylinder: stock, a store, a wait.
      const e = 5
      return (
        <>
          <path d={`M${x},${y + e} L${x},${y + h - e} A${w / 2},${e} 0 0 0 ${x + w},${y + h - e} L${x + w},${y + e} A${w / 2},${e} 0 0 0 ${x},${y + e} Z`} {...p} />
          {/* Its lid's rim: a line, never filled (inline, so a theme's fill class cannot fill it). */}
          <path d={`M${x},${y + e} A${w / 2},${e} 0 0 0 ${x + w},${y + e}`} {...p} style={{ fill: 'none' }} />
        </>
      )
    }
    case 'document': {
      // A sheet with a wavy foot: a record, a form.
      const f = 6
      return <path d={`M${x},${y} L${x + w},${y} L${x + w},${y + h - f} Q${x + (w * 3) / 4},${y + h - 2 * f} ${x + w / 2},${y + h - f} T${x},${y + h - f} Z`} {...p} />
    }
    case 'note': {
      // A sheet with its corner folded.
      const c = 10
      return <path d={`M${x},${y} L${x + w - c},${y} L${x + w},${y + c} L${x + w},${y + h} L${x},${y + h} Z M${x + w - c},${y} L${x + w - c},${y + c} L${x + w},${y + c}`} {...p} />
    }
    default:
      return <rect x={x} y={y} width={w} height={h} rx={8} {...(props as SVGProps<SVGRectElement>)} />
  }
}

/** Lines of words centred on `cx`, from `top`, each read in its own direction. */
function Lines({ lines, cx, top, font, paint, as }: { lines: readonly string[]; cx: number; top: number; font: typeof LABEL_FONT; paint: Paint; as: Role }) {
  return (
    <>
      {lines.map((line, i) => (
        <text
          key={i}
          x={cx}
          y={top + i * font.line + font.line / 2}
          dominantBaseline="central"
          textAnchor="middle"
          direction={textDirection(line) === 'rtl' ? 'rtl' : undefined}
          fontSize={font.size}
          fontWeight={font.weight}
          {...(paint(as) as SVGProps<SVGTextElement>)}
        >
          {line}
        </text>
      ))}
    </>
  )
}

function Box({ n, paint, onOpen }: { n: PlacedNode; paint: Paint; onOpen?: (to: string) => void }) {
  const tone = n.node.tone
  const head = !!n.head
  const outline = { ...paint(head ? `head-${tone === 'neutral' ? 'bad' : tone}` : `box-${tone}`), strokeWidth: head ? 0 : 1.25, ...(n.node.hypothesis ? HYPOTHESIS : {}) }
  const cx = n.x + n.w / 2
  let top = n.textTop
  const parts: ReactNode[] = [<g key="shape">{shapeOf(n, outline as SVGProps<SVGElement>)}</g>]
  parts.push(<Lines key="label" lines={n.label} cx={cx} top={top} font={LABEL_FONT} paint={paint} as={head ? 'text-head' : 'text'} />)
  top += n.label.length * LABEL_FONT.line
  if (n.figure) {
    parts.push(<Lines key="figure" lines={[n.figure]} cx={cx} top={top} font={FIGURE_FONT} paint={paint} as={head ? 'figure-head' : 'figure'} />)
    top += FIGURE_FONT.line
  }
  if (n.detail.length > 0) parts.push(<Lines key="detail" lines={n.detail} cx={cx} top={top + 2} font={DETAIL_FONT} paint={paint} as={head ? 'detail-head' : 'detail'} />)
  const title = [n.node.label, n.figure, n.node.detail, n.node.hypothesis ? 'Hypothesis: not shown by the data' : null].filter(Boolean).join(' · ')
  const link = n.node.link
  if (link && onOpen) {
    return (
      <a
        href={link}
        className="cursor-pointer focus:outline-none [&:focus-visible>g:first-child]:opacity-80"
        onClick={(e) => {
          if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
          e.preventDefault()
          onOpen(link)
        }}
      >
        <title>{title}</title>
        {parts}
      </a>
    )
  }
  return (
    <g>
      <title>{title}</title>
      {parts}
    </g>
  )
}

/**
 * The diagram as SVG, at its own size (the caller scales it with CSS where it
 * must). `onOpen`: what a box's link does (moves the app there); without it
 * links are not drawn as links (paper).
 */
export function DiagramDrawing({ layout, title, paper = false, onOpen, className }: { layout: DiagramLayout; title: string; paper?: boolean; onOpen?: (to: string) => void; className?: string }) {
  const id = useId().replace(/:/g, '')
  const paint: Paint = paper ? (role) => PAPER[role] : (role) => ({ className: THEME[role] })
  const arrow = `${id}-arrow`
  const edgePaint = paint('edge')
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox={`0 0 ${layout.width} ${layout.height}`}
      width={layout.width}
      height={layout.height}
      // A picture, unless its boxes open pages: then a group, so its links can be reached.
      role={onOpen && layout.nodes.some((n) => n.node.link) ? 'group' : 'img'}
      aria-label={title}
      fontFamily={DIAGRAM_FONT_FAMILY}
      className={className}
    >
      <defs>
        <marker id={arrow} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M0,1 L9,5 L0,9 Z" {...(paper ? { fill: PAPER.edge.stroke } : { className: 'fill-slate-400 dark:fill-slate-500' })} />
        </marker>
      </defs>
      {paper && <rect x={0} y={0} width={layout.width} height={layout.height} fill="#ffffff" />}
      {layout.regions.map((r, i) => (
        <g key={`region:${r.id}`}>
          <rect x={r.x} y={r.y} width={r.w} height={r.h} rx={r.kind === 'column' ? 10 : 0} strokeWidth={1} {...(paint(r.kind === 'column' ? 'column' : i % 2 === 0 ? 'lane' : 'lane-alt') as SVGProps<SVGRectElement>)} />
          {r.kind === 'lane' && <rect x={r.header.x} y={r.header.y} width={r.header.w} height={r.header.h} {...(paint('lane-header') as SVGProps<SVGRectElement>)} />}
          <Lines lines={r.header.lines} cx={r.header.x + r.header.w / 2} top={r.header.y + (r.header.h - r.header.lines.length * GROUP_FONT.line) / 2} font={GROUP_FONT} paint={paint} as="region-text" />
        </g>
      ))}
      {layout.chevrons.map((d, i) => (
        <path key={`chevron:${i}`} d={d} fill="none" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" {...(paint('chevron') as SVGProps<SVGPathElement>)} />
      ))}
      {layout.strokes.map((s, i) => (
        <path
          key={`stroke:${i}`}
          d={s.d}
          fill="none"
          strokeWidth={s.kind === 'spine' ? 3 : s.kind === 'bone' ? 1.75 : 1}
          strokeLinecap="round"
          strokeLinejoin="round"
          {...(paint(s.kind) as SVGProps<SVGPathElement>)}
          {...(s.kind === 'spine' ? { markerEnd: `url(#${arrow})` } : {})}
        />
      ))}
      {layout.edges.map((e, i) => (
        <path
          key={`edge:${i}`}
          d={e.d}
          fill="none"
          strokeWidth={1.5}
          markerEnd={`url(#${arrow})`}
          {...(edgePaint as SVGProps<SVGPathElement>)}
          {...(e.edge.dashed ? { strokeDasharray: '5 4' } : {})}
        />
      ))}
      {layout.edges.map((e, i) =>
        e.label ? (
          <g key={`edge-label:${i}`}>
            <rect x={e.label.x} y={e.label.y} width={e.label.w} height={e.label.h} rx={4} {...(paint('edge-label-bg') as SVGProps<SVGRectElement>)} />
            <Lines lines={e.label.lines} cx={e.label.x + e.label.w / 2} top={e.label.y + 2} font={EDGE_FONT} paint={paint} as="edge-label" />
          </g>
        ) : null,
      )}
      {layout.tags.map((t, i) => (
        <g key={`tag:${i}`}>
          <rect x={t.x} y={t.y} width={t.w} height={t.h} rx={t.h / 2 > 12 ? 8 : t.h / 2} {...(paint('tag') as SVGProps<SVGRectElement>)} />
          <Lines lines={t.lines} cx={t.x + t.w / 2} top={t.y + 5} font={GROUP_FONT} paint={paint} as="tag-text" />
        </g>
      ))}
      {layout.nodes.map((n) => (
        <Box key={`node:${n.id}`} n={n} paint={paint} onOpen={onOpen} />
      ))}
    </svg>
  )
}
