import type { DatabaseSync } from 'node:sqlite'

type Migration = {
  readonly id: number
  readonly statements: readonly string[]
}

const BASELINE: Migration = {
  id: 1,
  statements: [
    `CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'todo' CHECK (status IN ('todo', 'in-progress', 'blocked', 'done', 'cancelled')),
      blocked_reason TEXT,
      spec TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,
    `CREATE TABLE task_deps (
      task_id TEXT NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
      depends_on TEXT NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
      PRIMARY KEY (task_id, depends_on)
    )`,
    'CREATE INDEX idx_task_deps_depends_on ON task_deps (depends_on)',
    `CREATE TABLE session_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL,
      session TEXT NOT NULL,
      outcome TEXT NOT NULL,
      task_id TEXT
    )`,
    'CREATE INDEX idx_session_log_id ON session_log (id DESC)',
    `CREATE TABLE decisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ref TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      category TEXT,
      task_id TEXT,
      supersedes TEXT,
      created_at TEXT NOT NULL
    )`,
    'CREATE INDEX idx_decisions_id ON decisions (id DESC)',
    `CREATE TABLE handoff_sections (
      name TEXT PRIMARY KEY,
      body TEXT NOT NULL,
      position REAL NOT NULL,
      updated_at TEXT NOT NULL
    )`,
    `CREATE TABLE plan_sections (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      content TEXT NOT NULL DEFAULT '',
      position REAL NOT NULL,
      updated_at TEXT NOT NULL
    )`,
    'CREATE INDEX idx_plan_sections_position ON plan_sections (position)',
  ],
}

export const MIGRATIONS: readonly Migration[] = [BASELINE]

export function migrate(db: DatabaseSync): void {
  db.exec(
    'CREATE TABLE IF NOT EXISTS schema_migrations (id INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)',
  )
  const applied = new Set(
    (db.prepare('SELECT id FROM schema_migrations').all() as unknown as { id: number }[]).map(
      (row) => row.id,
    ),
  )
  const pending = MIGRATIONS.filter((migration) => !applied.has(migration.id))
  if (pending.length === 0) return
  db.exec('BEGIN IMMEDIATE')
  try {
    for (const migration of pending) {
      for (const statement of migration.statements) db.exec(statement)
      db.prepare('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)').run(
        migration.id,
        new Date().toISOString(),
      )
    }
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}
