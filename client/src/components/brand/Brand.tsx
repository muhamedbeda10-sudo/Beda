import { cn } from '@/lib/utils'

/**
 * The company wordmark, drawn the way the official logo is: LINK in the
 * company blue, MISR in the company red, a letter-spaced line beneath. The
 * line reads "Quality Control" here because this is the QC system; the
 * official "Advanced Storage Solutions" version lives in /brand/logo.svg for
 * documents and print.
 */
export function Brand({ size = 'md', withText = true, className }: { size?: 'sm' | 'md' | 'lg'; withText?: boolean; className?: string }) {
  const word = size === 'lg' ? 'text-4xl' : size === 'sm' ? 'text-lg' : 'text-2xl'
  const line = size === 'lg' ? 'text-xs tracking-[0.32em]' : 'text-[9px] tracking-[0.28em]'
  return (
    <div className={cn('flex items-center', className)}>
      <div className="min-w-0 leading-none">
        <p className={cn('font-extrabold uppercase tracking-tight transition-transform duration-300 ease-out hover:scale-[1.02]', word)} style={{ letterSpacing: '-0.03em' }}>
          <span className="text-brand-600 dark:text-brand-300">Link</span>
          <span className="text-accent-500">Misr</span>
        </p>
        {withText && (
          <p className={cn('mt-1 whitespace-nowrap font-semibold uppercase text-brand-700 dark:text-brand-300', line, size !== 'lg' && 'hidden sm:block')}>
            Quality Control
          </p>
        )}
      </div>
    </div>
  )
}
