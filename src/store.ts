import type { DatabaseSync } from 'node:sqlite'
import { HarnessError } from './errors.js'
import { type Decision, DecisionsRepository } from './repositories/decisions.js'
import { type Handoff, HandoffRepository } from './repositories/handoff.js'
import { PlanRepository, type PlanSectionSummary } from './repositories/plan.js'
import { type SessionLogEntry, SessionLogRepository } from './repositories/session-log.js'
import {
  type NextReport,
  TASK_STATUSES,
  type Task,
  type TaskStatus,
  TasksRepository,
} from './repositories/tasks.js'
import { MAX_SEARCH_QUERY_LENGTH, truncate } from './util.js'

export type HarnessStore = {
  tasks: TasksRepository
  decisions: DecisionsRepository
  sessionLog: SessionLogRepository
  handoff: HandoffRepository
  plan: PlanRepository
}

export function createHarnessStore(db: DatabaseSync): HarnessStore {
  return {
    tasks: new TasksRepository(db),
    decisions: new DecisionsRepository(db),
    sessionLog: new SessionLogRepository(db),
    handoff: new HandoffRepository(db),
    plan: new PlanRepository(db),
  }
}

export type Overview = {
  tasks: {
    total: number
    byStatus: Record<TaskStatus, number>
    inProgress: Task[]
    blocked: Task[]
    next: NextReport
  }
  handoff: Handoff
  recentDecisions: Pick<Decision, 'ref' | 'title'>[]
  recentSessionLog: SessionLogEntry[]
  plan: { sections: number; updatedAt: string | null }
}

export function buildOverview(store: HarnessStore): Overview {
  const tasks = store.tasks.list()
  const byStatus = Object.fromEntries(TASK_STATUSES.map((status) => [status, 0])) as Record<
    TaskStatus,
    number
  >
  for (const task of tasks) byStatus[task.status] += 1
  const sections = store.plan.list()
  const planUpdatedAt =
    sections.length === 0
      ? null
      : (sections
          .map((s) => s.updatedAt)
          .sort()
          .at(-1) ?? null)
  return {
    tasks: {
      total: tasks.length,
      byStatus,
      inProgress: tasks.filter((task) => task.status === 'in-progress'),
      blocked: tasks.filter((task) => task.status === 'blocked'),
      next: store.tasks.next(),
    },
    handoff: store.handoff.get(),
    recentDecisions: store.decisions
      .list({ limit: 3 })
      .map((decision) => ({ ref: decision.ref, title: decision.title })),
    recentSessionLog: store.sessionLog.list({ limit: 3 }),
    plan: { sections: sections.length, updatedAt: planUpdatedAt },
  }
}

export type SearchResults = {
  query: string
  tasks: Pick<Task, 'id' | 'title' | 'status'>[]
  decisions: Pick<Decision, 'ref' | 'title' | 'category'>[]
  plan: { id: string; title: string; snippet: string }[]
}

export const SEARCH_DEFAULT_LIMIT = 10

export function searchAll(
  store: HarnessStore,
  rawQuery: string,
  limit = SEARCH_DEFAULT_LIMIT,
): SearchResults {
  const query = rawQuery.trim()
  if (query.length === 0) {
    throw new HarnessError('invalid', 'query must be a non-empty string')
  }
  if (query.length > MAX_SEARCH_QUERY_LENGTH) {
    throw new HarnessError('invalid', `query must not exceed ${MAX_SEARCH_QUERY_LENGTH} characters`)
  }
  const terms = query.toLowerCase().split(/\s+/)
  const matches = (text: string) => {
    const lowered = text.toLowerCase()
    return terms.every((term) => lowered.includes(term))
  }
  const tasks = store.tasks
    .list()
    .filter((task) => matches(`${task.title} ${task.spec}`))
    .slice(0, limit)
    .map((task) => ({ id: task.id, title: task.title, status: task.status }))
  const decisions = store.decisions
    .list({ limit: 1000 })
    .filter((decision) => matches(`${decision.title} ${decision.body}`))
    .slice(0, limit)
    .map((decision) => ({ ref: decision.ref, title: decision.title, category: decision.category }))
  const plan = store.plan
    .list()
    .map((section: PlanSectionSummary) => ({
      summary: section,
      content: store.plan.get(section.id).content,
    }))
    .filter(({ summary, content }) => matches(`${summary.title} ${content}`))
    .slice(0, limit)
    .map(({ summary, content }) => ({
      id: summary.id,
      title: summary.title,
      snippet: snippet(content, terms),
    }))
  return { query, tasks, decisions, plan }
}

function snippet(content: string, terms: readonly string[]): string {
  const lowered = content.toLowerCase()
  const firstIndexOf = terms
    .map((term) => lowered.indexOf(term))
    .filter((index) => index >= 0)
    .reduce((min, index) => Math.min(min, index), Number.MAX_SAFE_INTEGER)
  if (firstIndexOf === Number.MAX_SAFE_INTEGER)
    return truncate(content.replace(/\s+/g, ' ').trim(), 80)
  return truncate(content.replace(/\s+/g, ' ').trim().slice(firstIndexOf), 80)
}
