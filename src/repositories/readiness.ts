import { createHash } from 'node:crypto'
import type { DatabaseSync, StatementSync } from 'node:sqlite'
import type { GateMode } from '../config.js'
import { withTransaction, withUniqueRetry } from '../db/database.js'
import { HarnessError, type HarnessErrorCode } from '../errors.js'
import {
  assertMaxLength,
  assertString,
  MAX_READINESS_ACCEPTANCE_LENGTH,
  MAX_READINESS_COMMAND_LENGTH,
  MAX_READINESS_GOAL_LENGTH,
  MAX_READINESS_ITEMS,
  MAX_READINESS_OUT_OF_SCOPE_LENGTH,
  MAX_READINESS_SERVE_LENGTH,
  nowIso,
} from '../util.js'

const READINESS_SERVE_PATTERN = /^[RDFT]\d{1,9}$/
const SPEC_HASH_PATTERN = /^[a-fA-F0-9]{64}$/
const MIN_ACCEPTANCE_QUOTE_LENGTH = 8

export type ReadinessRecord = {
  taskId: string
  revision: number
  goal: string
  acceptance: string
  serves: string[]
  outOfScope: string[]
  commands: string[]
  specHash: string
  createdAt: string
}

export type ReadinessInput = {
  taskId: string
  goal: string
  acceptance: string
  serves?: string[]
  outOfScope: string[]
  commands: string[]
}

export type ReadinessBlocker = {
  code: HarnessErrorCode
  message: string
}

export type ReadinessAssessment = {
  record: ReadinessRecord | null
  blockers: ReadinessBlocker[]
  canStart: boolean
}

export type ReadinessHealth = {
  inProgress: number
  missing: number
  stale: number
  samples: { missing: string[]; stale: string[] }
}

type ReadinessRow = {
  task_id: string
  revision: number
  goal: string
  acceptance: string
  serves: string
  out_of_scope: string
  commands: string
  spec_hash: string
  created_at: string
}

type TaskRow = {
  id: string
  status: string
  spec: string
}

export class ReadinessRepository {
  private readonly insertCheck: StatementSync
  private readonly selectLatest: StatementSync
  private readonly nextRevision: StatementSync
  private readonly selectTask: StatementSync
  private readonly selectInProgress: StatementSync
  private readonly selectDecision: StatementSync
  private readonly selectFact: StatementSync

