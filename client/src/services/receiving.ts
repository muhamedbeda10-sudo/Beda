import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type {
  CoilDelivery, DeliveredCoilInput, DeliveredCoilList, DeliveredCoilListQuery, DeliveryNote, DeliveryNoteInput, DeliveryNoteList, DeliveryNoteListQuery, PurchaseOrder,
  PurchaseOrderImportResult, PurchaseOrderImportRow, PurchaseOrderInput, PurchaseOrderLineInput, PurchaseOrderList, ReceivedItemList, ReceivedItemListQuery,
  ReceivingDecisionInput, ReceivingList, ReceivingListValue, ReceivingOptions,
} from '@qc/shared/receiving'
import { api, qs } from '@/lib/api'

const KEY = ['receiving'] as const

export function useReceivingOptions() {
  return useQuery({ queryKey: [...KEY, 'options'], queryFn: () => api<ReceivingOptions>('/receiving/options'), staleTime: 60_000 })
}

export function useDeliveryNotes(query: DeliveryNoteListQuery) {
  return useQuery({ queryKey: [...KEY, 'notes', query], queryFn: () => api<DeliveryNoteList>(`/receiving/notes${qs({ ...query })}`) })
}
export function useDeliveryNote(id: string | null) {
  return useQuery({ queryKey: [...KEY, 'note', id], queryFn: () => api<DeliveryNote>(`/receiving/notes/${id}`), enabled: !!id, staleTime: 0 })
}
export function useReceivedItems(query: ReceivedItemListQuery) {
  return useQuery({ queryKey: [...KEY, 'items', query], queryFn: () => api<ReceivedItemList>(`/receiving/items${qs({ ...query })}`) })
}
/** Every item the filters find, for the register's Excel file. */
export const fetchAllReceivedItems = (query: ReceivedItemListQuery) => api<ReceivedItemList>(`/receiving/items${qs({ ...query, offset: 0, limit: 5000 })}`)

export function useDeliveredCoils(query: DeliveredCoilListQuery) {
  return useQuery({ queryKey: [...KEY, 'coils', query], queryFn: () => api<DeliveredCoilList>(`/receiving/coils${qs({ ...query })}`) })
}
export const fetchAllDeliveredCoils = (query: DeliveredCoilListQuery) => api<DeliveredCoilList>(`/receiving/coils${qs({ ...query, offset: 0, limit: 5000 })}`)

export function usePurchaseOrders(query: { q?: string; offset?: number; limit?: number }) {
  return useQuery({ queryKey: [...KEY, 'pos', query], queryFn: () => api<PurchaseOrderList>(`/receiving/purchase-orders${qs({ ...query })}`) })
}
export function usePurchaseOrder(id: string | null) {
  return useQuery({ queryKey: [...KEY, 'po', id], queryFn: () => api<PurchaseOrder>(`/receiving/purchase-orders/${id}`), enabled: !!id, staleTime: 0 })
}
/** The PO the warehouse typed the number of; null while nothing is typed. */
export function usePurchaseOrderByNumber(number: string) {
  const n = number.trim()
  return useQuery({ queryKey: [...KEY, 'po-number', n.toLowerCase()], queryFn: () => api<PurchaseOrder>(`/receiving/purchase-orders/lookup${qs({ number: n })}`), enabled: n.length > 0, retry: false, staleTime: 0 })
}

function useInvalidate() {
  const client = useQueryClient()
  return () => Promise.all([client.invalidateQueries({ queryKey: KEY }), client.invalidateQueries({ queryKey: ['audit'] })])
}
export const useInvalidateReceiving = useInvalidate

export function useSaveDeliveryNote(id?: string) {
  const invalidate = useInvalidate()
  return useMutation({
    mutationFn: (body: DeliveryNoteInput & { submissionId?: string; version?: number }) => api<DeliveryNote>(`/receiving/notes${id ? `/${id}` : ''}`, { method: id ? 'PUT' : 'POST', body }),
    onSettled: invalidate,
  })
}
export function useSaveCoils(id: string) {
  const invalidate = useInvalidate()
  return useMutation({
    mutationFn: (body: { coils: DeliveredCoilInput[]; imageIds: string[]; version: number }) => api<DeliveryNote>(`/receiving/notes/${id}/coils`, { method: 'PUT', body }),
    onSettled: invalidate,
  })
}
export function useDecideLine(noteId: string) {
  const invalidate = useInvalidate()
  return useMutation({
    mutationFn: ({ lineId, ...body }: ReceivingDecisionInput & { lineId: string }) => api<DeliveryNote>(`/receiving/notes/${noteId}/lines/${lineId}/decision`, { method: 'POST', body }),
    onSettled: invalidate,
  })
}
export function useCloseNote(noteId: string) {
  const invalidate = useInvalidate()
  return useMutation({ mutationFn: (version: number) => api<DeliveryNote>(`/receiving/notes/${noteId}/close`, { method: 'POST', body: { version } }), onSettled: invalidate })
}
export function useReopenNote(noteId: string) {
  const invalidate = useInvalidate()
  return useMutation({ mutationFn: (body: { version: number; reason: string }) => api<DeliveryNote>(`/receiving/notes/${noteId}/reopen`, { method: 'POST', body }), onSettled: invalidate })
}
export function useDeleteNote() {
  const invalidate = useInvalidate()
  return useMutation({ mutationFn: (id: string) => api<void>(`/receiving/notes/${id}`, { method: 'DELETE' }), onSuccess: invalidate })
}

export function useSavePurchaseOrder(id?: string) {
  const invalidate = useInvalidate()
  return useMutation({
    mutationFn: (body: Omit<PurchaseOrderInput, 'lines'> & { lines: (PurchaseOrderLineInput & { id?: string })[]; version?: number }) =>
      api<PurchaseOrder>(`/receiving/purchase-orders${id ? `/${id}` : ''}`, { method: id ? 'PUT' : 'POST', body }),
    onSettled: invalidate,
  })
}
export function useDeletePurchaseOrder() {
  const invalidate = useInvalidate()
  return useMutation({ mutationFn: (id: string) => api<void>(`/receiving/purchase-orders/${id}`, { method: 'DELETE' }), onSuccess: invalidate })
}
export const importPurchaseOrders = (rows: PurchaseOrderImportRow[]) => api<PurchaseOrderImportResult>('/receiving/purchase-orders/import', { method: 'POST', body: { rows } })

export function useAddReceivingListValue() {
  const invalidate = useInvalidate()
  return useMutation({ mutationFn: (body: { list: ReceivingList; value: string }) => api<ReceivingListValue>('/receiving/lists', { method: 'POST', body }), onSuccess: invalidate })
}
export function useDeleteReceivingListValue() {
  const invalidate = useInvalidate()
  return useMutation({ mutationFn: (id: string) => api<void>(`/receiving/lists/${id}`, { method: 'DELETE' }), onSuccess: invalidate })
}
/** The deliveries the coils on Coil search came on. */
export function useDeliveriesOfCoils(numbers: string[], enabled: boolean) {
  const key = Array.from(new Set(numbers.map((x) => x.toLowerCase()))).sort().join(',')
  return useQuery({ queryKey: [...KEY, 'by-coils', key], queryFn: () => api<CoilDelivery[]>(`/receiving/by-coils${qs({ numbers: key })}`), enabled: enabled && key.length > 0 })
}
