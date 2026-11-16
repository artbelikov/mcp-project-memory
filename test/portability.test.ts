import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FactSearchHit } from '../src/repositories/facts.js'
import type { HarnessDump } from '../src/repositories/transfer.js'
import { createTestHarness, type TestHarness } from './support.js'

let harness: TestHarness

beforeEach(async () => {
  harness = await createTestHarness()
})

afterEach(async () => {
  await harness.dispose()
})

async function seedStore(): Promise<void> {
  await harness.ok('task_create', { id: 'T1', title: 'root', spec: 'seed spec' })
  await harness.ok('task_create', { id: 'T2', title: 'child' })
  await harness.ok('task_set_deps', { id: 'T2', dependsOn: ['T1'] })
  await harness.ok('decision_append', {
    title: 'seed decision',
    body: 'keep the store append-only',
    category: 'process',
  })
  await harness.ok('session_log_add', {
    date: '2026-11-16',
    session: 'seed',
    outcome: 'seeded everything',
  })
  await harness.ok('handoff_set', { name: 'last-completed', body: 'seeding done' })
  await harness.ok('plan_put', { id: 'scope', title: 'Scope', content: 'the seed plan' })
  await harness.ok('fact_add', {
    kind: 'gotcha',
    title: 'wal checkpoint stalls',
    body: 'checkpoint blocks writers under load',
    links: [{ rel: 'affects', dst: 'entity:storage-layer' }],
  })
  await harness.ok('fact_confirm', { ref: 'F1', note: 're-observed' })
}

async function dump(): Promise<HarnessDump> {
  return (await harness.ok('harness_export')) as HarnessDump
}

describe('harness_export', () => {
  it('returns the full store with a format tag and schema version', async () => {
    await seedStore()
    const result = await dump()
    expect(result.format).toBe('mcp-project-memory')
    expect(result.schemaVersion).toBe(3)
    expect(result.exportedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(result.tasks).toHaveLength(2)
    expect(result.task_deps).toEqual([{ task_id: 'T2', depends_on: 'T1' }])
    expect(result.decisions).toHaveLength(1)
    expect(result.session_log).toHaveLength(1)
    expect(result.handoff_sections).toHaveLength(1)
    expect(result.plan_sections).toHaveLength(1)
    expect(result.facts).toHaveLength(1)
    expect(result.fact_confirmations).toHaveLength(1)
    expect(result.entities.map((entity) => entity.name)).toEqual(['storage-layer'])
    expect(result.links).toHaveLength(1)
  })
})

describe('harness_import', () => {
  it('restores a wiped store with replace mode', async () => {
    await seedStore()
    const result = await dump()

    harness.db.exec('DELETE FROM links')
    harness.db.exec('DELETE FROM fact_confirmations')
    harness.db.exec('DELETE FROM facts')
    harness.db.exec('DELETE FROM entities')
    harness.db.exec('DELETE FROM task_deps')
    harness.db.exec('DELETE FROM plan_sections')
    harness.db.exec('DELETE FROM handoff_sections')
    harness.db.exec('DELETE FROM session_log')
    harness.db.exec('DELETE FROM decisions')
    harness.db.exec('DELETE FROM tasks')
    expect((harness.db.prepare('SELECT COUNT(*) AS n FROM tasks').get() as { n: number }).n).toBe(0)

    const imported = (await harness.ok('harness_import', {
      data: result,
      mode: 'replace',
    })) as { mode: string; inserted: Record<string, number> }
    expect(imported.mode).toBe('replace')
    expect(imported.inserted.tasks).toBe(2)
    expect(imported.inserted.facts).toBe(1)

    const tasks = (await harness.ok('task_list', {})) as { tasks: { id: string }[] }
    expect(tasks.tasks.map((task) => task.id).sort()).toEqual(['T1', 'T2'])
    const next = (await harness.ok('task_next', {})) as { next: { id: string } | null }
    expect(next.next?.id).toBe('T1')
    const detail = (await harness.ok('fact_get', { ref: 'F1' })) as {
      confirmations: unknown[]
      links: unknown[]
    }
    expect(detail.confirmations).toHaveLength(1)
    expect(detail.links).toHaveLength(1)
  })

  it('keeps existing rows in merge mode and skips conflicts', async () => {
    await seedStore()
    const result = await dump()
    await harness.ok('fact_add', {
      kind: 'insight',
      title: 'local addition',
      body: 'added after the export',
    })
    result.facts.push({
      id: 900,
      ref: 'F900',
      kind: 'note',
      title: 'imported note',
      body: 'arrived through the dump',
      origin: 'agent',
      confidence: 1,
      task_id: null,
      supersedes: null,
      valid_from: null,
      valid_to: null,
      created_at: '2026-01-01T00:00:00.000Z',
    })

    const imported = (await harness.ok('harness_import', {
      data: result,
      mode: 'merge',
    })) as { inserted: Record<string, number>; skipped: Record<string, number> }
    expect(imported.inserted.facts).toBe(1)
    expect(imported.skipped.facts).toBe(1)
    expect(imported.skipped.tasks).toBe(2)

    const hits = (await harness.ok('fact_search', { query: 'imported note' })) as {
      facts: FactSearchHit[]
    }
    expect(hits.facts.map((fact) => fact.ref)).toEqual(['F900'])
    expect((harness.db.prepare('SELECT COUNT(*) AS n FROM facts').get() as { n: number }).n).toBe(3)
  })

  it('rejects a foreign format, a mismatched schema version and malformed payloads', async () => {
    await seedStore()
    const result = await dump()

    expect(
      await harness.err('harness_import', {
        data: { ...result, format: 'other' },
        mode: 'replace',
      }),
    ).toContain('Input validation error')

    expect(
      await harness.err('harness_import', {
        data: { ...result, schemaVersion: 999 },
        mode: 'replace',
      }),
    ).toBe('invalid: dump schema version 999 does not match this server (3)')

    expect(
      await harness.err('harness_import', {
        data: { ...result, facts: 'nope' },
        mode: 'replace',
      }),
    ).toContain('Invalid')

    expect(await harness.err('harness_import', { data: result, mode: 'sideways' })).toContain(
      'Invalid',
    )
  })

  it('rolls back the whole import when any row fails', async () => {
    await seedStore()
    const result = await dump()
    result.tasks.push({
      id: 'T-broken',
      title: 'broken row',
      status: null,
      blocked_reason: null,
      spec: '',
      created_at: '2026-11-16T00:00:00.000Z',
      updated_at: '2026-11-16T00:00:00.000Z',
    })

    const error = await harness.err('harness_import', { data: result, mode: 'replace' })
    expect(error).toContain('import failed on table "tasks"')
    expect((harness.db.prepare('SELECT COUNT(*) AS n FROM tasks').get() as { n: number }).n).toBe(2)
    expect((harness.db.prepare('SELECT COUNT(*) AS n FROM facts').get() as { n: number }).n).toBe(1)
  })
})
