// ============================================================================
// §20 — an answer's text: markdown (GFM tables, lists, code), drawn as React
// elements, never as HTML. Hardened because the model's words can echo text
// people typed into the record: raw HTML is skipped, images are unwrapped to
// their words (no remote beacons), and a link is followed only when it is a
// page of this application or a plain web address (./links) — a page of the
// application alone in text sent beyond the person who asked. Styled here,
// with logical properties, so an Arabic answer lays out right to left: the
// text as a whole and each list and quote take the direction most of their
// words read in, set explicitly (./tables: proseDirection), each paragraph,
// item and heading its own; its tables (./AiTable: figures aligned, Copy and
// Excel under each) and its code, in a block with a Copy of its own. Laid out
// as a brief (./prose): a section's heading under the app's own icon, a
// callout as a tinted card, a numbered list as steps.
// ============================================================================

import { memo, useMemo, type AnchorHTMLAttributes, type CSSProperties, type HTMLAttributes, type ReactNode } from 'react'
import Markdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { useNavigate } from 'react-router-dom'
import {
  CalendarDays,
  ChartColumn,
  ClipboardList,
  Coins,
  ExternalLink,
  Factory,
  HardHat,
  Info,
  Lightbulb,
  ListChecks,
  Megaphone,
  OctagonAlert,
  Pin,
  Search,
  Target,
  Timer,
  TrendingDown,
  TrendingUp,
  TriangleAlert,
  Wrench,
  type LucideIcon,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { useApp } from '@/store/AppContext'
import { AiCode } from './AiCode'
import { AiMarkdownTable, TBODY_CLASS, TR_CLASS, tdClass, thClass } from './AiTable'
import { aiAppUrlTransform, aiUrlTransform, classifyAiLink } from './links'
import { DIR_ATTR, NUMERIC_ATTR, codeLanguage, hastDirection, hastRawText, proseDirection, rehypeAiTables, type HastNode } from './tables'
import { CALLOUT_ATTR, ICON_ATTR, STEPS_ATTR, rehypeAiProse, type CalloutKind, type SectionIcon } from './prose'

const REMARK = [remarkGfm]
const REHYPE = [rehypeAiTables, rehypeAiProse]
const DISALLOWED = ['img']
const LINK = 'font-semibold text-brand-700 underline decoration-brand-300 underline-offset-2 hover:decoration-brand-600 dark:text-brand-300 dark:decoration-brand-500/50'

/** `appOnly`: a web address is not followed, only a page of the application (text read beyond the person who asked). */
function MdLink({ href, children, appOnly = false }: AnchorHTMLAttributes<HTMLAnchorElement> & { children?: ReactNode; appOnly?: boolean }) {
  const navigate = useNavigate()
  const link = classifyAiLink(href)
  if (!link || (appOnly && link.kind !== 'app')) return <span>{children}</span>
  if (link.kind === 'external') {
    return (
      <a href={link.href} target="_blank" rel="noopener noreferrer" className={LINK}>
        {children}
        <ExternalLink aria-hidden className="ms-0.5 inline h-3 w-3 align-[-1px]" />
      </a>
    )
  }
  return (
    <a
      href={link.to}
      className={LINK}
      onClick={(e) => {
        // A modified click opens a new tab as any link does; a plain one moves the router it is in. In the assistant's
        // popup that is the popup's own: a place of the popup (a report, the Playbook) opens in it, and a page of the
        // app opens in the app with the popup stepping aside (AiPopup's LeaveForApp).
        if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
        e.preventDefault()
        navigate(link.to)
      }}
    >
      {children}
    </a>
  )
}

/** A header or body cell of a markdown table, aligned with its column (the rehype step in ./tables said how). */
function MdCell({ header, props }: { header: boolean; props: HTMLAttributes<HTMLTableCellElement> & Record<string, unknown> }) {
  const { [NUMERIC_ATTR]: numericMark, [DIR_ATTR]: dirMark, className: _className, children, ...rest } = props
  const numeric = numericMark !== undefined
  const dir = dirMark === 'rtl' ? 'rtl' : 'ltr'
  const Tag = header ? 'th' : 'td'
  return (
    <Tag dir={numeric ? 'ltr' : 'auto'} {...(header ? { scope: 'col' } : {})} className={header ? thClass(dir, numeric) : tdClass(dir, numeric)} {...rest}>
      {children as ReactNode}
    </Tag>
  )
}

/** A code block, left to right, under a strip naming its language with a Copy of its own. */
function CodeBlock({ node, children }: { node: HastNode | undefined; children?: ReactNode }) {
  const { toast } = useApp()
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(node ? hastRawText(node).replace(/\n$/, '') : '')
      toast('Copied.', 'success')
    } catch {
      toast('Could not copy — select the text and copy it by hand.', 'error')
    }
  }
  return (
    <AiCode
      label={(node && codeLanguage(node)) ?? 'Code'}
      onCopy={() => void copy()}
      copyLabel="Copy the code"
      className="my-3 rounded-xl"
      codeClassName="p-3 text-xs [&_code]:bg-transparent [&_code]:p-0 [&_code]:text-[length:inherit] [&_code]:text-slate-100 dark:[&_code]:bg-transparent"
    >
      {children}
    </AiCode>
  )
}

