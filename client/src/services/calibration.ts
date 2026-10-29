import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type {
  CalibrationCategory, CalibrationCategoryInput, CalibrationCertificate, CalibrationDepartment, CalibrationDepartmentInput, CalibrationFile, CalibrationImport,
  CalibrationImportResult, CalibrationItem, CalibrationItemDetail, CalibrationItemList, CalibrationItemListQuery, CalibrationOptions, SaveCalibrationCertificateRequest,
  SaveCalibrationItemRequest, ScrapCalibrationItemRequest,
} from '@qc/shared/calibration'
import { api, qs } from '@/lib/api'

const KEY = ['calibration'] as const

export function useCalibrationItems(query: CalibrationItemListQuery) {
  return useQuery({ queryKey: [...KEY, 'items', query], queryFn: () => api<CalibrationItemList>(`/calibration/items${qs({ ...query })}`) })
}
/** Every instrument the filters find, for the Excel file. */
export const fetchAllCalibrationItems = (query: CalibrationItemListQuery) => api<CalibrationItemList>(`/calibration/items${qs({ ...query, offset: 0, limit: 5000 })}`)

export function useCalibrationItem(id: string | null) {
  return useQuery({ queryKey: [...KEY, 'item', id], queryFn: () => api<CalibrationItemDetail>(`/calibration/items/${id}`), enabled: !!id, staleTime: 0 })
}
export function useCalibrationOptions() {
  return useQuery({ queryKey: [...KEY, 'options'], queryFn: () => api<CalibrationOptions>('/calibration/options') })
}

function useInvalidate() {
  const client = useQueryClient()
  return () => Promise.all([client.invalidateQueries({ queryKey: KEY }), client.invalidateQueries({ queryKey: ['audit'] })])
}

export function useSaveCalibrationItem(id?: string) {
  const client = useQueryClient()
  const invalidate = useInvalidate()
  return useMutation({
    mutationFn: (body: SaveCalibrationItemRequest) => api<CalibrationItem>(`/calibration/items${id ? `/${id}` : ''}`, { method: id ? 'PUT' : 'POST', body }),
    onSuccess: invalidate,
    onError: () => { if (id) void client.invalidateQueries({ queryKey: [...KEY, 'item', id] }) },
  })
}
export function useScrapCalibrationItem(id: string) {
  const invalidate = useInvalidate()
  return useMutation({ mutationFn: (body: ScrapCalibrationItemRequest) => api<CalibrationItem>(`/calibration/items/${id}/scrap`, { method: 'POST', body }), onSuccess: invalidate })
}
export function useRestoreCalibrationItem(id: string) {
  const invalidate = useInvalidate()
  return useMutation({ mutationFn: (version: number) => api<CalibrationItem>(`/calibration/items/${id}/restore`, { method: 'POST', body: { version } }), onSuccess: invalidate })
}
export function useDeleteCalibrationItem() {
  const invalidate = useInvalidate()
  return useMutation({ mutationFn: (id: string) => api<void>(`/calibration/items/${id}`, { method: 'DELETE' }), onSuccess: invalidate })
}

export function useSaveCalibrationCertificate(id?: string) {
  const invalidate = useInvalidate()
  return useMutation({
    mutationFn: (body: SaveCalibrationCertificateRequest) => api<CalibrationCertificate>(`/calibration/certificates${id ? `/${id}` : ''}`, { method: id ? 'PUT' : 'POST', body }),
    onSuccess: invalidate,
  })
}
export function useDeleteCalibrationCertificate() {
  const invalidate = useInvalidate()
  return useMutation({ mutationFn: (id: string) => api<void>(`/calibration/certificates/${id}`, { method: 'DELETE' }), onSuccess: invalidate })
}
/** An outside laboratory's certificate, as its PDF. */
export function uploadCalibrationFile(file: File) {
  const form = new FormData()
  form.append('file', file, file.name)
  return api<CalibrationFile>('/calibration/files', { method: 'POST', form })
}
export const calibrationFilePath = (id: string) => `/calibration/files/${id}/content`

export function useSaveCalibrationCategory(id?: string) {
  const invalidate = useInvalidate()
  return useMutation({
    mutationFn: (body: CalibrationCategoryInput) => api<CalibrationCategory>(`/calibration/categories${id ? `/${id}` : ''}`, { method: id ? 'PUT' : 'POST', body }),
    onSuccess: invalidate,
  })
}
export function useDeleteCalibrationCategory() {
  const invalidate = useInvalidate()
  return useMutation({ mutationFn: (id: string) => api<void>(`/calibration/categories/${id}`, { method: 'DELETE' }), onSuccess: invalidate })
}
export function useSaveCalibrationDepartment(id?: string) {
  const invalidate = useInvalidate()
  return useMutation({
    mutationFn: (body: CalibrationDepartmentInput) => api<CalibrationDepartment>(`/calibration/departments${id ? `/${id}` : ''}`, { method: id ? 'PUT' : 'POST', body }),
    onSuccess: invalidate,
  })
}
export function useDeleteCalibrationDepartment() {
  const invalidate = useInvalidate()
  return useMutation({ mutationFn: (id: string) => api<void>(`/calibration/departments/${id}`, { method: 'DELETE' }), onSuccess: invalidate })
}
export const importCalibration = (body: CalibrationImport) => api<CalibrationImportResult>('/calibration/import', { method: 'POST', body })
export function useInvalidateCalibration() {
  return useInvalidate()
}
