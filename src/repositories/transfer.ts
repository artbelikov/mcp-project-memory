import type { DatabaseSync } from 'node:sqlite'
import { isUniqueViolation, withTransaction } from '../db/database.js'
import { MIGRATIONS } from '../db/migrations.js'
import { HarnessError } from '../errors.js'
import { nowIso } from '../util.js'

export const DUMP_FORMAT = 'mcp-project-memory'

export const DUMP_TABLES = [
  'tasks',
  'task_deps',
  'decisions',
  'session_log',
  'handoff_sections',
  'plan_sections',
  'facts',
  'fact_confirmations',
  'entities',
  'links',
] as const

export type DumpTable = (typeof DUMP_TABLES)[number]
export type DumpRow = Record<string, unknown>

export type HarnessDumpInput = { format: typeof DUMP_FORMAT; schemaVersion: number } & Record<
  DumpTable,
  DumpRow[]
>

export type HarnessDump = HarnessDumpInput & { exportedAt: string }

export type ImportMode = 'replace' | 'merge'

export type ImportResult = {
  mode: ImportMode
  inserted: Record<string, number>
  skipped: Record<string, number>
}

const DELETE_ORDER: readonly DumpTable[] = [
  'links',
  'fact_confirmations',
  'facts',
  'entities',
  'task_deps',
  'plan_sections',
  'handoff_sections',
  'session_log',
  'decisions',
  'tasks',
]

const INSERT_ORDER: readonly DumpTable[] = [
  'tasks',
  'task_deps',
  'decisions',
  'session_log',
  'handoff_sections',
  'plan_sections',
  'facts',
  'fact_confirmations',
  'entities',
  'links',
]

const COLUMN_PATTERN = /^[a-z_][a-z0-9_]*$/

export function currentSchemaVersion(): number {
  const last = MIGRATIONS.at(-1)
  if (last === undefined) throw new HarnessError('invalid', 'no migrations defined')
  return last.id
}

export function exportHarness(db: DatabaseSync): HarnessDump {
  const rows = (sql: string): DumpRow[] => db.prepare(sql).all() as unknown as DumpRow[]
  return {
    format: DUMP_FORMAT,
    schemaVersion: currentSchemaVersion(),
    exportedAt: nowIso(),
    tasks: rows('SELECT * FROM tasks ORDER BY id'),
    task_deps: rows('SELECT * FROM task_deps ORDER BY task_id, depends_on'),
    decisions: rows('SELECT * FROM decisions ORDER BY id'),
    session_log: rows('SELECT * FROM session_log ORDER BY id'),
    handoff_sections: rows('SELECT * FROM handoff_sections ORDER BY position'),
    plan_sections: rows('SELECT * FROM plan_sections ORDER BY position'),
    facts: rows('SELECT * FROM facts ORDER BY id'),
    fact_confirmations: rows('SELECT * FROM fact_confirmations ORDER BY id'),
    entities: rows('SELECT * FROM entities ORDER BY id'),
    links: rows('SELECT * FROM links ORDER BY created_at, src_kind, src_id, rel'),
  }
}

export function importHarness(
  db: DatabaseSync,
  dump: HarnessDumpInput,
  mode: ImportMode,
): ImportResult {
  if (dump.format !== DUMP_FORMAT) {
    throw new HarnessError('invalid', `dump format "${dump.format}" is not ${DUMP_FORMAT}`)
  }
  const expected = currentSchemaVersion()
  if (dump.schemaVersion !== expected) {
    throw new HarnessError(
      'invalid',
      `dump schema version ${dump.schemaVersion} does not match this server (${expected})`,
    )
  }
  return withTransaction(db, () => {
    if (mode === 'replace') {
      for (const table of DELETE_ORDER) db.exec(`DELETE FROM ${table}`)
    }
    const inserted: Record<string, number> = {}
    const skipped: Record<string, number> = {}
    for (const table of INSERT_ORDER) {
      let ins = 0
      let skip = 0
      for (const row of dump[table]) {
        try {
          if (insertRow(db, table, row) > 0) ins += 1
          else skip += 1
        } catch (error) {
          if (error instanceof HarnessError) throw error
          if (isUniqueViolation(error) && mode === 'merge') {
            skip += 1
            continue
          }
          throw new HarnessError(
            'invalid',
            `import failed on table "${table}": ${error instanceof Error ? error.message : String(error)}`,
          )
        }
      }
      inserted[table] = ins
      skipped[table] = skip
    }
    return { mode, inserted, skipped }
  })
}

function insertRow(db: DatabaseSync, table: string, row: DumpRow): number {
  const columns = Object.keys(row)
  if (columns.length === 0) return 0
  for (const column of columns) {
    if (!COLUMN_PATTERN.test(column)) {
      throw new HarnessError('invalid', `invalid column "${column}" in table "${table}"`)
    }
  }
  const statement = db.prepare(
    `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
  )
  const values = columns.map((column) => bindableValue(table, column, row[column]))
  return Number(statement.run(...values).changes)
}

function bindableValue(table: string, column: string, value: unknown): string | number | null {
  if (value === null || typeof value === 'string' || typeof value === 'number') return value
  if (typeof value === 'boolean') return value ? 1 : 0
  throw new HarnessError(
    'invalid',
    `column "${column}" of table "${table}" must be a string, number or null`,
  )
}