// The tints of a section's icon and of a callout: each readable on its own in the light and the dark theme.
const BRAND = 'bg-brand-50 text-brand-700 ring-brand-200/80 dark:bg-brand-500/15 dark:text-brand-300 dark:ring-brand-400/25'
const SLATE = 'bg-slate-100 text-slate-700 ring-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:ring-slate-700'
const EMERALD = 'bg-emerald-50 text-emerald-700 ring-emerald-200/80 dark:bg-emerald-500/15 dark:text-emerald-300 dark:ring-emerald-400/25'
const AMBER = 'bg-amber-50 text-amber-700 ring-amber-200/80 dark:bg-amber-500/15 dark:text-amber-300 dark:ring-amber-400/25'
const ROSE = 'bg-rose-50 text-rose-700 ring-rose-200/80 dark:bg-rose-500/15 dark:text-rose-300 dark:ring-rose-400/25'
const VIOLET = 'bg-violet-50 text-violet-700 ring-violet-200/80 dark:bg-violet-500/15 dark:text-violet-300 dark:ring-violet-400/25'

const SECTION_ICONS: Record<SectionIcon, { icon: LucideIcon; tone: string }> = {
  summary: { icon: Pin, tone: BRAND },
  figures: { icon: ChartColumn, tone: BRAND },
  analysis: { icon: Search, tone: BRAND },
  rise: { icon: TrendingUp, tone: EMERALD },
  fall: { icon: TrendingDown, tone: ROSE },
  risks: { icon: TriangleAlert, tone: AMBER },
  ideas: { icon: Lightbulb, tone: VIOLET },
  actions: { icon: ListChecks, tone: EMERALD },
  target: { icon: Target, tone: BRAND },
  production: { icon: Factory, tone: SLATE },
  time: { icon: Timer, tone: BRAND },
  maintenance: { icon: Wrench, tone: SLATE },
  people: { icon: HardHat, tone: SLATE },
  details: { icon: ClipboardList, tone: SLATE },
  period: { icon: CalendarDays, tone: SLATE },
  cost: { icon: Coins, tone: EMERALD },
}

const HEADING_CLASS = {
  h1: 'mb-2.5 mt-6 border-b border-slate-200 pb-2 text-base font-bold leading-snug text-slate-900 first:mt-0 dark:border-slate-700/80 dark:text-white',
  h2: 'mb-2.5 mt-6 border-b border-slate-200 pb-2 text-[15px] font-bold leading-snug text-slate-900 first:mt-0 dark:border-slate-700/80 dark:text-white',
  h3: 'mb-1.5 mt-4 text-sm font-bold leading-snug text-slate-900 first:mt-0 dark:text-white',
} as const

