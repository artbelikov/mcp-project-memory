import type { DatabaseSync } from 'node:sqlite'
import { withTransaction } from '../db/database.js'
import { HarnessError } from '../errors.js'
import {
  FACT_REF_PATTERN,
  ftsMatchQuery,
  LOG_DATE_PATTERN,
  MAX_FACT_BODY_LENGTH,
  MAX_FACT_TITLE_LENGTH,
  MAX_SEARCH_QUERY_LENGTH,
  nextNumberIn,
  nowIso,
  todayIsoDate,
  truncate,
} from '../util.js'
import type { GraphRepository } from './graph.js'

export const FACT_KINDS = ['gotcha', 'api-fact', 'insight', 'note'] as const
export type FactKind = (typeof FACT_KINDS)[number]
export const FACT_ORIGINS = ['user', 'agent'] as const
export type FactOrigin = (typeof FACT_ORIGINS)[number]

export type Fact = {
  ref: string
  kind: FactKind
  title: string
  body: string
  origin: FactOrigin
  confidence: number
  taskId: string | null
  supersedes: string | null
  validFrom: string | null
  validTo: string | null
  createdAt: string
}

export type FactSearchHit = Fact & { rank: number; snippet: string }

export type SimilarFact = { ref: string; title: string; rank: number }

export type FactFilter = {
  query?: string
  kind?: FactKind
  origin?: FactOrigin
  taskId?: string
  entity?: string
  includeSuperseded?: boolean
  limit?: number
}

export type FactAppendInput = {
  kind: FactKind
  title: string
  body: string
  origin?: FactOrigin
  confidence?: number
  taskId?: string
  supersedes?: string
  validFrom?: string
  validTo?: string
  links?: { rel: string; dst: string }[]
}

export type FactSummary = {
  total: number
  byKind: Record<FactKind, number>
  recent: Pick<Fact, 'ref' | 'title' | 'kind'>[]
}

type FactRow = {
  ref: string
  kind: string
  title: string
  body: string
  origin: string
  confidence: number
  task_id: string | null
  supersedes: string | null
  valid_from: string | null
  valid_to: string | null
  created_at: string
}

const ORIGIN_BOOST_USER = 1.25
const SNIPPET_TOKENS = 12

export class FactsRepository {
  constructor(
    private readonly db: DatabaseSync,
    private readonly graph: GraphRepository,
  ) {}

