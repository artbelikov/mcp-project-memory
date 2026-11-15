import type { DatabaseSync, StatementSync } from 'node:sqlite'
import { HarnessError } from '../errors.js'
import {
  MAX_SECTION_CONTENT_LENGTH,
  MAX_SECTION_TITLE_LENGTH,
  nowIso,
  PLAN_SECTION_ID_PATTERN,
} from '../util.js'

export type PlanSectionSummary = {
  id: string
  title: string
  contentChars: number
  updatedAt: string
}

export type PlanSection = PlanSectionSummary & {
  content: string
  position: number
}

export type PlanPutInput = {
  id: string
  title: string
  content: string
  after?: string
}

type PlanRow = {
  id: string
  title: string
  content: string
  position: number
  updated_at: string
}

export class PlanRepository {
  private readonly upsertSection: StatementSync
  private readonly upsertSectionPosition: StatementSync
  private readonly selectAll: StatementSync
  private readonly selectById: StatementSync
  private readonly deleteSection: StatementSync

  constructor(db: DatabaseSync) {
    this.upsertSection = db.prepare(
      `INSERT INTO plan_sections (id, title, content, position, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET title = excluded.title, content = excluded.content, updated_at = excluded.updated_at`,
    )
    this.upsertSectionPosition = db.prepare(
      `INSERT INTO plan_sections (id, title, content, position, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET title = excluded.title, content = excluded.content, position = excluded.position, updated_at = excluded.updated_at`,
    )
    this.selectAll = db.prepare('SELECT * FROM plan_sections ORDER BY position ASC')
    this.selectById = db.prepare('SELECT * FROM plan_sections WHERE id = ?')
    this.deleteSection = db.prepare('DELETE FROM plan_sections WHERE id = ?')
  }

  put(input: PlanPutInput): PlanSection {
    const id = assertSectionId(input.id)
    const title = assertString(input.title, 'title', MAX_SECTION_TITLE_LENGTH)
    if (input.content.length > MAX_SECTION_CONTENT_LENGTH) {
      throw new HarnessError(
        'invalid',
        `content must not exceed ${MAX_SECTION_CONTENT_LENGTH} characters`,
      )
    }
    const existing = this.selectById.get(id)
    const at = nowIso()
    if (existing !== undefined) {
      this.upsertSection.run(id, title, input.content, 0, at)
      return this.get(id)
    }
    const position = this.resolvePosition(input.after)
    this.upsertSectionPosition.run(id, title, input.content, position, at)
    return this.get(id)
  }

  get(id: string): PlanSection {
    const row = this.selectById.get(id)
    if (row === undefined) {
      throw new HarnessError('not-found', `plan section "${id}" does not exist`)
    }
    return toSection(row as unknown as PlanRow)
  }

  list(): PlanSectionSummary[] {
    const rows = this.selectAll.all() as unknown as PlanRow[]
    return rows.map((row) => {
      const section = toSection(row)
      return {
        id: section.id,
        title: section.title,
        contentChars: section.content.length,
        updatedAt: section.updatedAt,
      }
    })
  }

  delete(id: string): { id: string } {
    this.get(id)
    this.deleteSection.run(id)
    return { id }
  }

  export(): string {
    const rows = this.selectAll.all() as unknown as PlanRow[]
    if (rows.length === 0) return '# Plan\n\nNo sections yet.\n'
    const body = rows.map((row) => `## ${row.title}\n\n${row.content.trim()}\n`).join('\n')
    return `# Plan\n\n${body}`
  }

  private resolvePosition(afterId: string | undefined): number {
    const rows = this.selectAll.all() as unknown as PlanRow[]
    if (afterId === undefined) {
      const maxPosition = rows.reduce((max, row) => Math.max(max, row.position), 0)
      return maxPosition + 1
    }
    const after = this.selectById.get(afterId)
    if (after === undefined) {
      throw new HarnessError('not-found', `plan section "${afterId}" does not exist`)
    }
    const afterRow = after as unknown as PlanRow
    const nextRow = rows.find((row) => row.position > afterRow.position)
    return nextRow === undefined
      ? afterRow.position + 1
      : (afterRow.position + nextRow.position) / 2
  }
}

function toSection(row: PlanRow): PlanSection {
  return {
    id: row.id,
    title: row.title,
    content: row.content,
    position: row.position,
    contentChars: row.content.length,
    updatedAt: row.updated_at,
  }
}

function assertSectionId(id: string): string {
  const trimmed = id.trim()
  if (!PLAN_SECTION_ID_PATTERN.test(trimmed)) {
    throw new HarnessError(
      'invalid',
      `plan section id "${trimmed}" must match ${PLAN_SECTION_ID_PATTERN}`,
    )
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
