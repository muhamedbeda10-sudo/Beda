import { useEffect, useRef } from 'react'
import { cn } from '@/lib/utils'
import { EMOJI_GROUPS, QUICK_REACTIONS } from './emoji'

export function EmojiPicker({ onPick, onClose, className }: { onPick: (emoji: string) => void; onClose: () => void; className?: string }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose()
    }
    const key = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', key)
    return () => {
      document.removeEventListener('mousedown', close)
      document.removeEventListener('keydown', key)
    }
  }, [onClose])
  return (
    <div ref={ref} className={cn('z-30 max-h-64 w-72 overflow-y-auto rounded-2xl bg-white p-2 shadow-lift ring-1 ring-slate-200 animate-scale-in dark:bg-slate-900 dark:ring-slate-700', className)} role="dialog" aria-label="Emoji">
      <div className="mb-1 flex flex-wrap gap-0.5 border-b border-slate-100 pb-1 dark:border-slate-800">
        {QUICK_REACTIONS.map((e) => (
          <button key={e} type="button" onClick={() => onPick(e)} className="rounded-lg p-1 text-xl hover:bg-slate-100 dark:hover:bg-slate-800">
            {e}
          </button>
        ))}
      </div>
      {EMOJI_GROUPS.map((g) => (
        <div key={g.label}>
          <p className="px-1 pt-1 text-[10px] font-bold uppercase tracking-wide text-slate-400">{g.label}</p>
          <div className="flex flex-wrap gap-0.5">
            {g.emojis.map((e) => (
              <button key={e} type="button" onClick={() => onPick(e)} className="rounded-lg p-1 text-xl hover:bg-slate-100 dark:hover:bg-slate-800">
                {e}
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}
