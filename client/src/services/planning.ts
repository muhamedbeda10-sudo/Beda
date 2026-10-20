// ============================================================================
// §25 — Planning through the API (/api/planning): the floor now, the plans
// and scenarios, their comparisons and loads, plan against actual, material,
// what the data lacks, and planning's setup. Each write refreshes what it
// may have moved: a plan's change its own detail and the list; a setup
// change every plan (each is worked out from the setup again).
// ============================================================================

import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type {
  CalendarResponse,
  CapacityResponse,
  ComparisonResponse,
  CreatePlanRequest,
  DataGapsResponse,
  FloorResponse,
  LoadResponse,
  MaterialsResponse,
  OverviewResponse,
  PlanDetail,
  PlanVsActualResponse,
  PlansResponse,
  RatesResponse,
  RoutesResponse,
  SaveLayoutRequest,
  SetCalendarDayRequest,
  SetCapacityRequest,
  SetRateRequest,
  SettingsResponse,
  UpdatePlanRequest,
  PlanSettings,
} from '@qc/shared/planning'
import { api, qs } from '@/lib/api'

export const planningKeys = {
  all: ['planning'] as const,
  overview: ['planning', 'overview'] as const,
  floor: ['planning', 'floor'] as const,
  plans: ['planning', 'plans'] as const,
  plan: (id: string) => ['planning', 'plan', id] as const,
  compare: (id: string, withId?: string) => ['planning', 'compare', id, withId ?? ''] as const,
  load: (id: string, weeks: number) => ['planning', 'load', id, weeks] as const,
  actual: (from: string, to: string) => ['planning', 'actual', from, to] as const,
  materials: ['planning', 'materials'] as const,
  gaps: ['planning', 'gaps'] as const,
  settings: ['planning', 'setup', 'settings'] as const,
  calendar: (from: string, to: string) => ['planning', 'setup', 'calendar', from, to] as const,
  capacity: ['planning', 'setup', 'capacity'] as const,
  rates: (machine?: string) => ['planning', 'setup', 'rates', machine ?? ''] as const,
  routes: (q: string, process: string) => ['planning', 'setup', 'routes', q, process] as const,
}

const P = '/planning'
const enc = encodeURIComponent
/** The floor moves while people look at it: read again every minute. */
const FLOOR_POLL_MS = 60_000

export const useOverview = () => useQuery({ queryKey: planningKeys.overview, queryFn: () => api<OverviewResponse>(`${P}/overview`), staleTime: 30_000 })

export const useFloor = () =>
  useQuery({ queryKey: planningKeys.floor, queryFn: () => api<FloorResponse>(`${P}/floor`), staleTime: 30_000, refetchInterval: FLOOR_POLL_MS, refetchIntervalInBackground: false })

export const usePlans = () => useQuery({ queryKey: planningKeys.plans, queryFn: () => api<PlansResponse>(`${P}/plans`), staleTime: 30_000 })

export const usePlan = (id: string | null) =>
  useQuery({ queryKey: planningKeys.plan(id ?? ''), queryFn: () => api<PlanDetail>(`${P}/plans/${enc(id!)}`), enabled: !!id, staleTime: 30_000, placeholderData: keepPreviousData })

export const useCompare = (id: string | null, withId?: string) =>
  useQuery({
    queryKey: planningKeys.compare(id ?? '', withId),
    queryFn: () => api<ComparisonResponse>(`${P}/plans/${enc(id!)}/compare${qs({ with: withId })}`),
    enabled: !!id,
    staleTime: 30_000,
  })

export const useLoad = (id: string, weeks: number) =>
  useQuery({ queryKey: planningKeys.load(id, weeks), queryFn: () => api<LoadResponse>(`${P}/plans/${enc(id)}/load${qs({ weeks })}`), staleTime: 30_000, placeholderData: keepPreviousData })

export const useActual = (from: string, to: string) =>
  useQuery({ queryKey: planningKeys.actual(from, to), queryFn: () => api<PlanVsActualResponse>(`${P}/actual${qs({ from, to })}`), staleTime: 60_000, placeholderData: keepPreviousData })

export const useMaterials = () => useQuery({ queryKey: planningKeys.materials, queryFn: () => api<MaterialsResponse>(`${P}/materials`), staleTime: 60_000 })
export const useGaps = () => useQuery({ queryKey: planningKeys.gaps, queryFn: () => api<DataGapsResponse>(`${P}/gaps`), staleTime: 60_000 })
export const useSettings = () => useQuery({ queryKey: planningKeys.settings, queryFn: () => api<SettingsResponse>(`${P}/setup/settings`) })
export const useCalendar = (from: string, to: string) =>
  useQuery({ queryKey: planningKeys.calendar(from, to), queryFn: () => api<CalendarResponse>(`${P}/setup/calendar${qs({ from, to })}`), placeholderData: keepPreviousData })
