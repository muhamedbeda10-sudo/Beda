import { Download, Share, X } from 'lucide-react'
import { Button } from '@/components/ui'
import { useInstallPrompt } from '@/lib/install'

/**
 * Offer to put the app on the home screen. Shown until installed or
 * dismissed; on iOS it can only explain the share-sheet route.
 */
export function InstallBanner() {
  const { mode, install, dismiss } = useInstallPrompt()
  if (mode === 'none') return null
  return (
    <div className="card flex flex-wrap items-center gap-3 border-l-4 border-l-brand-600 p-4 animate-scale-in">
      <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-brand-100 text-brand-700 dark:bg-brand-500/15 dark:text-brand-200">
        <Download className="h-5 w-5" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="font-bold">Install LinkMisr QC on this device</p>
        <p className="text-sm text-slate-500 dark:text-slate-400">
          {mode === 'prompt' ? (
            'Opens full screen from the home screen, like an app.'
          ) : (
            <>
              In Safari tap <Share className="inline h-4 w-4 align-text-bottom" /> Share, then <strong>Add to Home Screen</strong>.
            </>
          )}
        </p>
      </div>
      <div className="flex gap-2">
        {mode === 'prompt' && (
          <Button variant="primary" className="min-h-[44px]" onClick={() => void install()}>
            <Download className="h-4 w-4" /> Install
          </Button>
        )}
        <button type="button" onClick={dismiss} className="icon-btn" aria-label="Not now">
          <X className="h-5 w-5" />
        </button>
      </div>
    </div>
  )
}
