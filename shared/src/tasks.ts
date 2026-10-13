// ============================================================================
// Tasks: work one person sends to others, followed to the end. Someone given
// the AI assistant sends a task (from the assistant's Tasks page, or a draft
// the assistant wrote) to one or more people. Each of them works it — In
// progress, then Done — and may write and send photos on its thread. Done is
// theirs to say; the sender then confirms it (it leaves their list) or sends
// it back ("not yet": theirs to do again). The task closes once everyone on
// it is confirmed; its sender may also withdraw it.
// ============================================================================

export type TaskPriority = 'normal' | 'high' | 'urgent'
export const TASK_PRIORITIES: readonly TaskPriority[] = ['normal', 'high', 'urgent']
export const TASK_PRIORITY_LABEL: Record<TaskPriority, string> = { normal: 'Normal', high: 'High', urgent: 'Urgent' }

export type TaskStatus = 'open' | 'closed' | 'cancelled'

/** Where one person is on a task: to do, in progress, done (their word), confirmed (their sender's). */
export type TaskAssigneeState = 'todo' | 'in_progress' | 'done' | 'confirmed'
export const TASK_STATE_LABEL: Record<TaskAssigneeState, string> = { todo: 'To do', in_progress: 'In progress', done: 'Done', confirmed: 'Confirmed' }

/** What happened on a task, as its thread records it. */
export type TaskEvent = 'created' | 'started' | 'done' | 'undone' | 'confirmed' | 'reopened' | 'edited' | 'cancelled' | 'closed'

export const TASK_TITLE_MAX = 200
export const TASK_DESCRIPTION_MAX = 4000
export const TASK_MESSAGE_MAX = 4000
export const TASK_MAX_ASSIGNEES = 20
export const TASK_MAX_PHOTOS = 6

/** A state an assignee may move their own part to, from where it is. A confirmed part is final; a done one goes back to work. */
export function assigneeMayMove(from: TaskAssigneeState, to: TaskAssigneeState): boolean {
  if (from === to || from === 'confirmed' || to === 'confirmed') return false
  if (to === 'todo') return false
  return true
}

/** The thread's word on an event, as people read it: "Mona marked it done". */
export function taskEventText(event: TaskEvent, author: string, subject?: string | null): string {
  const who = subject && subject !== author ? subject : null
  switch (event) {
    case 'created':
      return `${author} sent the task`
    case 'started':
      return `${author} started working on it`
    case 'done':
      return `${author} marked it done`
    case 'undone':
      return `${author} took it back to in progress`
    case 'confirmed':
      return who ? `${author} confirmed ${who}'s part done` : `${author} confirmed it done`
    case 'reopened':
      return who ? `${author} sent it back to ${who}: not done yet` : `${author} sent it back: not done yet`
    case 'edited':
      return `${author} changed the task`
    case 'cancelled':
      return `${author} withdrew the task`
    case 'closed':
      return 'Everyone is confirmed done: the task is closed'
  }
}

export interface TaskPerson {
  id: string
  name: string
  role: string
}

export interface TaskAssignee {
  userId: string
  name: string
  state: TaskAssigneeState
  stateAt: string
  doneAt?: string
  confirmedAt?: string
  /** When they first opened it. */
  seenAt?: string
}

export interface TaskSummary {
  id: string
  number: number
  title: string
  priority: TaskPriority
  status: TaskStatus
  dueAt: string | null
  /** Open, past its deadline, and someone's part not done. */
  overdue: boolean
  createdBy: { id: string; name: string }
  createdAt: string
  updatedAt: string
  closedAt?: string
  assignees: TaskAssignee[]
  /** The viewer sent it. */
  isCreator: boolean
  /** The viewer's own part, when it was sent to them. */
  myState?: TaskAssigneeState
  /** Something waits on the viewer: their part to do, or (the sender) someone's done to confirm. */
  waitingForMe: boolean
  messageCount: number
  lastActivityAt: string
}

export interface TaskPhoto {
  id: string
  thumbnailDataUrl: string | null
  width: number
  height: number
}

export interface TaskMessage {
  id: string
  kind: 'comment' | 'event'
  authorId: string
  authorName: string
  body: string
  event?: TaskEvent
  subjectName?: string
  photos: TaskPhoto[]
  createdAt: string
}

export interface TaskDetail extends TaskSummary {
  description: string
  messages: TaskMessage[]
  /** The viewer may send tasks (the assistant is theirs). */
  canEdit: boolean
}

export type TaskBox = 'assigned' | 'created'
export type TaskListStatus = 'active' | 'closed' | 'all'

export interface TasksResponse {
  tasks: TaskSummary[]
  hasMore: boolean
}

export interface TaskCountsResponse {
  /** Given to the viewer and theirs to do (to do or in progress). */
  assignedOpen: number
  assignedOverdue: number
  /** Sent by the viewer: people who said done, waiting for the viewer to confirm. */
  toConfirm: number
  /** The viewer may send tasks. */
  canCreate: boolean
}

export interface CreateTaskRequest {
  title: string
  description?: string
  priority?: TaskPriority
  /** ISO timestamp, or null for none. */
  dueAt?: string | null
  assigneeIds: string[]
}

export interface UpdateTaskRequest {
  title?: string
  description?: string
  priority?: TaskPriority
  dueAt?: string | null
}

/** An assignee moves their own part. */
export interface TaskStateRequest {
  state: 'in_progress' | 'done'
  note?: string
}

/** The sender, on someone's done: confirm it, or send it back with why. */
export interface TaskReviewRequest {
  userId: string
  decision: 'confirm' | 'reopen'
  note?: string
}

export interface TaskMessageRequest {
  body: string
  /** Photos uploaded first (POST /images), in order. */
  imageIds?: string[]
}
