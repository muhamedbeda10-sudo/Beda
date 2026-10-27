// §20 — what the assistant can do (./capabilities), as cards: a grid in an empty conversation, a list behind the
// question box's sparkles. A tap puts the card's question in the box; the paper-sheet card also opens the picker for a
// photo (the camera, on a phone), which goes with the question: the grid's card with a picker of its own, the list's
// through the box's (the list closes as a card is picked, and a picker gone from the page hands nothing back).

import { useId, useRef, type ReactNode } from 'react'
import {
  AlertTriangle,
  BarChart3,
  BellRing,
  CalendarClock,
  ClipboardCheck,
  FileBarChart,
  FileSpreadsheet,
  FlaskConical,
  ScanLine,
  Sparkles,
  Sunrise,
  TrendingDown,
  Workflow,
  type LucideIcon,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { useAiMe } from '@/services/queries'
import { AI_CAPABILITY_TONE, capabilitiesFor, type AiCapability, type AiCapabilityId } from './capabilities'
import { AiFileInput } from './AiFileInput'
import { useTakeFiles } from './useTakeFiles'

export const CAPABILITY_ICON: Readonly<Record<AiCapabilityId, LucideIcon>> = {
  report: FileBarChart,
  chart: BarChart3,
  excel: FileSpreadsheet,
  'what-if': FlaskConical,
  deadline: CalendarClock,
  briefing: Sunrise,
  wrong: AlertTriangle,
  why: TrendingDown,
  scan: ScanLine,
  diagram: Workflow,
  task: ClipboardCheck,
  automation: BellRing,
}

/** The cards this person is offered, from /ai/me. */
export function useCapabilities(): AiCapability[] {
  const { data: me } = useAiMe()
  return capabilitiesFor(me)
}

/**
 * A card's button: puts its question in the box (`onPick`) and, for the paper-sheet card, opens the picker for a
 * photo there and then, while the tap still counts as the person's own (a browser opens no picker for code alone).
 */
function CapabilityButton({ capability, onPick, className, children }: { capability: AiCapability; onPick: (question: string) => void; className: string; children: ReactNode }) {
  const picker = useRef<HTMLInputElement>(null)
  const { room, blocked, noRoom } = useTakeFiles()
  const photo = capability.photo && !blocked
  return (
    <>
      <button
        type="button"
        dir="auto"
        onClick={() => {
          onPick(capability.question)
          if (!photo) return
          if (room > 0) picker.current?.click()
          else noRoom()
        }}
        className={className}
        aria-label={`${capability.title}: ${capability.hint}`}
      >
        {children}
      </button>
      {photo && <AiFileInput ref={picker} kind="sheet" />}
    </>
  )
}

function CapabilityIcon({ capability, size }: { capability: AiCapability; size: 'md' | 'sm' }) {
  const Icon = CAPABILITY_ICON[capability.id]
  return (
    <span aria-hidden className={cn('grid shrink-0 place-items-center rounded-lg', size === 'md' ? 'h-8 w-8' : 'h-7 w-7', AI_CAPABILITY_TONE[capability.tone])}>
      <Icon className={size === 'md' ? 'h-4 w-4' : 'h-3.5 w-3.5'} />
    </span>
  )
}

/** The grid of an empty conversation: "What it can do". `wide`: the full page, up to four across. */
export function AiCapabilityGrid({ onPick, wide = false }: { onPick: (question: string) => void; wide?: boolean }) {
  const capabilities = useCapabilities()
  const heading = useId()
  return (
    <section aria-labelledby={heading} className="w-full">
      <h3 id={heading} className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted">
        <Sparkles aria-hidden className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" /> What it can do
      </h3>
      <ul className={cn('grid grid-cols-2 gap-2', wide && 'sm:grid-cols-3 lg:grid-cols-4')}>
        {capabilities.map((c) => (
          <li key={c.id} className="flex">
            <CapabilityButton
              capability={c}
              onPick={onPick}
              className="group flex w-full flex-col items-start gap-2 rounded-xl bg-white p-3 text-start shadow-sm ring-1 ring-slate-200 transition hover:-translate-y-px hover:shadow-hover hover:ring-emerald-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 dark:bg-slate-800/80 dark:ring-slate-700 dark:hover:ring-emerald-500/50"
            >
              <CapabilityIcon capability={c} size="md" />
              <span className="min-w-0">
                <span className="block text-13 font-semibold text-slate-800 dark:text-slate-100">{c.title}</span>
                <span className="mt-0.5 block text-xs leading-snug text-muted">{c.hint}</span>
              </span>
            </CapabilityButton>
          </li>
        ))}
      </ul>
    </section>
  )
}

/** The list behind the question box's sparkles: the same cards, a line each. The box acts on the card picked. */
export function AiCapabilityMenu({ onPick }: { onPick: (capability: AiCapability) => void }) {
  const capabilities = useCapabilities()
  return (
    <div role="menu" aria-label="What it can do" className="max-h-[60vh] overflow-y-auto p-1">
      <p className="flex items-center gap-1.5 px-2 pb-1 pt-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted">
        <Sparkles aria-hidden className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" /> What it can do
      </p>
      {capabilities.map((c) => (
        <button
          key={c.id}
          type="button"
          role="menuitem"
          dir="auto"
          onClick={() => onPick(c)}
          className="flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-start hover:bg-slate-100 focus-visible:bg-slate-100 focus-visible:outline-none dark:hover:bg-slate-800 dark:focus-visible:bg-slate-800 touch:min-h-[44px]"
        >
          <CapabilityIcon capability={c} size="sm" />
          <span className="min-w-0">
            <span className="block text-13 font-semibold text-slate-800 dark:text-slate-100">{c.title}</span>
            <span className="block truncate text-xs text-muted">{c.hint}</span>
          </span>
        </button>
      ))}
    </div>
  )
}
