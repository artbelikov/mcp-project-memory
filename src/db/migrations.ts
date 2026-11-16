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

const KNOWLEDGE: Migration = {
  id: 2,
  statements: [
    `CREATE TABLE facts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ref TEXT NOT NULL UNIQUE,
      kind TEXT NOT NULL CHECK (kind IN ('gotcha', 'api-fact', 'insight', 'note')),
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      origin TEXT NOT NULL DEFAULT 'agent' CHECK (origin IN ('user', 'agent')),
      confidence REAL NOT NULL DEFAULT 1 CHECK (confidence >= 0 AND confidence <= 1),
      task_id TEXT,
      supersedes TEXT,
      valid_from TEXT,
      valid_to TEXT,
      created_at TEXT NOT NULL
    )`,
    'CREATE INDEX idx_facts_id ON facts (id DESC)',
    'CREATE INDEX idx_facts_kind ON facts (kind)',
    `CREATE VIRTUAL TABLE facts_fts USING fts5(
      title, body, content='facts', content_rowid='id', tokenize='porter unicode61'
    )`,
    `CREATE TRIGGER facts_ai AFTER INSERT ON facts BEGIN
      INSERT INTO facts_fts (rowid, title, body) VALUES (new.id, new.title, new.body);
    END`,
    `CREATE TRIGGER facts_ad AFTER DELETE ON facts BEGIN
      INSERT INTO facts_fts (facts_fts, rowid, title, body)
      VALUES ('delete', old.id, old.title, old.body);
    END`,
    `CREATE TRIGGER facts_au AFTER UPDATE ON facts BEGIN
      INSERT INTO facts_fts (facts_fts, rowid, title, body)
      VALUES ('delete', old.id, old.title, old.body);
      INSERT INTO facts_fts (rowid, title, body) VALUES (new.id, new.title, new.body);
    END`,
    `CREATE TABLE entities (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      kind TEXT NOT NULL DEFAULT 'concept',
      created_at TEXT NOT NULL
    )`,
    `CREATE TABLE links (
      src_kind TEXT NOT NULL CHECK (src_kind IN ('fact', 'decision', 'task', 'plan', 'entity')),
      src_id TEXT NOT NULL,
      rel TEXT NOT NULL,
      dst_kind TEXT NOT NULL CHECK (dst_kind IN ('fact', 'decision', 'task', 'plan', 'entity')),
      dst_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (src_kind, src_id, rel, dst_kind, dst_id)
    )`,
    'CREATE INDEX idx_links_dst ON links (dst_kind, dst_id)',
    'CREATE INDEX idx_links_src ON links (src_kind, src_id)',
    `CREATE TRIGGER tasks_ad_links AFTER DELETE ON tasks BEGIN
      DELETE FROM links
      WHERE (src_kind = 'task' AND src_id = old.id) OR (dst_kind = 'task' AND dst_id = old.id);
    END`,
    `CREATE TRIGGER plan_sections_ad_links AFTER DELETE ON plan_sections BEGIN
      DELETE FROM links
      WHERE (src_kind = 'plan' AND src_id = old.id) OR (dst_kind = 'plan' AND dst_id = old.id);
    END`,
    `CREATE TRIGGER tasks_ad_facts_task AFTER DELETE ON tasks BEGIN
      UPDATE facts SET task_id = NULL WHERE task_id = old.id;
    END`,
  ],
}

export const MIGRATIONS: readonly Migration[] = [BASELINE, KNOWLEDGE]

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
