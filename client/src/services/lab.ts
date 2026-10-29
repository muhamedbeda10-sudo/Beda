import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { LabCoilLookup, LabCoilTest, LabGrade, LabGradeInput, LabImportResult, LabList, LabListValue, LabLogRow, LabOptions, LabTest, LabTestList, LabTestListQuery, SaveLabTestRequest } from '@qc/shared/lab'
import { api, qs } from '@/lib/api'

const KEY = ['lab'] as const

export function useLabTests(query: LabTestListQuery) {
  return useQuery({ queryKey: [...KEY, 'list', query], queryFn: () => api<LabTestList>(`/lab${qs({ ...query })}`) })
}
/** Every test the filters find, for the log's Excel file. */
export const fetchAllLabTests = (query: LabTestListQuery) => api<LabTestList>(`/lab${qs({ ...query, offset: 0, limit: 5000 })}`)

export function useLabTest(id: string | null) {
  return useQuery({ queryKey: [...KEY, 'test', id], queryFn: () => api<LabTest>(`/lab/${id}`), enabled: !!id, staleTime: 0 })
}
export function useLabOptions() {
  return useQuery({ queryKey: [...KEY, 'options'], queryFn: () => api<LabOptions>('/lab/options') })
}
/** What the coil register and the lab know of a specimen code. */
export function useLabCoil(number: string, enabled = true) {
  return useQuery({ queryKey: [...KEY, 'coil', number.toLowerCase()], queryFn: () => api<LabCoilLookup>(`/lab/coil${qs({ number })}`), enabled: enabled && number.trim().length > 0, staleTime: 30_000 })
}

function useInvalidate() {
  const client = useQueryClient()
  return () => Promise.all([client.invalidateQueries({ queryKey: KEY }), client.invalidateQueries({ queryKey: ['audit'] })])
}

export function useSaveLabTest(id?: string) {
  const client = useQueryClient()
  const invalidate = useInvalidate()
  return useMutation({
    mutationFn: (body: SaveLabTestRequest) => api<LabTest>(`/lab${id ? `/${id}` : ''}`, { method: id ? 'PUT' : 'POST', body }),
    onSuccess: invalidate,
    onError: () => { if (id) void client.invalidateQueries({ queryKey: [...KEY, 'test', id] }) },
  })
}
export function useDeleteLabTest() {
  const invalidate = useInvalidate()
  return useMutation({ mutationFn: (id: string) => api<void>(`/lab/${id}`, { method: 'DELETE' }), onSuccess: invalidate })
}

export function useSaveLabGrade(id?: string) {
  const invalidate = useInvalidate()
  return useMutation({ mutationFn: (body: LabGradeInput) => api<LabGrade>(`/lab/grades${id ? `/${id}` : ''}`, { method: id ? 'PUT' : 'POST', body }), onSuccess: invalidate })
}
export function useDeleteLabGrade() {
  const invalidate = useInvalidate()
  return useMutation({ mutationFn: (id: string) => api<void>(`/lab/grades/${id}`, { method: 'DELETE' }), onSuccess: invalidate })
}
export function useAddLabListValue() {
  const invalidate = useInvalidate()
  return useMutation({ mutationFn: (body: { list: LabList; value: string }) => api<LabListValue>('/lab/lists', { method: 'POST', body }), onSuccess: invalidate })
}
export function useDeleteLabListValue() {
  const invalidate = useInvalidate()
  return useMutation({ mutationFn: (id: string) => api<void>(`/lab/lists/${id}`, { method: 'DELETE' }), onSuccess: invalidate })
}
export const importLabLog = (rows: LabLogRow[]) => api<LabImportResult>('/lab/import', { method: 'POST', body: { rows } })
/** The lab's tests of the coils on Coil search. */
export function useLabTestsOfCoils(numbers: string[], enabled: boolean) {
  const key = Array.from(new Set(numbers.map((x) => x.toLowerCase()))).sort().join(',')
  return useQuery({ queryKey: [...KEY, 'by-coils', key], queryFn: () => api<LabCoilTest[]>(`/lab/by-coils${qs({ numbers: key })}`), enabled: enabled && key.length > 0 })
}
export function useInvalidateLab() {
  return useInvalidate()
}
