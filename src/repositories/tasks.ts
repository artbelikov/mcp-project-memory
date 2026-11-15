import type { DatabaseSync, StatementSync } from 'node:sqlite'
import { withTransaction } from '../db/database.js'
import { HarnessError } from '../errors.js'
import { compareNatural, nextNumberIn, nowIso, TASK_ID_PATTERN, TASK_REF_PATTERN } from '../util.js'

export const TASK_STATUSES = ['todo', 'in-progress', 'blocked', 'done', 'cancelled'] as const
export type TaskStatus = (typeof TASK_STATUSES)[number]

export type Task = {
  id: string
  title: string
  status: TaskStatus
  blockedReason: string | null
  spec: string
  createdAt: string
  updatedAt: string
}

export type TaskDetail = {
  task: Task
  dependsOn: string[]
  dependents: string[]
}

export type CreateTaskInput = {
  id?: string
  title: string
  spec?: string
  status?: TaskStatus
  blockedReason?: string
}

export type TaskPatch = {
  title?: string
  spec?: string
  status?: TaskStatus
  blockedReason?: string
}

export type UnmetDependency = {
  id: string
  status: TaskStatus
}

export type NextReport = {
  next: Task | null
  ready: Task[]
  blockedOn: { task: Task; unmet: UnmetDependency[] } | null
}

type TaskRow = {
  id: string
  title: string
  status: string
  blocked_reason: string | null
  spec: string
  created_at: string
  updated_at: string
}

function assertValue(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new HarnessError('invalid', `${label} must be a non-empty string`)
  }
  return value.trim()
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Error && error.message.includes('UNIQUE constraint failed')
}

export class TasksRepository {
  private readonly insertTask: StatementSync
  private readonly selectTaskById: StatementSync
  private readonly selectAllTasks: StatementSync
  private readonly selectTasksByStatus: StatementSync
  private readonly deleteTask: StatementSync
  private readonly updateTask: StatementSync
  private readonly selectDependsOn: StatementSync
  private readonly selectDependents: StatementSync
  private readonly selectAllDeps: StatementSync
  private readonly deleteDepsForTask: StatementSync
  private readonly insertDep: StatementSync

  constructor(private readonly db: DatabaseSync) {
    this.insertTask = db.prepare(
      'INSERT INTO tasks (id, title, status, blocked_reason, spec, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
    this.selectTaskById = db.prepare('SELECT * FROM tasks WHERE id = ?')
    this.selectAllTasks = db.prepare('SELECT * FROM tasks')
    this.selectTasksByStatus = db.prepare('SELECT * FROM tasks WHERE status = ?')
    this.deleteTask = db.prepare('DELETE FROM tasks WHERE id = ?')
    this.updateTask = db.prepare(
      'UPDATE tasks SET title = ?, status = ?, blocked_reason = ?, spec = ?, updated_at = ? WHERE id = ?',
    )
    this.selectDependsOn = db.prepare('SELECT depends_on FROM task_deps WHERE task_id = ?')
    this.selectDependents = db.prepare('SELECT task_id FROM task_deps WHERE depends_on = ?')
    this.selectAllDeps = db.prepare('SELECT task_id, depends_on FROM task_deps')
    this.deleteDepsForTask = db.prepare('DELETE FROM task_deps WHERE task_id = ?')
    this.insertDep = db.prepare('INSERT INTO task_deps (task_id, depends_on) VALUES (?, ?)')
  }

  create(input: CreateTaskInput): Task {
    const title = assertValue(input.title, 'title')
    if (title.length > 200) {
      throw new HarnessError('invalid', `title must not exceed 200 characters`)
    }
    const spec = input.spec ?? ''
    if (spec.length > 20_000) {
      throw new HarnessError('invalid', `spec must not exceed 20000 characters`)
    }
    const status = input.status ?? 'todo'
    if (status !== 'blocked' && input.blockedReason !== undefined) {
      throw new HarnessError('invalid', 'blockedReason applies only when status is "blocked"')
    }
    const blockedReason = normalizeBlockedReason(status, input.blockedReason)
    const id = input.id ?? this.allocateTaskId()
    if (!TASK_ID_PATTERN.test(id)) {
      throw new HarnessError(
        'invalid',
        `task id "${id}" must match pattern T\\d+ or a lowercase slug`,
      )
    }
    const at = nowIso()
    try {
      this.insertTask.run(id, title, status, blockedReason, spec, at, at)
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new HarnessError('conflict', `task "${id}" already exists`)
      }
      throw error
    }
    return this.get(id)
  }

  get(id: string): Task {
    const row = this.selectTaskById.get(id)
    if (row === undefined) {
      throw new HarnessError('not-found', `task "${id}" does not exist`)
    }
    return toTask(row as unknown as TaskRow)
  }

  list(status?: TaskStatus): Task[] {
    const rows = (status === undefined
      ? this.selectAllTasks.all()
      : this.selectTasksByStatus.all(status)) as unknown as TaskRow[]
    return rows.map(toTask).sort((a, b) => compareNatural(a.id, b.id))
  }

  detail(id: string): TaskDetail {
    const dependsOn = (this.selectDependsOn.all(id) as unknown as { depends_on: string }[]).map(
      (row) => row.depends_on,
    )
    const dependents = (this.selectDependents.all(id) as unknown as { task_id: string }[]).map(
      (row) => row.task_id,
    )
    return {
      task: this.get(id),
      dependsOn: [...dependsOn].sort(compareNatural),
      dependents: [...dependents].sort(compareNatural),
    }
  }

