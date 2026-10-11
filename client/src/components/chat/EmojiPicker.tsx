import { useEffect, useRef, type RefObject } from 'react'
import { cn } from '@/lib/utils'
import { EMOJI_GROUPS, QUICK_REACTIONS } from './emoji'

/**
 * The emoji, the quick reactions first. It closes on Escape and on a press
 * outside it — but not on its own button (`trigger`), whose tap then closes
 * it as a toggle instead of opening it again. `sheet`: drawn inside a
 * ChatSheet, which gives it its frame, its height and its backdrop.
 */
export function EmojiPicker({ onPick, onClose, className, trigger, sheet = false }: { onPick: (emoji: string) => void; onClose: () => void; className?: string; trigger?: RefObject<HTMLElement>; sheet?: boolean }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    // In a sheet, the sheet's backdrop and Escape close it.
    if (sheet) return
    const close = (e: MouseEvent) => {
      const target = e.target as Node
      if (ref.current?.contains(target) || trigger?.current?.contains(target)) return
      onClose()
    }
    const key = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', key)
    return () => {
      document.removeEventListener('mousedown', close)
      document.removeEventListener('keydown', key)
    }
  }, [onClose, trigger, sheet])
  // 32 px under a mouse; 44 px for a finger.
  const btn = 'grid h-8 w-8 place-items-center rounded-lg text-xl hover:bg-slate-100 dark:hover:bg-slate-800 touch:h-11 touch:w-11 touch:text-2xl'
  return (
    <div
      ref={ref}
      className={cn(
        'z-30 overflow-y-auto',
        sheet ? 'w-full p-1' : 'max-h-64 w-72 max-w-[calc(100vw-2rem)] rounded-2xl bg-white p-2 shadow-lift ring-1 ring-slate-200 animate-scale-in dark:bg-slate-900 dark:ring-slate-700 touch:max-h-80',
        className,
      )}
      role={sheet ? undefined : 'dialog'}
      aria-label={sheet ? undefined : 'Emoji'}
    >
      <div className="mb-1 flex flex-wrap gap-0.5 border-b border-slate-100 pb-1 dark:border-slate-800">
        {QUICK_REACTIONS.map((e) => (
          <button key={e} type="button" onClick={() => onPick(e)} className={btn}>
            {e}
          </button>
        ))}
      </div>
      {EMOJI_GROUPS.map((g) => (
        <div key={g.label}>
          <p className="px-1 pt-1 text-[10px] font-bold uppercase tracking-wide text-muted">{g.label}</p>
          <div className="flex flex-wrap gap-0.5">
            {g.emojis.map((e) => (
              <button key={e} type="button" onClick={() => onPick(e)} className={btn}>
                {e}
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}
