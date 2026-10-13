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
// Excel under each) and its code, in a block with a Copy of its own.
// ============================================================================

import { memo, useMemo, type AnchorHTMLAttributes, type HTMLAttributes, type ReactNode } from 'react'
import Markdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { useNavigate } from 'react-router-dom'
import { ExternalLink } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useApp } from '@/store/AppContext'
import { AiCode } from './AiCode'
import { AiMarkdownTable, TBODY_CLASS, TR_CLASS, tdClass, thClass } from './AiTable'
import { aiAppUrlTransform, aiUrlTransform, classifyAiLink } from './links'
import { DIR_ATTR, NUMERIC_ATTR, codeLanguage, hastDirection, hastRawText, proseDirection, rehypeAiTables, type HastNode } from './tables'

const REMARK = [remarkGfm]
const REHYPE = [rehypeAiTables]
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

/** A list's or a quote's direction, by the words in it (./tables: hastDirection); none set when it has no words, so it takes the text's. */
const blockDir = (node: unknown): 'rtl' | 'ltr' | undefined => (node ? (hastDirection(node as HastNode) ?? undefined) : undefined)

// `node` (the syntax tree) is passed to every component; it is taken out so it never reaches the DOM.
const components: Components = {
  a: ({ node: _node, ...props }) => <MdLink {...props} />,
  p: ({ node: _node, ...props }) => <p dir="auto" className="my-2.5 first:mt-0 last:mb-0" {...props} />,
  h1: ({ node: _node, ...props }) => <h3 dir="auto" className="mb-2 mt-5 text-base font-bold leading-snug text-slate-900 first:mt-0 dark:text-white" {...props} />,
  h2: ({ node: _node, ...props }) => <h3 dir="auto" className="mb-2 mt-5 text-[15px] font-bold leading-snug text-slate-900 first:mt-0 dark:text-white" {...props} />,
  h3: ({ node: _node, ...props }) => <h4 dir="auto" className="mb-1.5 mt-4 text-sm font-bold leading-snug text-slate-900 first:mt-0 dark:text-white" {...props} />,
  h4: ({ node: _node, ...props }) => <h5 dir="auto" className="mb-1 mt-3 text-sm font-semibold first:mt-0" {...props} />,
  h5: ({ node: _node, ...props }) => <h6 dir="auto" className="mb-1 mt-3 text-sm font-semibold first:mt-0" {...props} />,
  h6: ({ node: _node, ...props }) => <h6 dir="auto" className="mb-1 mt-3 text-sm font-semibold first:mt-0" {...props} />,
  // A list's or a quote's own direction puts its markers, its indent and its bar on the side its words start from.
  ul: ({ node, ...props }) => <ul dir={blockDir(node)} className="my-2.5 list-disc space-y-1 ps-5 marker:text-brand-400 dark:marker:text-brand-300" {...props} />,
  ol: ({ node, ...props }) => <ol dir={blockDir(node)} className="my-2.5 list-decimal space-y-1 ps-5 marker:font-semibold marker:text-slate-500 dark:marker:text-slate-400" {...props} />,
  li: ({ node: _node, ...props }) => <li dir="auto" className="ps-1 [&>ol]:my-1 [&>ul]:my-1" {...props} />,
  blockquote: ({ node, ...props }) => (
    <blockquote dir={blockDir(node)} className="my-3 rounded-e-lg border-s-4 border-brand-300 bg-brand-50/60 py-1.5 pe-3 ps-3 text-slate-700 dark:border-brand-500/60 dark:bg-brand-500/10 dark:text-slate-200" {...props} />
  ),
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