  constructor(
    private readonly db: DatabaseSync,
    private readonly gateMode: GateMode,
  ) {
    this.insertCheck = db.prepare(
      `INSERT INTO readiness_checks
        (task_id, revision, goal, acceptance, serves, out_of_scope, commands, spec_hash, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    this.selectLatest = db.prepare(
      'SELECT * FROM readiness_checks WHERE task_id = ? ORDER BY revision DESC, id DESC LIMIT 1',
    )
    this.nextRevision = db.prepare(
      'SELECT COALESCE(MAX(revision), 0) + 1 AS next FROM readiness_checks WHERE task_id = ?',
    )
    this.selectTask = db.prepare('SELECT id, status, spec FROM tasks WHERE id = ?')
    this.selectInProgress = db.prepare(
      "SELECT id, status, spec FROM tasks WHERE status = 'in-progress' ORDER BY id",
    )
    this.selectDecision = db.prepare('SELECT 1 FROM decisions WHERE ref = ?')
    this.selectFact = db.prepare('SELECT 1 FROM facts WHERE ref = ?')
  }

  record(input: ReadinessInput): ReadinessRecord {
    const task = this.task(input.taskId)
    if (task.status === 'done' || task.status === 'cancelled') {
      throw new HarnessError(
        'invalid',
        `task "${task.id}" is ${task.status}; the readiness drill runs before work starts, not after it ends`,
      )
    }
    const goal = assertString(input.goal, 'goal', MAX_READINESS_GOAL_LENGTH)
    const acceptance = assertString(input.acceptance, 'acceptance', MAX_READINESS_ACCEPTANCE_LENGTH)
    assertAcceptanceQuotesSpec(acceptance, task.spec)
    const serves = normalizeServes(input.serves ?? [])
    for (const ref of serves) this.assertRefExists(ref)
    const outOfScope = normalizeItems(
      input.outOfScope,
      'outOfScope',
      MAX_READINESS_OUT_OF_SCOPE_LENGTH,
    )
    const commands = normalizeItems(input.commands, 'commands', MAX_READINESS_COMMAND_LENGTH)
    withUniqueRetry(() =>
      withTransaction(this.db, () => {
        const next = (this.nextRevision.get(task.id) as { next: number }).next
        this.insertCheck.run(
          task.id,
          next,
          goal,
          acceptance,
          JSON.stringify(serves),
          JSON.stringify(outOfScope),
          JSON.stringify(commands),
          hashSpec(task.spec),
          nowIso(),
        )
      }),
    )
    return this.latest(task.id) as ReadinessRecord
  }

  latest(taskId: string): ReadinessRecord | null {
    const row = this.selectLatest.get(taskId)
    return row === undefined ? null : toRecord(row as unknown as ReadinessRow)
  }

  assess(taskId: string, nextSpec?: string): ReadinessAssessment {
    const task = this.task(taskId)
    const record = this.latest(taskId)
    const blockers: ReadinessBlocker[] = []
    if (record === null) {
      blockers.push({
        code: 'readiness-required',
        message: `task "${task.id}" has no readiness drill; record goal, quoted acceptance, refs, out-of-scope and proving commands with readiness_set before starting`,
      })
    } else if (!drillMatches(record, nextSpec ?? task.spec)) {
      blockers.push({
        code: 'readiness-stale',
        message: `task "${task.id}" readiness drill does not match the current spec; re-record it with readiness_set so the brief-back quotes the work`,
      })
    }
    return { record, blockers, canStart: blockers.length === 0 }
  }

  assertCanStart(taskId: string, nextSpec?: string): ReadinessAssessment {
    const assessment = this.assess(taskId, nextSpec)
    if (this.gateMode !== 'enforce') return assessment
    const first = assessment.blockers[0]
    if (first !== undefined) throw new HarnessError(first.code, first.message)
    return assessment
  }

  health(): ReadinessHealth {
    const rows = this.selectInProgress.all() as unknown as TaskRow[]
    const missing: string[] = []
    const stale: string[] = []
    for (const row of rows) {
      const record = this.latest(row.id)
      if (record === null) missing.push(row.id)
      else if (!drillMatches(record, row.spec)) stale.push(row.id)
    }
    return {
      inProgress: rows.length,
      missing: missing.length,
      stale: stale.length,
      samples: { missing: missing.slice(0, 10), stale: stale.slice(0, 10) },
    }
  }

  private task(taskId: string): TaskRow {
    const row = this.selectTask.get(taskId)
    if (row === undefined) {
      throw new HarnessError('not-found', `task "${taskId}" does not exist`)
    }
    return row as unknown as TaskRow
  }

  private assertRefExists(ref: string): void {
    if (ref.startsWith('R')) return
    if (ref.startsWith('D')) {
      if (this.selectDecision.get(ref) === undefined) {
        throw new HarnessError('not-found', `decision "${ref}" does not exist`)
      }
      return
    }
    if (ref.startsWith('F')) {
      if (this.selectFact.get(ref) === undefined) {
        throw new HarnessError('not-found', `fact "${ref}" does not exist`)
      }
      return
    }
    if (ref.startsWith('T')) {
      if (this.selectTask.get(ref) === undefined) {
        throw new HarnessError('not-found', `task "${ref}" does not exist`)
      }
      return
    }
    throw new HarnessError(
      'invalid',
      `serves entry "${ref}" must be R<n> (plan requirement), D<n> (decision), F<n> (fact) or T<n> (task)`,
    )
  }

  servedBy(taskId: string): string[] {
    const rows = this.db
      .prepare(
        'SELECT task_id, serves FROM readiness_checks ORDER BY task_id, revision DESC, id DESC',
      )
      .all() as unknown as { task_id: string; serves: string }[]
    const seen = new Set<string>()
    const citedBy: string[] = []
    for (const row of rows) {
      if (row.task_id === taskId || seen.has(row.task_id)) continue
      seen.add(row.task_id)
      if (parseList(row.serves, 'serves').includes(taskId)) citedBy.push(row.task_id)
    }
    return citedBy.sort()
  }
}

function normalizeServes(values: readonly string[]): string[] {
  if (!Array.isArray(values)) {
    throw new HarnessError('invalid', 'serves must be an array of refs')
  }
  if (values.length > MAX_READINESS_ITEMS) {
    throw new HarnessError(
      'invalid',
      `serves has ${values.length} entries; limit ${MAX_READINESS_ITEMS}`,
    )
  }
  const unique: string[] = []
  for (const value of values) {
    const ref = assertString(value, 'serves', MAX_READINESS_SERVE_LENGTH).toUpperCase()
    if (!READINESS_SERVE_PATTERN.test(ref)) {
      throw new HarnessError(
        'invalid',
        `serves entry "${ref}" must be R<n> (plan requirement), D<n> (decision), F<n> (fact) or T<n> (task)`,
      )
    }
    if (!unique.includes(ref)) unique.push(ref)
  }
  return unique
}

function normalizeItems(values: readonly string[], label: string, maxLength: number): string[] {
  if (!Array.isArray(values)) {
    throw new HarnessError('invalid', `${label} must be an array of strings`)
  }
  if (values.length === 0) {
    throw new HarnessError('invalid', `${label} must have at least one entry`)
  }
  if (values.length > MAX_READINESS_ITEMS) {
    throw new HarnessError(
      'invalid',
      `${label} has ${values.length} entries; limit ${MAX_READINESS_ITEMS}`,
    )
  }
  const unique: string[] = []
  for (const value of values) {
    const text = assertString(value, label, maxLength)
    if (!unique.includes(text)) unique.push(text)
  }
  return unique
}

function assertAcceptanceQuotesSpec(acceptance: string, spec: string): void {
  const quoted = normalizeWhitespace(acceptance)
  if (quoted.length < MIN_ACCEPTANCE_QUOTE_LENGTH) {
    throw new HarnessError(
      'invalid',
      `acceptance must be at least ${MIN_ACCEPTANCE_QUOTE_LENGTH} characters and quote the task spec, not paraphrase it`,
    )
  }
  if (spec.trim().length === 0) {
    throw new HarnessError(
      'invalid',
      'task spec is empty; write testable acceptance criteria into the task spec before running the readiness drill',
    )
  }
  if (!normalizeWhitespace(spec).includes(quoted)) {
    throw new HarnessError(
      'invalid',
      'acceptance must quote the task spec verbatim (whitespace-insensitive); quote one or more acceptance criteria from the spec',
    )
  }
}

function quotesSpec(acceptance: string, spec: string): boolean {
  const quoted = normalizeWhitespace(acceptance)
  return (
    quoted.length >= MIN_ACCEPTANCE_QUOTE_LENGTH &&
    spec.trim().length > 0 &&
    normalizeWhitespace(spec).includes(quoted)
  )
}

function drillMatches(record: ReadinessRecord, spec: string): boolean {
  return record.specHash.toLowerCase() === hashSpec(spec) && quotesSpec(record.acceptance, spec)
}

export function validateReadinessRows(
  db: DatabaseSync,
  rows: readonly Record<string, unknown>[],
): void {
  const selectTask = db.prepare('SELECT 1 FROM tasks WHERE id = ?')
  const selectDecision = db.prepare('SELECT 1 FROM decisions WHERE ref = ?')
  const selectFact = db.prepare('SELECT 1 FROM facts WHERE ref = ?')
  for (const [index, row] of rows.entries()) {
    const where = `readiness_checks[${index}]`
    const taskId = row.task_id
    if (typeof taskId !== 'string' || selectTask.get(taskId) === undefined) {
      throw new HarnessError('invalid', `${where}: task_id must reference an existing task`)
    }
    const revision = row.revision
    if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 1) {
      throw new HarnessError('invalid', `${where}: revision must be a positive integer`)
    }
    const goal = row.goal
    if (typeof goal !== 'string' || goal.trim().length === 0) {
      throw new HarnessError('invalid', `${where}: goal must be a non-empty string`)
    }
    assertMaxLength(goal, `${where}: goal`, MAX_READINESS_GOAL_LENGTH)
    const acceptance = row.acceptance
    if (typeof acceptance !== 'string' || acceptance.trim().length === 0) {
      throw new HarnessError('invalid', `${where}: acceptance must be a non-empty string`)
    }
    assertMaxLength(acceptance, `${where}: acceptance`, MAX_READINESS_ACCEPTANCE_LENGTH)
    const specHash = row.spec_hash
    if (typeof specHash !== 'string' || !SPEC_HASH_PATTERN.test(specHash)) {
      throw new HarnessError('invalid', `${where}: spec_hash must be a 64-char hex sha256`)
    }
    for (const column of ['serves', 'out_of_scope', 'commands'] as const) {
      const value = row[column]
      if (typeof value !== 'string') {
        throw new HarnessError('invalid', `${where}: ${column} must be a JSON string array`)
      }
      const list = parseList(value, `${where}.${column}`)
      if (column !== 'serves' && list.length === 0) {
        throw new HarnessError('invalid', `${where}: ${column} must have at least one entry`)
      }
      if (list.length > MAX_READINESS_ITEMS) {
        throw new HarnessError(
          'invalid',
          `${where}: ${column} has ${list.length} entries; limit ${MAX_READINESS_ITEMS}`,
        )
      }
      for (const item of list) {
        if (column === 'serves') {
          assertMaxLength(item, `${where}: serves entry`, MAX_READINESS_SERVE_LENGTH)
          if (!READINESS_SERVE_PATTERN.test(item)) {
            throw new HarnessError(
              'invalid',
              `${where}: serves entry "${item}" must be R<n>, D<n>, F<n> or T<n>`,
            )
          }
          if (item.startsWith('D') && selectDecision.get(item) === undefined) {
            throw new HarnessError('not-found', `decision "${item}" does not exist`)
          }
          if (item.startsWith('F') && selectFact.get(item) === undefined) {
            throw new HarnessError('not-found', `fact "${item}" does not exist`)
          }
          if (item.startsWith('T') && selectTask.get(item) === undefined) {
            throw new HarnessError('not-found', `task "${item}" does not exist`)
          }
          continue
        }
        if (item.trim().length === 0) {
          throw new HarnessError('invalid', `${where}: ${column} entry must be non-empty`)
        }
        assertMaxLength(
          item,
          `${where}: ${column} entry`,
          column === 'out_of_scope'
            ? MAX_READINESS_OUT_OF_SCOPE_LENGTH
            : MAX_READINESS_COMMAND_LENGTH,
        )
      }
    }
    const createdAt = row.created_at
    if (typeof createdAt !== 'string' || Number.isNaN(Date.parse(createdAt))) {
      throw new HarnessError('invalid', `${where}: created_at must be an ISO timestamp`)
    }
  }
}

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

function hashSpec(spec: string): string {
  return createHash('sha256').update(spec, 'utf8').digest('hex')
}

function toRecord(row: ReadinessRow): ReadinessRecord {
  return {
    taskId: row.task_id,
    revision: row.revision,
    goal: row.goal,
    acceptance: row.acceptance,
    serves: parseList(row.serves, 'serves'),
    outOfScope: parseList(row.out_of_scope, 'out_of_scope'),
    commands: parseList(row.commands, 'commands'),
    specHash: row.spec_hash,
    createdAt: row.created_at,
  }
}

function parseList(text: string, label: string): string[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new HarnessError('invalid', `corrupt readiness row: ${label} is not valid JSON`)
  }
  if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === 'string')) {
    throw new HarnessError('invalid', `corrupt readiness row: ${label} is not a string array`)
  }
  return parsed
}
