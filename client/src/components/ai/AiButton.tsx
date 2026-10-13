// §20 — the door to the AI assistant: a round button floating in the bottom corner of every page, above any bar
// along the bottom (index.css: .ai-fab). It opens the popup where it was left; while the popup is open the button
// steps aside for it. It pulses while an answer is being written, so a person who closed the popup sees it is busy.

import { Bot } from 'lucide-react'
import { useAi } from './AiAssistantProvider'

export function AiButton() {
  const { open, setOpen, busy } = useAi()
  if (open) return null
  return (
    <button
      type="button"
      onClick={() => setOpen(true)}
      className="ai-fab fixed z-40 grid h-14 w-14 place-items-center rounded-full bg-gradient-to-br from-brand-600 to-brand-800 text-white shadow-lift ring-4 ring-white transition-transform duration-200 hover:scale-105 focus:outline-none focus-visible:ring-brand-300 active:scale-95 animate-fade-in print:hidden dark:ring-slate-900"
      aria-label={busy ? 'AI assistant, answering' : 'AI assistant'}
      aria-haspopup="dialog"
      aria-expanded={false}
      data-tip={busy ? 'AI assistant — answering…' : 'AI assistant — ask about the data'}
    >
      <Bot className="h-7 w-7" />
      {busy && <span aria-hidden className="absolute right-0.5 top-0.5 h-3 w-3 animate-pulse rounded-full bg-accent-500 ring-2 ring-white dark:ring-slate-900" />}
    </button>
  )
}

