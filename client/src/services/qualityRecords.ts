import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { QualityKind, QualityRecord, QualityRecordList, QualityRecordListQuery, QualityRecordOptions, QualityOrder, QualityItem, SaveQualityRecordRequest } from '@qc/shared/qualityRecords'
import { QUALITY_FORMS } from '@qc/shared/qualityRecords'
import { api, qs } from '@/lib/api'

const path = (kind: QualityKind) => QUALITY_FORMS[kind].path
export function useQualityRecords(kind: QualityKind, query: QualityRecordListQuery) {
  return useQuery({ queryKey: ['quality-records', kind, 'list', query], queryFn: () => api<QualityRecordList>(`${path(kind)}${qs({ ...query })}`) })
}
export function useQualityRecord(kind: QualityKind, id: string | null) {
  return useQuery({ queryKey: ['quality-records', kind, 'record', id], queryFn: () => api<QualityRecord>(`${path(kind)}/${id}`), enabled: !!id, staleTime: 0 })
}
export function useQualityOptions(kind: QualityKind) {
  return useQuery({ queryKey: ['quality-records', kind, 'options'], queryFn: () => api<QualityRecordOptions>(`${path(kind)}/options`) })
}
export function useQualityOrders(kind: QualityKind, q: string) {
  return useQuery({ queryKey: ['quality-records', kind, 'orders', q], queryFn: () => api<QualityOrder[]>(`${path(kind)}/orders${qs({ q })}`) })
}
export function useQualityItems(kind: QualityKind, orderNumber: string, q: string) {
  return useQuery({ queryKey: ['quality-records', kind, 'items', orderNumber, q], queryFn: () => api<QualityItem[]>(`${path(kind)}/items${qs({ orderNumber, q })}`), enabled: !!orderNumber })
}
export function useSaveQualityRecord(kind: QualityKind, id?: string) {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (body: SaveQualityRecordRequest) => api<QualityRecord>(`${path(kind)}${id ? `/${id}` : ''}`, { method: id ? 'PUT' : 'POST', body }),
    onSuccess: async () => { await Promise.all([client.invalidateQueries({ queryKey: ['quality-records', kind] }), client.invalidateQueries({ queryKey: ['audit'] })]) },
    onError: () => { if (id) void client.invalidateQueries({ queryKey: ['quality-records', kind, 'record', id] }) },
  })
}
