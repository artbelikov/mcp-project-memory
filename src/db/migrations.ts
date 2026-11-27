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

const CONFIRMATIONS: Migration = {
  id: 3,
  statements: [
    `CREATE TABLE fact_confirmations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      fact_ref TEXT NOT NULL REFERENCES facts (ref) ON DELETE CASCADE,
      confirmed_at TEXT NOT NULL,
      note TEXT
    )`,
    'CREATE INDEX idx_fact_confirmations_ref ON fact_confirmations (fact_ref, confirmed_at)',
    `CREATE TRIGGER facts_ins_supersedes_format BEFORE INSERT ON facts
     WHEN new.supersedes IS NOT NULL
       AND (new.supersedes NOT GLOB 'F*' OR new.supersedes GLOB '*[^F0-9]*')
     BEGIN
       SELECT RAISE(ABORT, 'facts.supersedes must be an F-ref like F12');
     END`,
    `CREATE TRIGGER facts_upd_supersedes_format BEFORE UPDATE ON facts
     WHEN new.supersedes IS NOT NULL
       AND (new.supersedes NOT GLOB 'F*' OR new.supersedes GLOB '*[^F0-9]*')
     BEGIN
       SELECT RAISE(ABORT, 'facts.supersedes must be an F-ref like F12');
     END`,
  ],
}

const REVIEWS: Migration = {
  id: 4,
  statements: [
    `CREATE TABLE reviews (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ref TEXT NOT NULL UNIQUE,
      task_id TEXT NOT NULL UNIQUE,
      round INTEGER NOT NULL DEFAULT 1,
      phase TEXT NOT NULL DEFAULT 'hunting' CHECK (phase IN ('hunting', 'refuting', 'fixing', 'verified', 'waived', 'escalated', 'abandoned')),
      risk TEXT NOT NULL DEFAULT 'medium' CHECK (risk IN ('low', 'medium', 'high', 'exempt')),
      base_ref TEXT,
      base_sha TEXT,
      head_sha TEXT,
      diff_hash TEXT,
      changed_paths TEXT NOT NULL DEFAULT '[]',
      oracle TEXT NOT NULL DEFAULT '',
      reviewer TEXT,
      fresh_context INTEGER NOT NULL DEFAULT 0,
      summary TEXT,
      verdict TEXT CHECK (verdict IS NULL OR verdict IN ('verified', 'verified-with-waivers', 'exempt', 'escalated')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      closed_at TEXT
    )`,
    'CREATE INDEX idx_reviews_task_id ON reviews (task_id)',
    `CREATE TABLE review_findings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      review_ref TEXT NOT NULL REFERENCES reviews (ref) ON DELETE CASCADE,
      round INTEGER NOT NULL,
      seq INTEGER NOT NULL,
      fingerprint TEXT NOT NULL,
      class_key TEXT,
      lens TEXT NOT NULL CHECK (lens IN ('correctness', 'security', 'data', 'tests', 'conventions', 'blast-radius', 'over-engineering', 'spec')),
      severity TEXT NOT NULL DEFAULT 'minor' CHECK (severity IN ('blocker', 'major', 'minor', 'nit')),
      status TEXT NOT NULL DEFAULT 'candidate' CHECK (status IN ('candidate', 'confirmed', 'refuted', 'plausible', 'fixed', 'waived', 'rejected', 'duplicate', 'pre-existing')),
      title TEXT NOT NULL,
      file TEXT NOT NULL,
      line INTEGER NOT NULL,
      claim TEXT NOT NULL,
      failure_mode TEXT NOT NULL,
      evidence TEXT NOT NULL,
      introduced_by_diff INTEGER NOT NULL DEFAULT 1,
      confidence REAL NOT NULL DEFAULT 0.5 CHECK (confidence >= 0 AND confidence <= 1),
      refuter TEXT,
      rebuttal TEXT,
      votes_for INTEGER NOT NULL DEFAULT 0,
      votes_against INTEGER NOT NULL DEFAULT 0,
      one_fact_that_would_overturn TEXT,
      class_scan TEXT,
      resolution TEXT,
      decision_ref TEXT,
      fixed_round INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      closed_at TEXT,
      UNIQUE (review_ref, fingerprint)
    )`,
    'CREATE INDEX idx_review_findings_review ON review_findings (review_ref, seq)',
    'CREATE INDEX idx_review_findings_status ON review_findings (review_ref, status)',
    `CREATE TABLE review_refutations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      review_ref TEXT NOT NULL REFERENCES reviews (ref) ON DELETE CASCADE,
      finding_id INTEGER NOT NULL REFERENCES review_findings (id) ON DELETE CASCADE,
      round INTEGER NOT NULL,
      refuter TEXT NOT NULL,
      verdict TEXT NOT NULL CHECK (verdict IN ('confirmed', 'refuted', 'plausible')),
      reasoning TEXT NOT NULL,
      kill_strategy TEXT NOT NULL,
      evidence TEXT NOT NULL,
      severity TEXT CHECK (severity IS NULL OR severity IN ('blocker', 'major', 'minor', 'nit')),
      one_fact_that_would_overturn TEXT,
      repro TEXT,
      created_at TEXT NOT NULL,
      UNIQUE (finding_id, refuter, round)
    )`,
    'CREATE INDEX idx_review_refutations_finding ON review_refutations (finding_id, round)',
    `CREATE TABLE review_checks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      review_ref TEXT NOT NULL REFERENCES reviews (ref) ON DELETE CASCADE,
      round INTEGER NOT NULL,
      name TEXT NOT NULL,
      command TEXT NOT NULL,
      exit_code INTEGER NOT NULL,
      output_digest TEXT,
      output_excerpt TEXT,
      created_at TEXT NOT NULL
    )`,
    'CREATE INDEX idx_review_checks_review ON review_checks (review_ref, round, name)',
    `CREATE TABLE review_coverage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      review_ref TEXT NOT NULL REFERENCES reviews (ref) ON DELETE CASCADE,
      round INTEGER NOT NULL,
      lens TEXT NOT NULL CHECK (lens IN ('correctness', 'security', 'data', 'tests', 'conventions', 'blast-radius', 'over-engineering', 'spec')),
      files_examined TEXT NOT NULL,
      result TEXT NOT NULL CHECK (result IN ('clean', 'findings')),
      evidence TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (review_ref, round, lens)
    )`,
    'CREATE INDEX idx_review_coverage_review ON review_coverage (review_ref, round)',
    `CREATE TRIGGER tasks_ad_reviews AFTER DELETE ON tasks BEGIN
      UPDATE reviews
      SET phase = 'abandoned', closed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE task_id = old.id AND phase NOT IN ('verified', 'waived', 'escalated', 'abandoned');
    END`,
  ],
}

const READINESS: Migration = {
  id: 5,
  statements: [
    `CREATE TABLE readiness_checks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
      revision INTEGER NOT NULL CHECK (typeof(revision) = 'integer' AND revision > 0),
      goal TEXT NOT NULL,
      acceptance TEXT NOT NULL,
      serves TEXT NOT NULL DEFAULT '[]',
      out_of_scope TEXT NOT NULL DEFAULT '[]',
      commands TEXT NOT NULL DEFAULT '[]',
      spec_hash TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE (task_id, revision)
    )`,
    'CREATE INDEX idx_readiness_task ON readiness_checks (task_id, revision DESC)',
  ],
}

export const MIGRATIONS: readonly Migration[] = [
  BASELINE,
  KNOWLEDGE,
  CONFIRMATIONS,
  REVIEWS,
  READINESS,
]

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
