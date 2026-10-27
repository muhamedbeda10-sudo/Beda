// §20 — the hidden picker behind a button that attaches files to the next question: `files` takes photos, PDFs and
// spreadsheets (the paperclip); `sheet` a photo of a paper sheet, from the camera on a phone (the scanner, and the
// paper-sheet card). One picker for all of them, so each opens the same way wherever it is pressed.

import { forwardRef } from 'react'
import { ATTACH_ACCEPT } from './attachments'
import { useTakeFiles } from './useTakeFiles'

export const AiFileInput = forwardRef<HTMLInputElement, { kind: 'files' | 'sheet' }>(function AiFileInput({ kind }, ref) {
  const { take } = useTakeFiles()
  return (
    <input
      ref={ref}
      type="file"
      className="hidden"
      tabIndex={-1}
      aria-hidden
      {...(kind === 'sheet' ? { accept: 'image/*', capture: 'environment' as const } : { accept: ATTACH_ACCEPT, multiple: true })}
      onChange={(e) => {
        take(Array.from(e.target.files ?? []))
        e.target.value = ''
      }}
    />
  )
})