/** A heading: a section's, under the icon of its kind (./prose), when the model opened it with one of the section emoji. */
function MdHeading({ level, props }: { level: keyof typeof HEADING_CLASS; props: HTMLAttributes<HTMLHeadingElement> & Record<string, unknown> }) {
  const { [ICON_ATTR]: iconMark, className: _className, children, ...rest } = props
  const section = typeof iconMark === 'string' ? SECTION_ICONS[iconMark as SectionIcon] : undefined
  // An h1 and an h2 of an answer sit under the panel's own title, so they are drawn a step lower.
  const Tag = level === 'h3' ? 'h4' : 'h3'
  if (!section) {
    return (
      <Tag dir="auto" className={HEADING_CLASS[level]} {...rest}>
        {children as ReactNode}
      </Tag>
    )
  }
  const Icon = section.icon
  return (
    <Tag dir="auto" className={cn(HEADING_CLASS[level], 'flex items-center gap-2')} {...rest}>
      <span aria-hidden className={cn('grid shrink-0 place-items-center rounded-lg ring-1 ring-inset', level === 'h3' ? 'h-6 w-6' : 'h-7 w-7', section.tone)}>
        <Icon className={level === 'h3' ? 'h-3.5 w-3.5' : 'h-4 w-4'} />
      </span>
      <span className="min-w-0">{children as ReactNode}</span>
    </Tag>
  )
}

const CALLOUTS: Record<CalloutKind, { icon: LucideIcon; tone: string; en: string; ar: string }> = {
  note: { icon: Info, tone: BRAND, en: 'Note', ar: 'ملاحظة' },
  tip: { icon: Lightbulb, tone: EMERALD, en: 'Tip', ar: 'نصيحة' },
  important: { icon: Megaphone, tone: VIOLET, en: 'Important', ar: 'مهم' },
  warning: { icon: TriangleAlert, tone: AMBER, en: 'Warning', ar: 'تنبيه' },
  caution: { icon: OctagonAlert, tone: ROSE, en: 'Caution', ar: 'تحذير' },
}

/** A callout (./prose): a tinted card under its kind's icon and name, in the language its words read in; else a quote. */
function MdQuote({ node, props }: { node: unknown; props: HTMLAttributes<HTMLQuoteElement> & Record<string, unknown> }) {
  const { [CALLOUT_ATTR]: calloutMark, className: _className, children, ...rest } = props
  const dir = blockDir(node)
  const callout = typeof calloutMark === 'string' ? CALLOUTS[calloutMark as CalloutKind] : undefined
  if (!callout) {
    return (
      <blockquote dir={dir} className="my-3 rounded-e-lg border-s-4 border-brand-300 bg-brand-50/60 py-1.5 pe-3 ps-3 text-slate-700 dark:border-brand-500/60 dark:bg-brand-500/10 dark:text-slate-200" {...rest}>
        {children as ReactNode}
      </blockquote>
    )
  }
  const Icon = callout.icon
  return (
    <div role="note" dir={dir} className={cn('ai-callout my-3 flex items-start gap-2.5 rounded-xl px-3 py-2.5 ring-1 ring-inset', callout.tone)}>
      <Icon aria-hidden className="mt-0.5 h-4 w-4 shrink-0" />
      <div className="min-w-0 flex-1">
        <p className="text-xs font-bold tracking-wide">{dir === 'rtl' ? callout.ar : callout.en}</p>
        <div className="text-slate-800 dark:text-slate-100 [&>*:first-child]:mt-1 [&>*:last-child]:mb-0 [&>p]:my-1.5 [&_strong]:text-inherit">{children as ReactNode}</div>
      </div>
    </div>
  )
}

/** A list's or a quote's direction, by the words in it (./tables: hastDirection); none set when it has no words, so it takes the text's. */
const blockDir = (node: unknown): 'rtl' | 'ltr' | undefined => (node ? (hastDirection(node as HastNode) ?? undefined) : undefined)

/** A numbered list: steps, each number in a badge (index.css: .ai-steps), when it is not inside another list (./prose). */
function MdOrderedList({ node, props }: { node: unknown; props: HTMLAttributes<HTMLOListElement> & Record<string, unknown> }) {
  const { [STEPS_ATTR]: stepsMark, className: _className, start, ...rest } = props
  if (stepsMark === undefined) {
    return <ol dir={blockDir(node)} start={start as number | undefined} className="my-2.5 list-decimal space-y-1 ps-5 marker:font-semibold marker:text-slate-500 dark:marker:text-slate-400" {...rest} />
  }
  // The badges count from where the list starts ("3." when the model went on from an earlier list).
  const first = typeof start === 'number' && Number.isFinite(start) ? start : 1
  const style: CSSProperties = { counterReset: `ai-step ${first - 1}` }
  return <ol dir={blockDir(node)} start={start as number | undefined} className="ai-steps my-3 space-y-2" style={style} {...rest} />
}

