import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { Concession, ConcessionCategory, ConcessionItem, ConcessionListQuery, ConcessionListResponse, ConcessionOptions, CreateConcessionRequest } from '@qc/shared/concessions'
import { api, qs } from '@/lib/api'

export const concessionKeys = {
  all: ['concessions'] as const,
  options: ['concessions', 'options'] as const,
  list: (query: ConcessionListQuery) => ['concessions', 'list', query] as const,
}

export function useConcessions(query: ConcessionListQuery) {
  return useQuery({ queryKey: concessionKeys.list(query), queryFn: () => api<ConcessionListResponse>(`/concessions${qs({ ...query })}`) })
}

export function useConcessionOptions() {
  return useQuery({ queryKey: concessionKeys.options, queryFn: () => api<ConcessionOptions>('/concessions/options') })
}

export function useConcessionCustomers(q: string) {
  return useQuery({ queryKey: ['concessions', 'customers', q], queryFn: () => api<string[]>(`/concessions/customers${qs({ q })}`) })
}

export function useConcessionItems(customer: string, q: string) {
  return useQuery({
    queryKey: ['concessions', 'items', customer, q],
    queryFn: () => api<ConcessionItem[]>(`/concessions/items${qs({ customer, q })}`),
    enabled: !!customer,
  })
}

export function useCreateConcession() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (body: CreateConcessionRequest) => api<Concession>('/concessions', { method: 'POST', body }),
    onSuccess: async () => {
      await Promise.all([
        client.invalidateQueries({ queryKey: concessionKeys.all }),
        client.invalidateQueries({ queryKey: ['audit'] }),
      ])
    },
  })
}

export function useAddConcessionCategory() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (name: string) => api<ConcessionCategory>('/concessions/categories', { method: 'POST', body: { name } }),
    onSuccess: (category) => {
      client.setQueryData<ConcessionOptions>(concessionKeys.options, (old) => old ? {
        ...old,
        categories: [...old.categories.filter((v) => v.id !== category.id), category].sort((a, b) => a.name.localeCompare(b.name)),
      } : old)
      void client.invalidateQueries({ queryKey: ['audit'] })
    },
  })
}