export const useCapacity = () => useQuery({ queryKey: planningKeys.capacity, queryFn: () => api<CapacityResponse>(`${P}/setup/capacity`) })
export const useRates = (machine?: string) => useQuery({ queryKey: planningKeys.rates(machine), queryFn: () => api<RatesResponse>(`${P}/setup/rates${qs({ machine })}`), placeholderData: keepPreviousData })
export const useRoutes = (q: string, process: string) =>
  useQuery({
    queryKey: planningKeys.routes(q, process),
    queryFn: () => api<RoutesResponse>(`${P}/setup/routes${qs({ q: q || undefined, process: process || undefined, limit: 300 })}`),
    placeholderData: keepPreviousData,
  })

// ---- Writes -------------------------------------------------------------------------------

/** After a plan changes: its own detail, the list, the comparisons and loads that read it, the overview and the floor. */
function plansMoved(qc: ReturnType<typeof useQueryClient>) {
  for (const key of [planningKeys.plans, ['planning', 'compare'], ['planning', 'load'], planningKeys.overview, planningKeys.floor]) void qc.invalidateQueries({ queryKey: key })
}

export function useCreatePlan() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (req: CreatePlanRequest) => api<PlanDetail>(`${P}/plans`, { method: 'POST', body: req }),
    onSuccess: (d) => {
      qc.setQueryData(planningKeys.plan(d.plan.id), d)
      plansMoved(qc)
    },
  })
}

export function useUpdatePlan(id: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (req: UpdatePlanRequest) => api<PlanDetail>(`${P}/plans/${enc(id)}`, { method: 'PATCH', body: req }),
    onSuccess: (d) => {
      qc.setQueryData(planningKeys.plan(id), d)
      plansMoved(qc)
    },
    onError: () => void qc.invalidateQueries({ queryKey: planningKeys.plan(id) }),
  })
}

export function usePlanAction(id: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async ({ action, version }: { action: 'publish' | 'archive' | 'delete'; version: number }): Promise<PlanDetail | null> => {
      if (action !== 'delete') return api<PlanDetail>(`${P}/plans/${enc(id)}/${action}`, { method: 'POST', body: { version } })
      await api<void>(`${P}/plans/${enc(id)}${qs({ version })}`, { method: 'DELETE' })
      return null
    },
    onSuccess: (d) => {
      if (d) qc.setQueryData(planningKeys.plan(id), d)
      else qc.removeQueries({ queryKey: planningKeys.plan(id) })
      plansMoved(qc)
      void qc.invalidateQueries({ queryKey: ['planning', 'actual'] })
    },
  })
}

/** After the setup changes: every plan is worked out from it again. */
function setupMoved(qc: ReturnType<typeof useQueryClient>) {
  void qc.invalidateQueries({ queryKey: planningKeys.all })
}

export function useSaveLayout() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (req: SaveLayoutRequest) => api<void>(`${P}/layout`, { method: 'PUT', body: req }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: planningKeys.floor }),
  })
}

export function useClearLayout() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (machineKey: string) => api<void>(`${P}/layout/${enc(machineKey)}`, { method: 'DELETE' }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: planningKeys.floor }),
  })
}

export function useSetCalendarDay() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ day, req }: { day: string; req: SetCalendarDayRequest | null }) =>
      req ? api<void>(`${P}/setup/calendar/${enc(day)}`, { method: 'PUT', body: req }) : api<void>(`${P}/setup/calendar/${enc(day)}`, { method: 'DELETE' }),
    onSuccess: () => setupMoved(qc),
  })
}

export function useSetCapacity() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ machineKey, req }: { machineKey: string; req: SetCapacityRequest | null }) =>
      req ? api<void>(`${P}/setup/capacity/${enc(machineKey)}`, { method: 'PUT', body: req }) : api<void>(`${P}/setup/capacity/${enc(machineKey)}`, { method: 'DELETE' }),
    onSuccess: () => setupMoved(qc),
  })
}

export function useSetRate() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ req, clear }: { req: SetRateRequest; clear?: boolean }) =>
      clear ? api<void>(`${P}/setup/rates${qs({ machine: req.machineKey, family: req.itemFamily })}`, { method: 'DELETE' }) : api<void>(`${P}/setup/rates`, { method: 'PUT', body: req }),
    onSuccess: () => setupMoved(qc),
  })
}

export function useSaveSettings() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (req: { settings: Partial<PlanSettings>; version: number }) => api<SettingsResponse>(`${P}/setup/settings`, { method: 'PUT', body: req }),
    onSuccess: (d) => {
      qc.setQueryData(planningKeys.settings, d)
      setupMoved(qc)
    },
  })
}

export function useLearnNow() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () => api<{ learnt: { machines: number; rates: number; routes: number; learntAt: string } | null }>(`${P}/setup/learn`, { method: 'POST', body: {} }),
    onSuccess: () => setupMoved(qc),
  })
}