// `node` (the syntax tree) is passed to every component; it is taken out so it never reaches the DOM.
const components: Components = {
  a: ({ node: _node, ...props }) => <MdLink {...props} />,
  p: ({ node: _node, ...props }) => <p dir="auto" className="my-2.5 first:mt-0 last:mb-0" {...props} />,
  h1: ({ node: _node, ...props }) => <MdHeading level="h1" props={props} />,
  h2: ({ node: _node, ...props }) => <MdHeading level="h2" props={props} />,
  h3: ({ node: _node, ...props }) => <MdHeading level="h3" props={props} />,
  h4: ({ node: _node, ...props }) => <h5 dir="auto" className="mb-1 mt-3 text-sm font-semibold first:mt-0" {...props} />,
  h5: ({ node: _node, ...props }) => <h6 dir="auto" className="mb-1 mt-3 text-sm font-semibold first:mt-0" {...props} />,
  h6: ({ node: _node, ...props }) => <h6 dir="auto" className="mb-1 mt-3 text-sm font-semibold first:mt-0" {...props} />,
  // A list's or a quote's own direction puts its markers, its indent and its bar on the side its words start from.
  ul: ({ node, ...props }) => <ul dir={blockDir(node)} className="my-2.5 list-disc space-y-1 ps-5 marker:text-brand-400 dark:marker:text-brand-300" {...props} />,
  ol: ({ node, ...props }) => <MdOrderedList node={node} props={props} />,
  li: ({ node: _node, ...props }) => <li dir="auto" className="ps-1 [&>ol]:my-1 [&>ul]:my-1" {...props} />,
  blockquote: ({ node, ...props }) => <MdQuote node={node} props={props} />,
  strong: ({ node: _node, ...props }) => <strong className="font-semibold text-slate-900 dark:text-white" {...props} />,
  hr: () => <hr className="my-4 border-slate-200 dark:border-slate-700" />,
  code: ({ node: _node, className: _lang, ...props }) => <code dir="ltr" className="rounded bg-slate-100 px-1 py-0.5 font-mono text-[0.85em] text-slate-800 dark:bg-slate-800 dark:text-slate-100" {...props} />,
  pre: ({ node, children }) => <CodeBlock node={node as HastNode | undefined}>{children}</CodeBlock>,
  table: ({ node, dir, children }) => (
    <AiMarkdownTable node={node as HastNode | undefined} dir={dir}>
      {children}
    </AiMarkdownTable>
  ),
  thead: ({ node: _node, ...props }) => <thead {...props} />,
  tbody: ({ node: _node, ...props }) => <tbody className={TBODY_CLASS} {...props} />,
  tr: ({ node: _node, ...props }) => <tr className={TR_CLASS} {...props} />,
  th: ({ node: _node, ...props }) => <MdCell header props={props} />,
  td: ({ node: _node, ...props }) => <MdCell header={false} props={props} />,
}

/** The same, with only the application's own pages as links. */
const appOnlyComponents: Components = { ...components, a: ({ node: _node, ...props }) => <MdLink {...props} appOnly /> }

/**
 * Markdown text, drawn safely. Memoised: a finished answer is parsed once,
 * not on every frame of the next one. `caret`: the text is still being
 * written — a caret blinks after its last word. `links`: 'app' when the text
 * reaches more people than the one who asked (a delivered scheduled report:
 * whole roles, people without the assistant) — a web address in it, which
 * may echo what someone typed into the record, stays words, never a link.
 */
export const AiMarkdown = memo(function AiMarkdown({ text, caret = false, links = 'any' }: { text: string; caret?: boolean; links?: 'any' | 'app' }) {
  const dir = useMemo(() => proseDirection(text), [text])
  const appOnly = links === 'app'
  return (
    <div dir={dir} className={cn('ai-prose break-words text-sm text-slate-800 dark:text-slate-100', caret && 'ai-caret')}>
      <Markdown remarkPlugins={REMARK} rehypePlugins={REHYPE} components={appOnly ? appOnlyComponents : components} disallowedElements={DISALLOWED} unwrapDisallowed skipHtml urlTransform={appOnly ? aiAppUrlTransform : aiUrlTransform}>
        {text}
      </Markdown>
    </div>
  )
})
