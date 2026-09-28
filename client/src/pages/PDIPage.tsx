import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { NewPdiDialog } from '@/components/pdi/NewPdiDialog'
import { createPdi } from '@/services/mutations'
import { useApp } from '@/store/AppContext'

/**
 * §4 — Pre-Delivery Inspection: the PDI button opens a new record and nothing
 * else. Recorded PDIs are read in History, under PDI.
 */
export function PDIPage() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { toast } = useApp()
  const [saving, setSaving] = useState(false)
  const leave = () => navigate('/', { replace: true })

  async function save(orderIds: string[], notes: string, imageIds: string[]) {
    setSaving(true)
    try {
      await createPdi(queryClient, { orderIds, notes: notes.trim() || undefined, imageIds })
      toast('PDI document saved. It is in History, under PDI.', 'success')
      leave()
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not save.', 'error')
    } finally {
      setSaving(false)
    }
  }

  return <NewPdiDialog onClose={leave} onSave={(ids, notes, images) => void save(ids, notes, images)} saving={saving} />
}
