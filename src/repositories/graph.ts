import type { DatabaseSync } from 'node:sqlite'
import { withTransaction } from '../db/database.js'
import { HarnessError } from '../errors.js'
import {
  ENTITY_NAME_PATTERN,
  LINK_REL_PATTERN,
  MAX_ENTITY_NAME_LENGTH,
  MAX_LINK_REL_LENGTH,
  MAX_NEIGHBOURHOOD_DEPTH,
  MAX_NEIGHBOURHOOD_NODES,
  NODE_REF_PATTERN,
  nowIso,
} from '../util.js'

export const NODE_KINDS = ['fact', 'decision', 'task', 'plan', 'entity'] as const
export type NodeKind = (typeof NODE_KINDS)[number]
export const TRAVERSAL_DIRECTIONS = ['both', 'out', 'in'] as const
export type TraversalDirection = (typeof TRAVERSAL_DIRECTIONS)[number]

export type NodeRef = { kind: NodeKind; id: string }

export type Link = {
  src: string
  rel: string
  dst: string
  createdAt: string
}

export type NeighbourhoodNode = {
  ref: string
  kind: NodeKind
  id: string
  label: string
  depth: number
}

export type Neighbourhood = {
  start: string
  direction: TraversalDirection
  depth: number
  nodes: NeighbourhoodNode[]
  edges: Link[]
}

type LinkRow = {
  src_kind: string
  src_id: string
  rel: string
  dst_kind: string
  dst_id: string
  created_at: string
}

export function parseNodeRef(raw: string): NodeRef {
  const match = NODE_REF_PATTERN.exec(raw.trim())
  if (match === null) {
    throw new HarnessError(
      'invalid',
      `node ref "${raw}" must be kind:id (fact|decision|task|plan|entity)`,
    )
  }
  const kind = match[1] as NodeKind
  const id = kind === 'entity' ? normalizeEntityName(match[2] ?? '') : (match[2] ?? '').trim()
  if (id.length === 0) {
    throw new HarnessError('invalid', `node ref "${raw}" has an empty id`)
  }
  return { kind, id }
}

export function nodeRefString(ref: NodeRef): string {
  return `${ref.kind}:${ref.id}`
}

function normalizeEntityName(name: string): string {
  const normalized = name.trim().toLowerCase()
  if (normalized.length === 0 || normalized.length > MAX_ENTITY_NAME_LENGTH) {
    throw new HarnessError('invalid', `entity name must be 1-${MAX_ENTITY_NAME_LENGTH} characters`)
  }
  if (!ENTITY_NAME_PATTERN.test(normalized)) {
    throw new HarnessError(
      'invalid',
      `entity name "${normalized}" must match ${ENTITY_NAME_PATTERN}`,
    )
  }
  return normalized
}

function assertSlug(value: string, label: string): string {
  const trimmed = value.trim().toLowerCase()
  if (trimmed.length === 0 || trimmed.length > MAX_LINK_REL_LENGTH) {
    throw new HarnessError('invalid', `${label} must be 1-${MAX_LINK_REL_LENGTH} characters`)
  }
  if (!LINK_REL_PATTERN.test(trimmed)) {
    throw new HarnessError('invalid', `${label} "${trimmed}" must match ${LINK_REL_PATTERN}`)
  }
  return trimmed
}

function assertRel(rel: string): string {
  return assertSlug(rel, 'rel')
}

export class GraphRepository {
  constructor(private readonly db: DatabaseSync) {}

  ensureEntity(name: string, kind = 'concept'): { name: string; kind: string } {
    const normalized = normalizeEntityName(name)
    const entityKind = assertSlug(kind, 'entity kind')
    this.db
      .prepare(
        `INSERT INTO entities (name, kind, created_at) VALUES (?, ?, ?)
         ON CONFLICT(name) DO NOTHING`,
      )
      .run(normalized, entityKind, nowIso())
    return { name: normalized, kind: entityKind }
  }

