// ============================================================================
// §27 — The coils on a delivery's paper, corrected by the warehouse or by
// quality receiving until the note is closed: the numbers typed or pasted,
// and the paper's photos.
// ============================================================================

import { useMemo, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { RECEIVING_MAX_COILS, coilListText, parseCoilList, type DeliveryNote } from '@qc/shared/receiving'
import { Button, Modal } from '@/components/ui'
import { ImagePicker } from '@/components/inspection/ImagePicker'
import { useUploadsInFlight } from '@/components/inspection/imageUploads'
import { useSaveCoils } from '@/services/receiving'
import { useApp } from '@/store/AppContext'
import { cn } from '@/lib/utils'

export function CoilsDialog({ note, onClose, onSaved }: { note: DeliveryNote; onClose: () => void; onSaved: (n: DeliveryNote) => void }) {
  const { toast } = useApp()
  const save = useSaveCoils(note.id)
  const [text, setText] = useState(() => coilListText(note.coilList))
  const [imageIds, setImageIds] = useState<string[]>(note.imageIds)
  const [uploading, onUploading] = useUploadsInFlight()
  const parsed = useMemo(() => parseCoilList(text), [text])
  const busy = save.isPending || uploading > 0
  const tooMany = parsed.coils.length > RECEIVING_MAX_COILS
  async function submit() {
    try {
      const saved = await save.mutateAsync({ coils: parsed.coils, imageIds, version: note.version })
      toast('Coils saved.', 'success')
      onSaved(saved)
    } catch (error) { toast(error instanceof Error ? error.message : 'Could not save.', 'error') }
  }
  return <Modal open size="lg" title={`Coils of ${note.reference}`} onClose={() => { if (!busy) onClose() }} footer={<>
    <Button variant="ghost" disabled={busy} onClick={onClose}>Cancel</Button>
    <Button variant="primary" disabled={busy || parsed.problems.length > 0 || tooMany} onClick={() => void submit()}>{busy && <Loader2 className="h-4 w-4 animate-spin" />}{uploading ? 'Uploading…' : 'Save'}</Button>
  </>}>
    <div className="space-y-4">
      <label className="block">
        <span className="label">Coils on the supplier’s paper (one a line: coil number, then weight in kg and heat number if given)</span>
        <textarea dir="auto" rows={8} autoFocus className="input font-mono text-sm" value={text} onChange={(e) => setText(e.target.value)} />
        <span className={cn('mt-1 block text-xs', parsed.problems.length || tooMany ? 'text-danger-600' : 'text-muted')} aria-live="polite">
          {parsed.problems.length ? parsed.problems.slice(0, 3).join(' ') : tooMany ? `At most ${RECEIVING_MAX_COILS} coils on one note.` : `${parsed.coils.length} coils.`}
        </span>
      </label>
      <div><span className="label">Photos of the supplier’s paper</span>
        <ImagePicker imageIds={imageIds} onChange={(edit) => setImageIds((ids) => edit(ids))} onUploading={onUploading} lockedReason={save.isPending ? 'Saving…' : undefined} /></div>
    </div>
  </Modal>
}
