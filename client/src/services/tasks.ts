// ============================================================================
// Tasks through the API: what waits on the person (the bell's Tasks tab),
// their boxes (sent to them, sent by them) page by page, one task with its
// thread, and the writes behind its buttons (a task is sent by the
// assistant, from its card). Each write puts the task the server answered
// into its cache, then refreshes the lists and the counts it may have moved.
// A task someone is not on is "not found" to them: the server decides.
// ============================================================================

import { useInfiniteQuery, useQuery, keepPreviousData, type QueryClient } from '@tanstack/react-query'
import type {
  TaskBox,
  TaskCountsResponse,
  TaskDetail,
  TaskListStatus,
  TaskMessageRequest,
  TaskReviewRequest,
  TasksResponse,
  TaskStateRequest,
  UpdateTaskRequest,
} from '@qc/shared/tasks'
import { api, qs } from '@/lib/api'
import { NOTICE_POLL_MS } from './queries'

export const taskKeys = {
  all: ['tasks'] as const,
  counts: ['tasks', 'counts'] as const,
  lists: ['tasks', 'list'] as const,
  list: (box: TaskBox, status: TaskListStatus) => ['tasks', 'list', box, status] as const,
  one: (id: string) => ['tasks', 'one', id] as const,
}

const path = (id: string) => `/tasks/${encodeURIComponent(id)}`

/** What waits on the person, polled like the bell. */
export function useTaskCounts(enabled = true) {
  return useQuery({
    queryKey: taskKeys.counts,
    queryFn: () => api<TaskCountsResponse>('/tasks/counts'),
    enabled,
    staleTime: 60_000,
    refetchInterval: NOTICE_POLL_MS,
    refetchIntervalInBackground: false,
  })
}

/** A box of the person's tasks, newest first, 100 a page. */
export function useTasks(box: TaskBox, status: TaskListStatus, enabled = true) {
  return useInfiniteQuery({
    queryKey: taskKeys.list(box, status),
    queryFn: ({ pageParam }) => api<TasksResponse>(`/tasks${qs({ box, status, before: pageParam?.createdAt, beforeId: pageParam?.id })}`),
    initialPageParam: null as { createdAt: string; id: string } | null,
    getNextPageParam: (last: TasksResponse) => {
      const end = last.tasks.at(-1)
      return last.hasMore && end ? { createdAt: end.createdAt, id: end.id } : null
    },
    enabled,
    staleTime: 30_000,
    placeholderData: keepPreviousData,
  })
}

/** One task with its thread; kept fresh while it is open, as others write on it. */
export function useTask(id: string | null) {
  return useQuery({
    queryKey: taskKeys.one(id ?? ''),
    queryFn: () => api<TaskDetail>(path(id!)),
    enabled: !!id,
    staleTime: 10_000,
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
  })
}


/** The task as the server answered, in its cache; the lists and the counts asked again. */
function settled(qc: QueryClient, task: TaskDetail): TaskDetail {
  qc.setQueryData(taskKeys.one(task.id), task)
  void qc.invalidateQueries({ queryKey: taskKeys.lists })
  void qc.invalidateQueries({ queryKey: taskKeys.counts })
  return task
}


export async function updateTask(qc: QueryClient, id: string, body: UpdateTaskRequest): Promise<TaskDetail> {
  return settled(qc, await api<TaskDetail>(path(id), { method: 'PATCH', body }))
}

export async function setTaskState(qc: QueryClient, id: string, body: TaskStateRequest): Promise<TaskDetail> {
  return settled(qc, await api<TaskDetail>(`${path(id)}/state`, { method: 'POST', body }))
}

export async function reviewTask(qc: QueryClient, id: string, body: TaskReviewRequest): Promise<TaskDetail> {
  return settled(qc, await api<TaskDetail>(`${path(id)}/review`, { method: 'POST', body }))
}

export async function endTask(qc: QueryClient, id: string, how: 'close' | 'cancel', note = ''): Promise<TaskDetail> {
  return settled(qc, await api<TaskDetail>(`${path(id)}/${how}`, { method: 'POST', body: { note } }))
}

export async function writeOnTask(qc: QueryClient, id: string, body: TaskMessageRequest): Promise<TaskDetail> {
  return settled(qc, await api<TaskDetail>(`${path(id)}/messages`, { method: 'POST', body }))
}

/** Opened by someone it was sent to: once, never in the way of anything. */
export function markTaskSeen(id: string): void {
  void api<void>(`${path(id)}/seen`, { method: 'POST' }).catch(() => undefined)
}
