import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { CreateScrapRequest, ScrapListQuery, ScrapListResponse, ScrapOptions, ScrapRecord, ScrapType, UpdateScrapRequest } from '@qc/shared/scrap'
import { api, qs } from '@/lib/api'

export const scrapKeys = {
  all: ['scrap'] as const,
  options: ['scrap', 'options'] as const,
  list: (query: ScrapListQuery) => ['scrap', 'list', query] as const,
}

export function useScrapList(query: ScrapListQuery) {
  return useQuery({ queryKey: scrapKeys.list(query), queryFn: () => api<ScrapListResponse>(`/scrap${qs({ ...query })}`), placeholderData: (previous) => previous })
}

export function useScrapOptions() {
  return useQuery({ queryKey: scrapKeys.options, queryFn: () => api<ScrapOptions>('/scrap/options') })
}

/** Every record the filters match (up to MAX_SCRAP_EXPORT), in one read, for the Excel export. */
export function loadScrapExport(query: Omit<ScrapListQuery, 'offset' | 'limit'>): Promise<ScrapRecord[]> {
  return api<ScrapRecord[]>(`/scrap/export${qs({ ...query })}`)
}

function useRefreshScrap() {
  const client = useQueryClient()
  return () => Promise.all([
    client.invalidateQueries({ queryKey: scrapKeys.all }),
    client.invalidateQueries({ queryKey: ['audit'] }),
  ])
}

export function useCreateScrap() {
  const refresh = useRefreshScrap()
  return useMutation({
    mutationFn: (body: CreateScrapRequest) => api<ScrapRecord>('/scrap', { method: 'POST', body }),
    onSuccess: () => refresh(),
  })
}

export function useUpdateScrap() {
  const refresh = useRefreshScrap()
  return useMutation({
    mutationFn: ({ id, ...body }: UpdateScrapRequest & { id: string }) => api<ScrapRecord>(`/scrap/${id}`, { method: 'PUT', body }),
    onSuccess: () => refresh(),
  })
}

export function useDeleteScrap() {
  const refresh = useRefreshScrap()
  return useMutation({
    mutationFn: (record: Pick<ScrapRecord, 'id' | 'version'>) => api<void>(`/scrap/${record.id}${qs({ version: record.version })}`, { method: 'DELETE' }),
    onSuccess: () => refresh(),
  })
}

export function useAddScrapType() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (name: string) => api<ScrapType>('/scrap/types', { method: 'POST', body: { name } }),
    onSuccess: (type) => {
      client.setQueryData<ScrapOptions>(scrapKeys.options, (old) => old ? {
        ...old,
        types: [...old.types.filter((t) => t.id !== type.id), type].sort((a, b) => a.name.localeCompare(b.name)),
      } : old)
      void client.invalidateQueries({ queryKey: ['audit'] })
    },
  })
}
