import type { DatabaseSync, StatementSync } from 'node:sqlite'
import { HarnessError } from '../errors.js'
import {
  assertMaxLength,
  HANDOFF_SECTION_PATTERN,
  MAX_HANDOFF_BODY_LENGTH,
  nowIso,
} from '../util.js'

export type HandoffSection = {
  name: string
  body: string
  length: number
  limit: number
  updatedAt: string
}

export type Handoff = {
  sections: HandoffSection[]
  updatedAt: string | null
}

type HandoffRow = {
  name: string
  body: string
  position: number
  updated_at: string
}

export class HandoffRepository {
  private readonly selectAll: StatementSync
  private readonly upsertSection: StatementSync
  private readonly deleteSection: StatementSync
  private readonly selectMax: StatementSync

  constructor(db: DatabaseSync) {
    this.selectAll = db.prepare('SELECT * FROM handoff_sections ORDER BY position ASC')
    this.upsertSection = db.prepare(
      `INSERT INTO handoff_sections (name, body, position, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET body = excluded.body, updated_at = excluded.updated_at`,
    )
    this.deleteSection = db.prepare('DELETE FROM handoff_sections WHERE name = ?')
    this.selectMax = db.prepare('SELECT COALESCE(MAX(position), 0) AS max FROM handoff_sections')
  }

  get(): Handoff {
    const rows = this.selectAll.all() as unknown as HandoffRow[]
    if (rows.length === 0) return { sections: [], updatedAt: null }
    let updatedAt: string | null = null
    for (const row of rows) {
      if (updatedAt === null || row.updated_at > updatedAt) updatedAt = row.updated_at
    }
    return { sections: rows.map(toSection), updatedAt }
  }

  set(name: string, body: string): Handoff {
    const sectionName = assertSectionName(name)
    const trimmed = body.trim()
    if (trimmed === '') {
      this.deleteSection.run(sectionName)
      return this.get()
    }
    assertMaxLength(trimmed, 'section body', MAX_HANDOFF_BODY_LENGTH)
    const position = this.positionOf(sectionName) ?? this.nextPosition()
    this.upsertSection.run(sectionName, trimmed, position, nowIso())
    return this.get()
  }

  append(name: string, text: string): Handoff {
    const sectionName = assertSectionName(name)
    const addition = text.trim()
    if (addition === '') return this.get()
    const existing = this.findRow(sectionName)
    const combined = existing === undefined ? addition : `${existing.body}\n${addition}`
    assertMaxLength(combined, 'section body', MAX_HANDOFF_BODY_LENGTH)
    const position = existing?.position ?? this.nextPosition()
    this.upsertSection.run(sectionName, combined, position, nowIso())
    return this.get()
  }

  private nextPosition(): number {
    const maxRow = this.selectMax.get() as { max: number } | undefined
    return Number(maxRow?.max ?? 0) + 1
  }

  private findRow(name: string): HandoffRow | undefined {
    const rows = this.selectAll.all() as unknown as HandoffRow[]
    return rows.find((row) => row.name === name)
  }

  private positionOf(name: string): number | null {
    return this.findRow(name)?.position ?? null
  }
}

function toSection(row: HandoffRow): HandoffSection {
  return {
    name: row.name,
    body: row.body,
    length: row.body.length,
    limit: MAX_HANDOFF_BODY_LENGTH,
    updatedAt: row.updated_at,
  }
}

function assertSectionName(name: string): string {
  const trimmed = name.trim()
  if (trimmed.length === 0) {
    throw new HarnessError('invalid', 'section name must be a non-empty string')
  }
  if (!HANDOFF_SECTION_PATTERN.test(trimmed)) {
    throw new HarnessError(
      'invalid',
      `section name "${trimmed}" must match ${HANDOFF_SECTION_PATTERN}`,
    )
  }
  return trimmed
}