  link(srcRaw: string, rel: string, dstRaw: string): Link & { created: boolean } {
    const src = parseNodeRef(srcRaw)
    const dst = parseNodeRef(dstRaw)
    const relation = assertRel(rel)
    if (src.kind === dst.kind && src.id === dst.id) {
      throw new HarnessError('invalid', 'a node cannot link to itself')
    }
    this.assertNodeExists(src)
    this.assertNodeExists(dst)
    const at = nowIso()
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO links (src_kind, src_id, rel, dst_kind, dst_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(src.kind, src.id, relation, dst.kind, dst.id, at)
    return {
      src: nodeRefString(src),
      rel: relation,
      dst: nodeRefString(dst),
      createdAt: at,
      created: result.changes > 0,
    }
  }

  unlink(srcRaw: string, rel: string, dstRaw: string): { removed: number } {
    const src = parseNodeRef(srcRaw)
    const dst = parseNodeRef(dstRaw)
    const relation = assertRel(rel)
    const result = this.db
      .prepare(
        `DELETE FROM links
         WHERE src_kind = ? AND src_id = ? AND rel = ? AND dst_kind = ? AND dst_id = ?`,
      )
      .run(src.kind, src.id, relation, dst.kind, dst.id)
    return { removed: Number(result.changes) }
  }

  mergeEntities(fromRaw: string, toRaw: string): { from: string; to: string; relinked: number } {
    const from = parseNodeRef(fromRaw)
    const to = parseNodeRef(toRaw)
    if (from.kind !== 'entity' || to.kind !== 'entity') {
      throw new HarnessError('invalid', 'entity merge requires two entity refs (entity:name)')
    }
    if (from.id === to.id) {
      throw new HarnessError('invalid', 'cannot merge an entity into itself')
    }
    if (!this.entityExists(from.id)) {
      throw new HarnessError('not-found', `entity "${from.id}" does not exist`)
    }
    if (!this.entityExists(to.id)) {
      throw new HarnessError('not-found', `entity "${to.id}" does not exist`)
    }
    return withTransaction(this.db, () => {
      const rows = this.db
        .prepare(
          `SELECT * FROM links
           WHERE (src_kind = 'entity' AND src_id = ?) OR (dst_kind = 'entity' AND dst_id = ?)`,
        )
        .all(from.id, from.id) as unknown as LinkRow[]
      for (const row of rows) {
        const srcId = row.src_kind === 'entity' && row.src_id === from.id ? to.id : row.src_id
        const dstId = row.dst_kind === 'entity' && row.dst_id === from.id ? to.id : row.dst_id
        if (`${row.src_kind}:${srcId}` !== `${row.dst_kind}:${dstId}`) {
          this.db
            .prepare(
              `INSERT OR IGNORE INTO links (src_kind, src_id, rel, dst_kind, dst_id, created_at)
               VALUES (?, ?, ?, ?, ?, ?)`,
            )
            .run(row.src_kind, srcId, row.rel, row.dst_kind, dstId, row.created_at)
        }
        this.db
          .prepare(
            `DELETE FROM links
             WHERE src_kind = ? AND src_id = ? AND rel = ? AND dst_kind = ? AND dst_id = ?`,
          )
          .run(row.src_kind, row.src_id, row.rel, row.dst_kind, row.dst_id)
      }
      this.db.prepare('DELETE FROM entities WHERE name = ?').run(from.id)
      return { from: nodeRefString(from), to: nodeRefString(to), relinked: rows.length }
    })
  }

  private entityExists(name: string): boolean {
    return this.db.prepare('SELECT 1 FROM entities WHERE name = ?').get(name) !== undefined
  }

  linksFor(nodeRaw: string): Link[] {
    const node = parseNodeRef(nodeRaw)
    const rows = this.db
      .prepare(
        `SELECT * FROM links
         WHERE (src_kind = ? AND src_id = ?) OR (dst_kind = ? AND dst_id = ?)
         ORDER BY created_at ASC`,
      )
      .all(node.kind, node.id, node.kind, node.id) as unknown as LinkRow[]
    return rows.map(toLink)
  }

  neighbourhood(
    startRaw: string,
    depth = 2,
    direction: TraversalDirection = 'both',
  ): Neighbourhood {
    const start = parseNodeRef(startRaw)
    this.assertNodeExists(start)
    const hops = clampDepth(depth)
    const rows = this.db.prepare(walkSql(hops, direction)).all(start.kind, start.id) as unknown as {
      kind: NodeKind
      id: string
      depth: number
    }[]
    const labels = this.resolveLabels(rows)
    const nodes: NeighbourhoodNode[] = rows.map((row) => ({
      ref: `${row.kind}:${row.id}`,
      kind: row.kind,
      id: row.id,
      label: labels.get(`${row.kind}:${row.id}`) ?? row.id,
      depth: row.depth,
    }))
    const edges = this.edgesAmong(nodes)
    return { start: nodeRefString(start), direction, depth: hops, nodes, edges }
  }

  private assertNodeExists(ref: NodeRef): void {
    if (ref.kind === 'entity') {
      this.ensureEntity(ref.id)
      return
    }
    const table =
      ref.kind === 'fact'
        ? 'facts'
        : ref.kind === 'decision'
          ? 'decisions'
          : ref.kind === 'task'
            ? 'tasks'
            : 'plan_sections'
    const column = ref.kind === 'fact' || ref.kind === 'decision' ? 'ref' : 'id'
    const found = this.db.prepare(`SELECT 1 FROM ${table} WHERE ${column} = ?`).get(ref.id)
    if (found === undefined) {
      throw new HarnessError('not-found', `${ref.kind} "${ref.id}" does not exist`)
    }
  }

  private resolveLabels(rows: readonly { kind: NodeKind; id: string }[]): Map<string, string> {
    const labels = new Map<string, string>()
    const byKind = new Map<NodeKind, string[]>()
    for (const row of rows) {
      const acc = byKind.get(row.kind) ?? []
      acc.push(row.id)
      byKind.set(row.kind, acc)
    }
    for (const [kind, ids] of byKind) {
      const placeholders = ids.map(() => '?').join(', ')
      const query =
        kind === 'entity'
          ? `SELECT name AS id, name AS label FROM entities WHERE name IN (${placeholders})`
          : kind === 'fact'
            ? `SELECT ref AS id, title AS label FROM facts WHERE ref IN (${placeholders})`
            : kind === 'decision'
              ? `SELECT ref AS id, title AS label FROM decisions WHERE ref IN (${placeholders})`
              : kind === 'task'
                ? `SELECT id, title AS label FROM tasks WHERE id IN (${placeholders})`
                : `SELECT id, title AS label FROM plan_sections WHERE id IN (${placeholders})`
      const found = this.db.prepare(query).all(...ids) as unknown as {
        id: string
        label: string
      }[]
      for (const row of found) labels.set(`${kind}:${row.id}`, row.label)
    }
    return labels
  }

  private edgesAmong(nodes: readonly NeighbourhoodNode[]): Link[] {
    if (nodes.length === 0) return []
    const keys = nodes.map((node) => node.ref)
    const inSet = new Set(keys)
    const placeholders = keys.map(() => '?').join(', ')
    const rows = this.db
      .prepare(
        `SELECT * FROM links
         WHERE (src_kind || ':' || src_id) IN (${placeholders})
            OR (dst_kind || ':' || dst_id) IN (${placeholders})`,
      )
      .all(...keys, ...keys) as unknown as LinkRow[]
    return rows.map(toLink).filter((link) => inSet.has(link.src) && inSet.has(link.dst))
  }
}

function clampDepth(depth: number): number {
  if (!Number.isInteger(depth) || depth < 1 || depth > MAX_NEIGHBOURHOOD_DEPTH) {
    throw new HarnessError('invalid', `depth must be an integer 1-${MAX_NEIGHBOURHOOD_DEPTH}`)
  }
  return depth
}

function walkSql(depth: number, direction: TraversalDirection): string {
  const out = `SELECT l.dst_kind, l.dst_id, w.depth + 1 FROM links l
    JOIN walk w ON l.src_kind = w.kind AND l.src_id = w.id WHERE w.depth < ${depth}`
  const inbound = `SELECT l.src_kind, l.src_id, w.depth + 1 FROM links l
    JOIN walk w ON l.dst_kind = w.kind AND l.dst_id = w.id WHERE w.depth < ${depth}`
  const branches = direction === 'out' ? [out] : direction === 'in' ? [inbound] : [out, inbound]
  return `WITH RECURSIVE walk(kind, id, depth) AS (
    SELECT ?, ?, 0
    UNION
    ${branches.join('\n    UNION\n    ')}
  )
  SELECT kind, id, MIN(depth) AS depth FROM walk
  GROUP BY kind, id ORDER BY depth, kind, id LIMIT ${MAX_NEIGHBOURHOOD_NODES}`
}

function toLink(row: LinkRow): Link {
  return {
    src: `${row.src_kind}:${row.src_id}`,
    rel: row.rel,
    dst: `${row.dst_kind}:${row.dst_id}`,
    createdAt: row.created_at,
  }
}