  append(input: FactAppendInput): { fact: Fact; similar: SimilarFact[] } {
    const kind = assertKind(input.kind)
    const title = assertString(input.title, 'title', MAX_FACT_TITLE_LENGTH)
    const body = assertString(input.body, 'body', MAX_FACT_BODY_LENGTH)
    const origin = assertOrigin(input.origin ?? 'agent')
    const confidence = assertConfidence(input.confidence ?? 1)
    const validFrom = assertDate(input.validFrom, 'validFrom')
    const validTo = assertDate(input.validTo, 'validTo')
    if (validFrom !== null && validTo !== null && validFrom > validTo) {
      throw new HarnessError('invalid', 'validFrom must not be after validTo')
    }
    if (input.taskId !== undefined && !this.taskExists(input.taskId)) {
      throw new HarnessError('not-found', `task "${input.taskId}" does not exist`)
    }
    if (input.supersedes !== undefined && this.findRef(input.supersedes) === null) {
      throw new HarnessError('not-found', `fact "${input.supersedes}" does not exist`)
    }
    const similar = this.findSimilar(title)
    const ref = this.allocateRef()
    const at = nowIso()
    const fact = withTransaction(this.db, () => {
      this.db
        .prepare(
          `INSERT INTO facts
           (ref, kind, title, body, origin, confidence, task_id, supersedes, valid_from, valid_to, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          ref,
          kind,
          title,
          body,
          origin,
          confidence,
          input.taskId ?? null,
          input.supersedes ?? null,
          validFrom,
          validTo,
          at,
        )
      for (const link of input.links ?? []) {
        this.graph.link(`fact:${ref}`, link.rel, link.dst)
      }
      const created = this.findRef(ref)
      if (created === null) throw new HarnessError('invalid', 'fact persistence failed')
      return created
    })
    return { fact, similar }
  }

  get(ref: string): Fact {
    const fact = this.findRef(ref)
    if (fact === null) throw new HarnessError('not-found', `fact "${ref}" does not exist`)
    return fact
  }

  search(filter: FactFilter = {}): FactSearchHit[] {
    const limit = clampLimit(filter.limit)
    const today = todayIsoDate()
    if (filter.query !== undefined && filter.query.trim().length > 0) {
      return this.rankSearch(filter, limit, today)
    }
    const { clauses, params } = this.buildFilters(filter, today)
    const rows = this.db
      .prepare(`SELECT * FROM facts ${whereClause(clauses)} ORDER BY id DESC LIMIT ?`)
      .all(...params, limit) as unknown as FactRow[]
    return rows.map((row) => ({ ...toFact(row), rank: 0, snippet: truncate(row.body, 80) }))
  }

  list(filter: FactFilter = {}): Fact[] {
    const limit = clampLimit(filter.limit ?? 200, 200)
    const today = todayIsoDate()
    const { clauses, params } = this.buildFilters(filter, today)
    const rows = this.db
      .prepare(`SELECT * FROM facts ${whereClause(clauses)} ORDER BY id DESC LIMIT ?`)
      .all(...params, limit) as unknown as FactRow[]
    return rows.map(toFact)
  }

  summary(): FactSummary {
    const total = (this.db.prepare('SELECT COUNT(*) AS n FROM facts').get() as { n: number }).n
    const byKind = Object.fromEntries(FACT_KINDS.map((kind) => [kind, 0])) as Record<
      FactKind,
      number
    >
    const counts = this.db
      .prepare('SELECT kind, COUNT(*) AS n FROM facts GROUP BY kind')
      .all() as unknown as { kind: FactKind; n: number }[]
    for (const row of counts) byKind[row.kind] = row.n
    const recent = this.db
      .prepare('SELECT ref, title, kind FROM facts ORDER BY id DESC LIMIT 3')
      .all() as unknown as Pick<Fact, 'ref' | 'title' | 'kind'>[]
    return { total, byKind, recent }
  }

  private rankSearch(filter: FactFilter, limit: number, today: string): FactSearchHit[] {
    const query = filter.query ?? ''
    if (query.length > MAX_SEARCH_QUERY_LENGTH) {
      throw new HarnessError(
        'invalid',
        `query must not exceed ${MAX_SEARCH_QUERY_LENGTH} characters`,
      )
    }
    const match = ftsMatchQuery(query)
    const { clauses, params } = this.buildFilters(filter, today)
    const extra = clauses.length > 0 ? `AND ${clauses.join(' AND ')}` : ''
    const rows = this.db
      .prepare(
        `SELECT f.*, bm25(facts_fts, 5.0, 1.0) AS bm,
                snippet(facts_fts, 1, '[', ']', '…', ${SNIPPET_TOKENS}) AS snip
         FROM facts_fts JOIN facts f ON f.id = facts_fts.rowid
         WHERE facts_fts MATCH ? ${extra}
         ORDER BY bm * (CASE f.origin WHEN 'user' THEN ${ORIGIN_BOOST_USER} ELSE 1.0 END)
                  * (0.75 + 0.25 * f.confidence) ASC
         LIMIT ?`,
      )
      .all(match, ...params, limit) as unknown as (FactRow & { bm: number; snip: string })[]
    return rows.map((row) => ({
      ...toFact(row),
      rank:
        row.bm * (row.origin === 'user' ? ORIGIN_BOOST_USER : 1) * (0.75 + 0.25 * row.confidence),
      snippet: row.snip,
    }))
  }

  private buildFilters(
    filter: FactFilter,
    today: string,
  ): { clauses: string[]; params: (string | number)[] } {
    const clauses: string[] = []
    const params: (string | number)[] = []
    if (filter.includeSuperseded !== true) {
      clauses.push('ref NOT IN (SELECT supersedes FROM facts WHERE supersedes IS NOT NULL)')
    }
    clauses.push('(valid_from IS NULL OR valid_from <= ?)')
    params.push(today)
    clauses.push('(valid_to IS NULL OR valid_to >= ?)')
    params.push(today)
    if (filter.kind !== undefined) {
      clauses.push('kind = ?')
      params.push(assertKind(filter.kind))
    }
    if (filter.origin !== undefined) {
      clauses.push('origin = ?')
      params.push(assertOrigin(filter.origin))
    }
    if (filter.taskId !== undefined) {
      clauses.push('task_id = ?')
      params.push(filter.taskId)
    }
    if (filter.entity !== undefined) {
      const entity = filter.entity.trim().toLowerCase()
      clauses.push(
        `(ref IN (SELECT src_id FROM links WHERE src_kind = 'fact' AND dst_kind = 'entity' AND dst_id = ?)
          OR ref IN (SELECT dst_id FROM links WHERE dst_kind = 'fact' AND src_kind = 'entity' AND src_id = ?))`,
      )
      params.push(entity, entity)
    }
    return { clauses, params }
  }

  private findSimilar(title: string): SimilarFact[] {
    let match: string
    try {
      match = ftsMatchQuery(title)
    } catch {
      return []
    }
    const rows = this.db
      .prepare(
        `SELECT f.ref, f.title, bm25(facts_fts, 5.0, 1.0) AS bm
         FROM facts_fts JOIN facts f ON f.id = facts_fts.rowid
         WHERE facts_fts MATCH ?
           AND f.ref NOT IN (SELECT supersedes FROM facts WHERE supersedes IS NOT NULL)
         ORDER BY bm ASC LIMIT 3`,
      )
      .all(match) as unknown as { ref: string; title: string; bm: number }[]
    return rows.map((row) => ({ ref: row.ref, title: row.title, rank: row.bm }))
  }

  private findRef(ref: string): Fact | null {
    const row = this.db.prepare('SELECT * FROM facts WHERE ref = ?').get(ref) as FactRow | undefined
    return row === undefined ? null : toFact(row)
  }

  private taskExists(id: string): boolean {
    return this.db.prepare('SELECT 1 FROM tasks WHERE id = ?').get(id) !== undefined
  }

  private allocateRef(): string {
    const refs = (
      this.db.prepare('SELECT ref FROM facts').all() as unknown as { ref: string }[]
    ).map((row) => row.ref)
    return `F${nextNumberIn(refs, FACT_REF_PATTERN)}`
  }
}

function toFact(row: FactRow): Fact {
  if (!isFactKind(row.kind)) throw new Error(`corrupt fact row: unknown kind "${row.kind}"`)
  if (!isFactOrigin(row.origin)) throw new Error(`corrupt fact row: unknown origin "${row.origin}"`)
  return {
    ref: row.ref,
    kind: row.kind,
    title: row.title,
    body: row.body,
    origin: row.origin,
    confidence: row.confidence,
    taskId: row.task_id,
    supersedes: row.supersedes,
    validFrom: row.valid_from,
    validTo: row.valid_to,
    createdAt: row.created_at,
  }
}

function isFactKind(value: string): value is FactKind {
  return FACT_KINDS.includes(value as FactKind)
}

function isFactOrigin(value: string): value is FactOrigin {
  return FACT_ORIGINS.includes(value as FactOrigin)
}

function assertKind(value: string): FactKind {
  if (!isFactKind(value)) {
    throw new HarnessError('invalid', `kind must be one of ${FACT_KINDS.join(', ')}`)
  }
  return value
}

function assertOrigin(value: string): FactOrigin {
  if (!isFactOrigin(value)) {
    throw new HarnessError('invalid', `origin must be one of ${FACT_ORIGINS.join(', ')}`)
  }
  return value
}

function assertConfidence(value: number): number {
  if (typeof value !== 'number' || Number.isNaN(value) || value < 0 || value > 1) {
    throw new HarnessError('invalid', 'confidence must be a number between 0 and 1')
  }
  return value
}

function assertDate(value: string | undefined, label: string): string | null {
  if (value === undefined) return null
  const trimmed = value.trim()
  if (trimmed.length === 0) return null
  if (!LOG_DATE_PATTERN.test(trimmed)) {
    throw new HarnessError('invalid', `${label} must be an ISO date (YYYY-MM-DD)`)
  }
  return trimmed
}

function assertString(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new HarnessError('invalid', `${label} must be a non-empty string`)
  }
  const trimmed = value.trim()
  if (trimmed.length > maxLength) {
    throw new HarnessError('invalid', `${label} must not exceed ${maxLength} characters`)
  }
  return trimmed
}

function clampLimit(limit: number | undefined, max = 50): number {
  const value = limit ?? Math.min(10, max)
  if (!Number.isInteger(value) || value < 1 || value > max) {
    throw new HarnessError('invalid', `limit must be an integer 1-${max}`)
  }
  return value
}

function whereClause(clauses: readonly string[]): string {
  return clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''
}
