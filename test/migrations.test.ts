import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { MIGRATIONS, migrate } from '../src/db/migrations.js'

function seededV1(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys = ON')
  db.exec(
    'CREATE TABLE IF NOT EXISTS schema_migrations (id INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)',
  )
  for (const statement of MIGRATIONS[0]?.statements ?? []) db.exec(statement)
  db.prepare('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)').run(
    1,
    '2026-11-15T00:00:00.000Z',
  )
  const task = db.prepare(
    'INSERT INTO tasks (id, title, status, spec, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
  )
  task.run(
    'T1',
    'seed one',
    'todo',
    'first seed',
    '2026-11-15T00:00:00.000Z',
    '2026-11-15T00:00:00.000Z',
  )
  task.run('T2', 'seed two', 'done', '', '2026-11-15T00:00:00.000Z', '2026-11-15T00:00:00.000Z')
  db.prepare('INSERT INTO task_deps (task_id, depends_on) VALUES (?, ?)').run('T2', 'T1')
  db.prepare(
    'INSERT INTO decisions (ref, title, body, category, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run('D1', 'seed decision', 'chosen path', 'architecture', '2026-11-15T00:00:00.000Z')
  db.prepare('INSERT INTO session_log (date, session, outcome) VALUES (?, ?, ?)').run(
    '2026-11-15',
    'seed-session',
    'seeded the store',
  )
  db.prepare(
    'INSERT INTO plan_sections (id, title, content, position, updated_at) VALUES (?, ?, ?, ?, ?)',
  ).run('scope', 'Scope', 'seed plan', 1.0, '2026-11-15T00:00:00.000Z')
  db.prepare(
    'INSERT INTO handoff_sections (name, body, position, updated_at) VALUES (?, ?, ?, ?)',
  ).run('last-completed', 'seeded', 1.0, '2026-11-15T00:00:00.000Z')
  return db
}

function exists(db: DatabaseSync, type: 'table' | 'trigger', name: string): boolean {
  return (
    db.prepare('SELECT 1 FROM sqlite_master WHERE type = ? AND name = ?').get(type, name) !==
    undefined
  )
}

function count(db: DatabaseSync, sql: string): number {
  return (db.prepare(sql).get() as { n: number }).n
}

describe('migrations', () => {
  it('upgrades a populated v1 database without losing data', () => {
    const db = seededV1()
    migrate(db)

    const applied = (
      db.prepare('SELECT id FROM schema_migrations ORDER BY id').all() as { id: number }[]
    ).map((row) => row.id)
    expect(applied).toEqual(MIGRATIONS.map((migration) => migration.id))

    for (const table of ['facts', 'facts_fts', 'entities', 'links', 'fact_confirmations']) {
      expect(exists(db, 'table', table)).toBe(true)
    }
    for (const trigger of [
      'facts_ai',
      'facts_ad',
      'facts_au',
      'tasks_ad_links',
      'plan_sections_ad_links',
      'tasks_ad_facts_task',
      'facts_ins_supersedes_format',
      'facts_upd_supersedes_format',
    ]) {
      expect(exists(db, 'trigger', trigger)).toBe(true)
    }

    expect(count(db, 'SELECT COUNT(*) AS n FROM tasks')).toBe(2)
    expect(count(db, 'SELECT COUNT(*) AS n FROM task_deps')).toBe(1)
    expect(
      (db.prepare('SELECT title FROM decisions WHERE ref = ?').get('D1') as { title: string })
        .title,
    ).toBe('seed decision')
    expect(count(db, 'SELECT COUNT(*) AS n FROM plan_sections')).toBe(1)
    expect(count(db, 'SELECT COUNT(*) AS n FROM handoff_sections')).toBe(1)
    expect(count(db, 'SELECT COUNT(*) AS n FROM session_log')).toBe(1)

    db.prepare(
      `INSERT INTO facts (ref, kind, title, body, origin, confidence, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'F1',
      'note',
      'post migration fact',
      'indexed after upgrade',
      'agent',
      1,
      '2026-11-16T00:00:00.000Z',
    )
    const hit = db
      .prepare(
        'SELECT f.ref AS ref FROM facts_fts JOIN facts f ON f.id = facts_fts.rowid WHERE facts_fts MATCH ?',
      )
      .all('post') as { ref: string }[]
    expect(hit.map((row) => row.ref)).toEqual(['F1'])
    db.close()
  })

  it('is idempotent', () => {
    const db = seededV1()
    migrate(db)
    migrate(db)
    expect(count(db, 'SELECT COUNT(*) AS n FROM schema_migrations')).toBe(MIGRATIONS.length)
    expect(count(db, 'SELECT COUNT(*) AS n FROM tasks')).toBe(2)
    db.close()
  })

  it('rejects malformed supersedes refs at the schema level', () => {
    const db = seededV1()
    migrate(db)
    const insert = (supersedes: string): void => {
      db.prepare(
        `INSERT INTO facts (ref, kind, title, body, origin, confidence, supersedes, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        `F${Math.floor(Math.random() * 1_000_000)}`,
        'note',
        't',
        'b',
        'agent',
        1,
        supersedes,
        '2026-11-16T00:00:00.000Z',
      )
    }
    expect(() => insert('X1')).toThrow(/must be an F-ref/)
    expect(() => insert('Fabc')).toThrow(/must be an F-ref/)
    expect(() => insert('F12')).not.toThrow()
    db.close()
  })
})
