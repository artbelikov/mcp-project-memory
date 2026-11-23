import type { DatabaseSync, StatementSync } from 'node:sqlite'
import { HarnessError } from '../errors.js'
import {
  assertString,
  LOG_DATE_PATTERN,
  MAX_OUTCOME_LENGTH,
  MAX_SESSION_NAME_LENGTH,
  todayIsoDate,
} from '../util.js'

export type SessionLogEntry = {
  id: number
  date: string
  session: string
  outcome: string
  taskId: string | null
}

export type SessionLogFilter = {
  session?: string
  taskId?: string
  limit?: number
}

type SessionLogRow = {
  id: number
  date: string
  session: string
  outcome: string
  task_id: string | null
}

export class SessionLogRepository {
  private readonly insertEntry: StatementSync
  private readonly selectAll: StatementSync
  private readonly selectTaskId: StatementSync

  constructor(db: DatabaseSync) {
    this.insertEntry = db.prepare(
      'INSERT INTO session_log (date, session, outcome, task_id) VALUES (?, ?, ?, ?)',
    )
    this.selectAll = db.prepare('SELECT * FROM session_log ORDER BY id ASC')
    this.selectTaskId = db.prepare('SELECT id FROM tasks WHERE id = ?')
  }

  append(input: {
    session: string
    outcome: string
    taskId?: string
    date?: string
  }): SessionLogEntry {
    const session = assertString(input.session, 'session', MAX_SESSION_NAME_LENGTH)
    const outcome = assertString(input.outcome, 'outcome', MAX_OUTCOME_LENGTH)
    const date = input.date ?? todayIsoDate()
    if (!LOG_DATE_PATTERN.test(date)) {
      throw new HarnessError('invalid', `date "${date}" must be formatted YYYY-MM-DD`)
    }
    if (input.taskId !== undefined && this.selectTaskId.get(input.taskId) === undefined) {
      throw new HarnessError('not-found', `task "${input.taskId}" does not exist`)
    }
    const result = this.insertEntry.run(date, session, outcome, input.taskId ?? null)
    return {
      id: Number(result.lastInsertRowid),
      date,
      session,
      outcome,
      taskId: input.taskId ?? null,
    }
  }

  list(filter: SessionLogFilter = {}): SessionLogEntry[] {
    const all = (this.selectAll.all() as unknown as SessionLogRow[]).map(toEntry)
    const matching = all.filter((entry) => {
      if (
        filter.session !== undefined &&
        !entry.session.toLowerCase().includes(filter.session.toLowerCase())
      )
        return false
      if (filter.taskId !== undefined && entry.taskId !== filter.taskId) return false
      return true
    })
    const limit = filter.limit ?? 20
    return matching.slice(-limit)
  }
}

function toEntry(row: SessionLogRow): SessionLogEntry {
  return {
    id: row.id,
    date: row.date,
    session: row.session,
    outcome: row.outcome,
    taskId: row.task_id,
  }
}
