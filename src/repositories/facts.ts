import type { DatabaseSync } from 'node:sqlite'
import { withTransaction, withUniqueRetry } from '../db/database.js'
import { HarnessError } from '../errors.js'
import {
  assertMaxLength,
  assertString,
  FACT_REF_PATTERN,
  ftsMatchQuery,
  LOG_DATE_PATTERN,
  MAX_FACT_BODY_LENGTH,
  MAX_FACT_NOTE_LENGTH,
  MAX_FACT_TITLE_LENGTH,
  MAX_SEARCH_QUERY_LENGTH,
  nextNumberIn,
  nowIso,
  todayIsoDate,
  truncate,
} from '../util.js'
import type { GraphRepository, Link } from './graph.js'

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
  offset?: number
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

export type FactConfirmation = { confirmedAt: string; note: string | null }

export type FactDetail = {
  fact: Fact
  links: Link[]
  confirmations: FactConfirmation[]
  lastConfirmedAt: string | null
}

export type FactHealthCounts = {
  orphanFacts: number
  duplicatePairs: number
  unusedEntities: number
  staleFacts: number
}

export type FactHealth = {
  counts: FactHealthCounts
  orphanFacts: { ref: string; title: string }[]
  duplicatePairs: { a: string; b: string; title: string }[]
  unusedEntities: string[]
  staleFacts: { ref: string; title: string; daysSince: number }[]
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
const STALE_AFTER_DAYS = 90
const HEALTH_SAMPLE_LIMIT = 100
const DUPLICATE_SCAN_LIMIT = 100
const DUPLICATE_PAIR_LIMIT = 50

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
    const at = nowIso()
    const fact = withUniqueRetry(() =>
      withTransaction(this.db, () => {
        const ref = this.allocateRef()
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
      }),
    )
    return { fact, similar }
  }

  get(ref: string): Fact {
    const fact = this.findRef(ref)
    if (fact === null) throw new HarnessError('not-found', `fact "${ref}" does not exist`)
    return fact
  }

  search(filter: FactFilter = {}): FactSearchHit[] {
    const limit = clampLimit(filter.limit)
    const offset = clampOffset(filter.offset)
    const today = todayIsoDate()
    if (filter.query !== undefined && filter.query.trim().length > 0) {
      return this.rankSearch(filter, limit, offset, today)
    }
    const { clauses, params } = this.buildFilters(filter, today)
    const rows = this.db
      .prepare(`SELECT * FROM facts ${whereClause(clauses)} ORDER BY id DESC LIMIT ? OFFSET ?`)
      .all(...params, limit, offset) as unknown as FactRow[]
    return rows.map((row) => ({ ...toFact(row), rank: 0, snippet: truncate(row.body, 80) }))
  }

  list(filter: FactFilter = {}): Fact[] {
    const limit = clampLimit(filter.limit ?? 200, 200)
    const offset = clampOffset(filter.offset)
    const today = todayIsoDate()
    const { clauses, params } = this.buildFilters(filter, today)
    const rows = this.db
      .prepare(`SELECT * FROM facts ${whereClause(clauses)} ORDER BY id DESC LIMIT ? OFFSET ?`)
      .all(...params, limit, offset) as unknown as FactRow[]
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

  confirm(
    ref: string,
    note?: string,
  ): { ref: string; confirmedAt: string; note: string | null; confirmations: number } {
    if (this.findRef(ref) === null) {
      throw new HarnessError('not-found', `fact "${ref}" does not exist`)
    }
    const cleaned = assertOptionalNote(note)
    const at = nowIso()
    this.db
      .prepare('INSERT INTO fact_confirmations (fact_ref, confirmed_at, note) VALUES (?, ?, ?)')
      .run(ref, at, cleaned)
    const count = (
      this.db
        .prepare('SELECT COUNT(*) AS n FROM fact_confirmations WHERE fact_ref = ?')
        .get(ref) as { n: number }
    ).n
    return { ref, confirmedAt: at, note: cleaned, confirmations: count }
  }

  confirmationsFor(ref: string): FactConfirmation[] {
    const rows = this.db
      .prepare(
        'SELECT confirmed_at, note FROM fact_confirmations WHERE fact_ref = ? ORDER BY confirmed_at ASC, id ASC',
      )
      .all(ref) as unknown as { confirmed_at: string; note: string | null }[]
    return rows.map((row) => ({ confirmedAt: row.confirmed_at, note: row.note }))
  }

  detail(ref: string): FactDetail {
    const fact = this.get(ref)
    const confirmations = this.confirmationsFor(ref)
    return {
      fact,
      links: this.graph.linksFor(`fact:${ref}`),
      confirmations,
      lastConfirmedAt: confirmations.at(-1)?.confirmedAt ?? null,
    }
  }

  health(): FactHealth {
    const today = todayIsoDate()
    const orphanFacts = this.orphanSamples(today)
    const duplicatePairs = this.duplicatePairs()
    const unusedEntities = this.unusedEntities()
    const staleFacts = this.staleSamples(today)
    return {
      counts: {
        orphanFacts: this.countOrphans(today),
        duplicatePairs: duplicatePairs.length,
        unusedEntities: this.countUnusedEntities(),
        staleFacts: this.countStale(today),
      },
      orphanFacts,
      duplicatePairs,
      unusedEntities,
      staleFacts,
    }
  }

  private countOrphans(today: string): number {
    return (
      this.db
        .prepare(
          `SELECT COUNT(*) AS n FROM facts f WHERE ${ORPHAN_CLAUSE} AND (f.valid_to IS NULL OR f.valid_to >= ?)`,
        )
        .get(today) as { n: number }
    ).n
  }

  private orphanSamples(today: string): { ref: string; title: string }[] {
    return this.db
      .prepare(
        `SELECT f.ref AS ref, f.title AS title FROM facts f
         WHERE ${ORPHAN_CLAUSE} AND (f.valid_to IS NULL OR f.valid_to >= ?)
         ORDER BY f.id DESC LIMIT ?`,
      )
      .all(today, HEALTH_SAMPLE_LIMIT) as unknown as { ref: string; title: string }[]
  }

  private countUnusedEntities(): number {
    return (
      this.db
        .prepare(`SELECT COUNT(*) AS n FROM entities e WHERE ${UNUSED_ENTITY_CLAUSE}`)
        .get() as { n: number }
    ).n
  }

  private unusedEntities(): string[] {
    const rows = this.db
      .prepare(
        `SELECT e.name AS name FROM entities e WHERE ${UNUSED_ENTITY_CLAUSE} ORDER BY e.name LIMIT ?`,
      )
      .all(HEALTH_SAMPLE_LIMIT) as unknown as { name: string }[]
    return rows.map((row) => row.name)
  }

  private countStale(today: string): number {
    return (
      this.db
        .prepare(`SELECT COUNT(*) AS n FROM (${staleSelect()}) WHERE days >= ?`)
        .get(today, today, STALE_AFTER_DAYS) as { n: number }
    ).n
  }

  private staleSamples(today: string): { ref: string; title: string; daysSince: number }[] {
    return this.db
      .prepare(
        `SELECT ref, title, days AS daysSince FROM (${staleSelect()}) WHERE days >= ?
         ORDER BY days DESC LIMIT ?`,
      )
      .all(today, today, STALE_AFTER_DAYS, HEALTH_SAMPLE_LIMIT) as unknown as {
      ref: string
      title: string
      daysSince: number
    }[]
  }

  private duplicatePairs(): { a: string; b: string; title: string }[] {
    const rows = this.db
      .prepare(
        `SELECT ref, title FROM facts
         WHERE ref NOT IN (SELECT supersedes FROM facts WHERE supersedes IS NOT NULL)
         ORDER BY id DESC LIMIT ?`,
      )
      .all(DUPLICATE_SCAN_LIMIT) as unknown as { ref: string; title: string }[]
    const similar = new Map<string, Set<string>>()
    for (const row of rows) {
      similar.set(row.ref, new Set(this.findSimilar(row.title).map((entry) => entry.ref)))
    }
    const seen = new Set<string>()
    const pairs: { a: string; b: string; title: string }[] = []
    for (const row of rows) {
      for (const other of similar.get(row.ref) ?? []) {
        if (row.ref === other || !similar.get(other)?.has(row.ref)) continue
        const key = `${row.ref}|${other}`
        const reverseKey = `${other}|${row.ref}`
        if (seen.has(key) || seen.has(reverseKey)) continue
        seen.add(key)
        pairs.push({ a: row.ref, b: other, title: row.title })
        if (pairs.length >= DUPLICATE_PAIR_LIMIT) return pairs
      }
    }
    return pairs
  }

  private rankSearch(
    filter: FactFilter,
    limit: number,
    offset: number,
    today: string,
  ): FactSearchHit[] {
    const query = filter.query ?? ''
    assertMaxLength(query, 'query', MAX_SEARCH_QUERY_LENGTH)
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
          LIMIT ? OFFSET ?`,
      )
      .all(match, ...params, limit, offset) as unknown as (FactRow & { bm: number; snip: string })[]
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

function clampOffset(offset: number | undefined): number {
  const value = offset ?? 0
  if (!Number.isInteger(value) || value < 0) {
    throw new HarnessError('invalid', 'offset must be a non-negative integer')
  }
  return value
}

function assertOptionalNote(value: string | undefined): string | null {
  if (value === undefined) return null
  const trimmed = value.trim()
  if (trimmed.length === 0) return null
  assertMaxLength(trimmed, 'note', MAX_FACT_NOTE_LENGTH)
  return trimmed
}

const ORPHAN_CLAUSE = `f.ref NOT IN (SELECT supersedes FROM facts WHERE supersedes IS NOT NULL)
  AND f.task_id IS NULL
  AND NOT EXISTS (SELECT 1 FROM facts s WHERE s.supersedes = f.ref)
  AND NOT EXISTS (
    SELECT 1 FROM links
    WHERE (src_kind = 'fact' AND src_id = f.ref) OR (dst_kind = 'fact' AND dst_id = f.ref)
  )`

const UNUSED_ENTITY_CLAUSE = `NOT EXISTS (
  SELECT 1 FROM links
  WHERE (src_kind = 'entity' AND src_id = e.name) OR (dst_kind = 'entity' AND dst_id = e.name)
)`

function staleSelect(): string {
  return `SELECT f.ref AS ref, f.title AS title,
      CAST(julianday('now') - julianday(COALESCE(
        (SELECT MAX(c.confirmed_at) FROM fact_confirmations c WHERE c.fact_ref = f.ref),
        f.created_at)) AS INTEGER) AS days
    FROM facts f
    WHERE f.ref NOT IN (SELECT supersedes FROM facts WHERE supersedes IS NOT NULL)
      AND (f.valid_from IS NULL OR f.valid_from <= ?)
      AND (f.valid_to IS NULL OR f.valid_to >= ?)`
}
