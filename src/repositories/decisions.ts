import type { DatabaseSync, StatementSync } from 'node:sqlite'
import { withTransaction, withUniqueRetry } from '../db/database.js'
import { HarnessError } from '../errors.js'
import {
  assertMaxLength,
  assertString,
  DECISION_REF_PATTERN,
  MAX_DECISION_BODY_LENGTH,
  MAX_DECISION_CATEGORY_LENGTH,
  MAX_DECISION_TITLE_LENGTH,
  nextNumberIn,
  nowIso,
  searchTerms,
} from '../util.js'

export type Decision = {
  ref: string
  title: string
  body: string
  category: string | null
  taskId: string | null
  supersedes: string | null
  createdAt: string
}

export type DecisionFilter = {
  query?: string
  category?: string
  taskId?: string
  limit?: number
}

type DecisionRow = {
  ref: string
  title: string
  body: string
  category: string | null
  task_id: string | null
  supersedes: string | null
  created_at: string
}

export class DecisionsRepository {
  private readonly db: DatabaseSync
  private readonly insertDecision: StatementSync
  private readonly selectAll: StatementSync
  private readonly selectTaskId: StatementSync

  constructor(db: DatabaseSync) {
    this.db = db
    this.insertDecision = db.prepare(
      'INSERT INTO decisions (ref, title, body, category, task_id, supersedes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
    this.selectAll = db.prepare('SELECT * FROM decisions ORDER BY id ASC')
    this.selectTaskId = db.prepare('SELECT id FROM tasks WHERE id = ?')
  }

  append(input: {
    title: string
    body: string
    category?: string
    taskId?: string
    supersedes?: string
  }): Decision {
    const title = assertString(input.title, 'title', MAX_DECISION_TITLE_LENGTH)
    const body = assertString(input.body, 'body', MAX_DECISION_BODY_LENGTH)
    const category = emptyToNull(input.category, 'category', MAX_DECISION_CATEGORY_LENGTH)
    if (input.taskId !== undefined && this.selectTaskId.get(input.taskId) === undefined) {
      throw new HarnessError('not-found', `task "${input.taskId}" does not exist`)
    }
    if (input.supersedes !== undefined && this.findRef(input.supersedes) === null) {
      throw new HarnessError('not-found', `decision "${input.supersedes}" does not exist`)
    }
    const at = nowIso()
    return withUniqueRetry(() =>
      withTransaction(this.db, () => {
        const ref = this.allocateRef()
        this.insertDecision.run(
          ref,
          title,
          body,
          category,
          input.taskId ?? null,
          input.supersedes ?? null,
          at,
        )
        const created = this.findRef(ref)
        if (created === null) throw new HarnessError('invalid', 'decision persistence failed')
        return created
      }),
    )
  }

  list(filter: DecisionFilter = {}): Decision[] {
    const terms = searchTerms(filter.query ?? '')
    const all = (this.selectAll.all() as unknown as DecisionRow[]).map(toDecision)
    const matching = all.filter((decision) => {
      if (filter.category !== undefined && decision.category !== filter.category) return false
      if (filter.taskId !== undefined && decision.taskId !== filter.taskId) return false
      if (terms.length > 0) {
        const haystack = `${decision.title} ${decision.body}`.toLowerCase()
        if (!terms.every((term) => haystack.includes(term))) return false
      }
      return true
    })
    const limit = filter.limit ?? 20
    return matching.slice(-limit).reverse()
  }

  get(ref: string): Decision {
    const decision = this.findRef(ref)
    if (decision === null) {
      throw new HarnessError('not-found', `decision "${ref}" does not exist`)
    }
    return decision
  }

  private findRef(ref: string): Decision | null {
    const rows = this.selectAll.all() as unknown as DecisionRow[]
    const found = rows.find((row) => row.ref === ref)
    return found === undefined ? null : toDecision(found)
  }

  private allocateRef(): string {
    const refs = (this.selectAll.all() as unknown as { ref: string }[]).map((row) => row.ref)
    return `D${nextNumberIn(refs, DECISION_REF_PATTERN)}`
  }
}

function toDecision(row: DecisionRow): Decision {
  return {
    ref: row.ref,
    title: row.title,
    body: row.body,
    category: row.category,
    taskId: row.task_id,
    supersedes: row.supersedes,
    createdAt: row.created_at,
  }
}

function emptyToNull(value: string | undefined, label: string, maxLength: number): string | null {
  if (value === undefined) return null
  const trimmed = value.trim()
  if (trimmed.length === 0) return null
  assertMaxLength(trimmed, label, maxLength)
  return trimmed
}
