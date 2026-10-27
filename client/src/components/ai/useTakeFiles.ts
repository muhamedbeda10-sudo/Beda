// §20 — files taken for the next question, from wherever they were picked (the paperclip, the camera, a paste, a drop,
// the paper-sheet card): as many as the question has room for, saying what could not be taken.

import { useCallback } from 'react'
import { AI_MAX_ATTACHMENTS_PER_QUESTION } from '@qc/shared/ai'
import { useApp } from '@/store/AppContext'
import { useAiMe } from '@/services/queries'
import { aiBlock } from './access'
import { useAi } from './AiAssistantProvider'

export function useTakeFiles(): { take: (files: readonly File[]) => void; room: number; blocked: boolean; noRoom: () => void } {
  const { attachments, attach } = useAi()
  const { data: me } = useAiMe()
  const { toast } = useApp()
  const blocked = !!aiBlock(me)
  const room = AI_MAX_ATTACHMENTS_PER_QUESTION - attachments.length
  // A photo asked for (the paper-sheet card) when the question has no room for another file: said, not silently skipped.
  const noRoom = useCallback(() => toast(`A question may carry at most ${AI_MAX_ATTACHMENTS_PER_QUESTION} files.`, 'warning'), [toast])
  const take = useCallback(
    (files: readonly File[]) => {
      if (files.length === 0 || blocked) return
      if (room <= 0) {
        noRoom()
        return
      }
      const refused = attach(files.slice(0, room))
      if (files.length > room) toast(`A question may carry at most ${AI_MAX_ATTACHMENTS_PER_QUESTION} files: the rest were left out.`, 'warning')
      if (refused.length > 0) toast(`Only photos, PDFs and spreadsheets (.xlsx, .csv) can be attached: ${refused.join(', ')}.`, 'error')
    },
    [attach, blocked, room, toast, noRoom],
  )
  return { take, room, blocked, noRoom }
}