  update(id: string, patch: TaskPatch): Task {
    const existing = this.get(id)
    const title = patch.title !== undefined ? assertValue(patch.title, 'title') : existing.title
    if (title.length > 200) {
      throw new HarnessError('invalid', `title must not exceed 200 characters`)
    }
    const spec = patch.spec !== undefined ? patch.spec : existing.spec
    if (spec.length > 20_000) {
      throw new HarnessError('invalid', `spec must not exceed 20000 characters`)
    }
    const status = patch.status ?? existing.status
    const patchReason = patch.blockedReason
    if (patchReason !== undefined && status !== 'blocked' && patchReason.trim() !== '') {
      throw new HarnessError('invalid', 'blockedReason applies only when status is "blocked"')
    }
    const blockedReason = normalizeBlockedReason(
      status,
      patchReason ?? existing.blockedReason ?? undefined,
    )
    this.updateTask.run(title, status, blockedReason, spec, nowIso(), id)
    return this.get(id)
  }

  delete(id: string, force = false): { id: string; releasedDependents: string[] } {
    const existing = this.get(id)
    const dependents = (this.selectDependents.all(id) as unknown as { task_id: string }[]).map(
      (row) => row.task_id,
    )
    if (dependents.length > 0 && !force) {
      throw new HarnessError(
        'blocked-by-dependents',
        `task "${id}" is a dependency of ${dependents.join(', ')} — resolve or re-plan them first, or pass force: true`,
      )
    }
    this.deleteTask.run(id)
    return { id: existing.id, releasedDependents: [...dependents].sort(compareNatural) }
  }

  setDependencies(id: string, dependsOn: readonly string[]): TaskDetail {
    this.get(id)
    const unique = [...new Set(dependsOn)]
    const selfReference = unique.indexOf(id)
    if (selfReference !== -1) {
      throw new HarnessError('invalid', `task "${id}" cannot depend on itself`)
    }
    const missing = unique.filter((dep) => this.selectTaskById.get(dep) === undefined)
    if (missing.length > 0) {
      throw new HarnessError('not-found', `unknown dependencies for "${id}": ${missing.join(', ')}`)
    }
    const edges = new Map<string, string[]>()
    const originalEdges = this.selectAllDeps.all() as unknown as {
      task_id: string
      depends_on: string
    }[]
    for (const edge of originalEdges) {
      if (edge.task_id === id) continue
      const acc = edges.get(edge.task_id) ?? []
      acc.push(edge.depends_on)
      edges.set(edge.task_id, acc)
    }
    if (unique.length > 0) edges.set(id, [...unique])
    const cycle = findCycle(id, edges)
    if (cycle !== null) {
      throw new HarnessError('dependency-cycle', cycle.join(' → '))
    }
    withTransaction(this.db, () => {
      this.deleteDepsForTask.run(id)
      for (const dep of unique) this.insertDep.run(id, dep)
    })
    return this.detail(id)
  }

  next(): NextReport {
    const candidates = this.list('todo')
    const statusById = new Map<string, TaskStatus>(
      this.list().map((task) => [task.id, task.status]),
    )
    const satisfied = (status: TaskStatus) => status === 'done' || status === 'cancelled'
    const queue = new Map(candidates.map((task) => [task.id, task] as const))
    const ready: Task[] = []
    for (const task of candidates) {
      const deps = this.selectDependsOn.all(task.id) as unknown as { depends_on: string }[]
      const unmet = deps
        .map((entry) => entry.depends_on)
        .filter((dep) => !satisfied(statusById.get(dep) ?? 'todo'))
      if (unmet.length === 0) {
        ready.push(task)
        queue.delete(task.id)
      }
    }
    ready.sort((a, b) => compareNatural(a.id, b.id))
    const next = ready[0] ?? null
    let blockedOn: NextReport['blockedOn'] = null
    if (next === null) {
      const waiting = [...queue.values()][0]
      if (waiting !== undefined) {
        const unmet: UnmetDependency[] = (
          this.selectDependsOn.all(waiting.id) as unknown as { depends_on: string }[]
        )
          .map((entry) => entry.depends_on)
          .map((dep) => ({ id: dep, status: statusById.get(dep) ?? 'todo' }))
          .filter((dep) => !satisfied(dep.status))
        blockedOn = { task: waiting, unmet }
      }
    }
    return { next, ready, blockedOn }
  }

  private allocateTaskId(): string {
    const ids = (this.selectAllTasks.all() as unknown as { id: string }[]).map((row) => row.id)
    return `T${nextNumberIn(ids, TASK_REF_PATTERN, -1)}`
  }
}

function normalizeBlockedReason(status: TaskStatus, reason?: string): string | null {
  if (status !== 'blocked') return null
  const trimmed = reason?.trim() ?? ''
  if (trimmed.length === 0) {
    throw new HarnessError('invalid', 'status "blocked" requires blockedReason')
  }
  return trimmed
}

function toTask(row: TaskRow): Task {
  if (!isTaskStatus(row.status)) {
    throw new Error(`corrupt task row: unknown status "${row.status}"`)
  }
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    blockedReason: row.blocked_reason,
    spec: row.spec,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function isTaskStatus(value: string): value is TaskStatus {
  return TASK_STATUSES.includes(value as TaskStatus)
}

function findCycle(start: string, edges: Map<string, string[]>): string[] | null {
  const stack: { node: string; path: string[] }[] = [{ node: start, path: [] }]
  const visited = new Set<string>()
  while (stack.length > 0) {
    const current = stack.pop()
    if (current === undefined) break
    for (const dep of edges.get(current.node) ?? []) {
      if (dep === start) return [...current.path, dep]
      if (visited.has(dep)) continue
      visited.add(dep)
      stack.push({ node: dep, path: [...current.path, dep] })
    }
  }
  return null
}
