import { HarnessError } from './errors.js'

export const TASK_REF_PATTERN = /^T(\d{1,4})$/
export const DECISION_REF_PATTERN = /^D(\d{1,4})$/
export const FACT_REF_PATTERN = /^F(\d{1,6})$/
export const TASK_ID_PATTERN = /^(T\d{1,4}|[a-z][a-z0-9-]{0,47})$/
export const HANDOFF_SECTION_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9 ./-]{0,47}$/
export const PLAN_SECTION_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/
export const LOG_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/
export const ENTITY_NAME_PATTERN = /^[a-z0-9][a-z0-9 ._/-]{0,119}$/
export const LINK_REL_PATTERN = /^[a-z][a-z0-9-]{0,39}$/
export const NODE_REF_PATTERN = /^(fact|decision|task|plan|entity):(.+)$/

export const MAX_TITLE_LENGTH = 200
export const MAX_SPEC_LENGTH = 20_000
export const MAX_DECISION_TITLE_LENGTH = 160
export const MAX_DECISION_BODY_LENGTH = 8_000
export const MAX_DECISION_CATEGORY_LENGTH = 40
export const MAX_OUTCOME_LENGTH = 300
export const MAX_SESSION_NAME_LENGTH = 80
export const MAX_HANDOFF_BODY_LENGTH = 4_000
export const MAX_SECTION_ID_LENGTH = 64
export const MAX_SECTION_TITLE_LENGTH = 120
export const MAX_SECTION_CONTENT_LENGTH = 50_000
export const MAX_SEARCH_QUERY_LENGTH = 120
export const MAX_FACT_TITLE_LENGTH = 160
export const MAX_FACT_BODY_LENGTH = 8_000
export const MAX_FACT_NOTE_LENGTH = 200
export const MAX_ENTITY_NAME_LENGTH = 120
export const MAX_LINK_REL_LENGTH = 40
export const MAX_NEIGHBOURHOOD_DEPTH = 5
export const MAX_NEIGHBOURHOOD_NODES = 200

export function nowIso(): string {
  return new Date().toISOString()
}

export function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10)
}

export function naturalOrderKey(id: string): number {
  const match = TASK_REF_PATTERN.exec(id)
  return match === null ? Number.MAX_SAFE_INTEGER : Number(match[1])
}

export function compareNatural(a: string, b: string): number {
  const rankDelta = naturalOrderKey(a) - naturalOrderKey(b)
  return rankDelta !== 0 ? rankDelta : a.localeCompare(b)
}

export function nextNumberIn(values: readonly string[], pattern: RegExp, floor = 0): number {
  let greatest = floor
  for (const value of values) {
    const match = pattern.exec(value)
    if (match !== null) {
      const number = Number(match[1])
      if (number > greatest) greatest = number
    }
  }
  return greatest + 1
}

export function truncate(text: string, maxLength: number): string {
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 1).trimEnd()}…`
}

export function assertMaxLength(value: string, label: string, maxLength: number): void {
  if (value.length > maxLength) {
    throw new HarnessError(
      'invalid',
      `${label} is ${value.length} characters; limit ${maxLength} (over by ${value.length - maxLength})`,
    )
  }
}

export function assertString(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new HarnessError('invalid', `${label} must be a non-empty string`)
  }
  const trimmed = value.trim()
  assertMaxLength(trimmed, label, maxLength)
  return trimmed
}

export function matchesAll(haystack: string, needles: readonly string[]): boolean {
  const lowered = haystack.toLowerCase()
  return needles.every((needle) => lowered.includes(needle))
}

export function searchTerms(query: string): string[] {
  return query
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter((term) => term.length > 0)
}

export function ftsMatchQuery(query: string): string {
  const terms = query
    .trim()
    .split(/\s+/)
    .filter((term) => /[a-z0-9]/i.test(term))
    .map((term) => `"${term.replace(/"/g, '""')}"`)
  if (terms.length === 0) {
    throw new HarnessError('invalid', 'query must contain at least one searchable term')
  }
  return terms.join(' OR ')
}
