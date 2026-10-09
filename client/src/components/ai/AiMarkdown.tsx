// ============================================================================
// §20 — an answer's text: markdown (GFM tables, lists, code), drawn as React
// elements, never as HTML. Hardened because the model's words can echo text
// people typed into the record: raw HTML is skipped, images are unwrapped to
// their words (no remote beacons), and a link is followed only when it is a
// page of this application or a plain web address (./links). Styled here,
// with logical properties, so an Arabic answer lays out right to left.
// ============================================================================

import { memo, type AnchorHTMLAttributes, type ReactNode } from 'react'
import Markdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { useNavigate } from 'react-router-dom'
import { ExternalLink } from 'lucide-react'
import { useAi } from './AiAssistantProvider'
import { aiUrlTransform, classifyAiLink } from './links'

const REMARK = [remarkGfm]
const DISALLOWED = ['img']
const LINK = 'font-semibold text-brand-700 underline decoration-brand-300 underline-offset-2 hover:decoration-brand-600 dark:text-brand-300 dark:decoration-brand-500/50'

function MdLink({ href, children }: AnchorHTMLAttributes<HTMLAnchorElement> & { children?: ReactNode }) {
  const navigate = useNavigate()
  const { docked, setOpen } = useAi()
  const link = classifyAiLink(href)
  if (!link) return <span>{children}</span>
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
        // A modified click opens a new tab as any link does; a plain one moves the app, and a sheet steps aside.
        if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
        e.preventDefault()
        navigate(link.to)
        if (!docked) setOpen(false)
      }}
    >
      {children}
    </a>
  )
}

// `node` (the syntax tree) is passed to every component; it is taken out so it never reaches the DOM.
const components: Components = {
  a: ({ node: _node, ...props }) => <MdLink {...props} />,
  p: ({ node: _node, ...props }) => <p dir="auto" className="my-2 first:mt-0 last:mb-0" {...props} />,
  h1: ({ node: _node, ...props }) => <h3 dir="auto" className="mb-1.5 mt-4 text-base font-bold first:mt-0" {...props} />,
  h2: ({ node: _node, ...props }) => <h3 dir="auto" className="mb-1.5 mt-4 text-[15px] font-bold first:mt-0" {...props} />,
  h3: ({ node: _node, ...props }) => <h4 dir="auto" className="mb-1 mt-3 text-sm font-bold first:mt-0" {...props} />,
  h4: ({ node: _node, ...props }) => <h5 dir="auto" className="mb-1 mt-3 text-sm font-semibold first:mt-0" {...props} />,
  h5: ({ node: _node, ...props }) => <h6 dir="auto" className="mb-1 mt-3 text-sm font-semibold first:mt-0" {...props} />,
  h6: ({ node: _node, ...props }) => <h6 dir="auto" className="mb-1 mt-3 text-sm font-semibold first:mt-0" {...props} />,
  ul: ({ node: _node, ...props }) => <ul className="my-2 list-disc space-y-0.5 ps-5 marker:text-slate-400" {...props} />,
  ol: ({ node: _node, ...props }) => <ol className="my-2 list-decimal space-y-0.5 ps-5 marker:text-slate-400" {...props} />,
  li: ({ node: _node, ...props }) => <li dir="auto" className="ps-0.5" {...props} />,
  blockquote: ({ node: _node, ...props }) => <blockquote dir="auto" className="my-2 border-s-4 border-slate-200 ps-3 text-slate-600 dark:border-slate-700 dark:text-slate-300" {...props} />,
  strong: ({ node: _node, ...props }) => <strong className="font-semibold text-slate-900 dark:text-white" {...props} />,
  hr: () => <hr className="my-3 border-slate-200 dark:border-slate-700" />,
  code: ({ node: _node, className: _lang, ...props }) => <code dir="ltr" className="rounded bg-slate-100 px-1 py-0.5 font-mono text-[0.85em] text-slate-800 dark:bg-slate-800 dark:text-slate-100" {...props} />,
  pre: ({ node: _node, ...props }) => (
    <pre
      dir="ltr"
      className="my-2 overflow-x-auto rounded-xl bg-slate-900 p-3 text-xs leading-relaxed text-slate-100 ring-1 ring-slate-800 [&_code]:bg-transparent [&_code]:p-0 [&_code]:text-[length:inherit] [&_code]:text-slate-100 dark:[&_code]:bg-transparent"
      {...props}
    />
  ),
  table: ({ node: _node, ...props }) => (
    <div className="my-2 overflow-x-auto rounded-xl ring-1 ring-slate-200 dark:ring-slate-800">
      <table className="w-full text-[13px]" {...props} />
    </div>
  ),
  thead: ({ node: _node, ...props }) => <thead className="bg-slate-50 dark:bg-slate-800/60" {...props} />,
  tbody: ({ node: _node, ...props }) => <tbody className="divide-y divide-slate-100 dark:divide-slate-800" {...props} />,
  th: ({ node: _node, ...props }) => <th dir="auto" className="whitespace-nowrap px-2.5 py-1.5 text-start text-[11px] font-bold uppercase tracking-wide text-muted" {...props} />,
  td: ({ node: _node, ...props }) => <td dir="auto" className="px-2.5 py-1.5 align-top" {...props} />,
}

/** Markdown text, drawn safely. Memoised: a finished answer is parsed once, not on every frame of the next one. */
export const AiMarkdown = memo(function AiMarkdown({ text }: { text: string }) {
  return (
    <div dir="auto" className="break-words text-sm leading-relaxed text-slate-800 dark:text-slate-100">
      <Markdown remarkPlugins={REMARK} components={components} disallowedElements={DISALLOWED} unwrapDisallowed skipHtml urlTransform={aiUrlTransform}>
        {text}
      </Markdown>
    </div>
  )
})
