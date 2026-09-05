import { useState } from 'react'
import { cn } from '@/lib/utils'

/**
 * The company mark and product name.
 *
 * The mark is `/brand/logo.png` when that file is present in `client/public/brand`
 * (drop the official logo there — nothing else changes), and the built-in SVG
 * mark otherwise. Sizes are fixed so the header never jumps while the image
 * loads or falls back.
 */
export function Brand({ size = 'md', withText = true, className }: { size?: 'sm' | 'md' | 'lg'; withText?: boolean; className?: string }) {
  const [fallback, setFallback] = useState(false)
  const box = size === 'lg' ? 'h-16 w-16 rounded-2xl' : size === 'sm' ? 'h-8 w-8 rounded-lg' : 'h-10 w-10 rounded-xl'
  return (
    <div className={cn('flex items-center gap-3', className)}>
      <span className={cn('grid shrink-0 place-items-center overflow-hidden bg-brand-800 shadow-card transition-transform duration-300 ease-out hover:rotate-[-4deg] hover:scale-105', box)}>
        <img
          src={fallback ? '/brand/mark.svg' : '/brand/logo.png'}
          alt="LinkMisr"
          className="h-full w-full object-contain"
          onError={() => setFallback(true)}
          draggable={false}
        />
      </span>
      {withText && (
        <div className="min-w-0 leading-none">
          <p className={cn('font-extrabold tracking-tight text-brand-900 dark:text-white', size === 'lg' ? 'text-2xl' : 'text-base')}>
            Link<span className="text-accent-500">Misr</span>
          </p>
          <p className={cn('mt-1 whitespace-nowrap font-semibold uppercase tracking-[0.18em] text-slate-500 dark:text-slate-400', size === 'lg' ? 'text-xs' : 'hidden text-[10px] sm:block')}>
            Quality Control
          </p>
        </div>
      )}
    </div>
  )
}
