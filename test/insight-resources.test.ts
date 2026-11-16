import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Overview, SearchResults } from '../src/store.js'
import { createTestHarness, resourceMarkdown, resourceText, type TestHarness } from './support.js'

let harness: TestHarness

beforeEach(async () => {
  harness = await createTestHarness()
})

afterEach(async () => {
  await harness.dispose()
})

const TOOL_NAMES = [
  'task_next',
  'task_list',
  'task_get',
  'task_create',
  'task_update',
  'task_delete',
  'task_set_deps',
  'session_log_add',
  'session_log_list',
  'decision_append',
  'decision_list',
  'decision_get',
  'handoff_get',
  'handoff_set',
  'plan_list',
  'plan_get',
  'plan_put',
  'plan_delete',
  'plan_export',
  'overview',
  'search',
  'fact_add',
  'fact_get',
  'fact_search',
  'fact_link',
  'fact_unlink',
  'fact_neighbourhood',
  'fact_confirm',
  'fact_health',
  'entity_merge',
  'harness_export',
  'harness_import',
] as const

describe('tool catalogue', () => {
  it('exposes the full protocol surface', async () => {
    const { tools } = await harness.client.listTools()
    const names = tools.map((tool) => tool.name).sort()
    expect(names).toEqual([...TOOL_NAMES].sort())
  })

  it('marks read-only tools and leaves mutators unmarked', async () => {
    const { tools } = await harness.client.listTools()
    const byName = new Map(tools.map((tool) => [tool.name, tool]))
    for (const name of [
      'overview',
      'task_next',
      'task_list',
      'plan_export',
      'search',
      'fact_search',
      'fact_get',
      'fact_neighbourhood',
      'fact_health',
      'harness_export',
    ]) {
      expect(byName.get(name)?.annotations?.readOnlyHint).toBe(true)
    }
    for (const name of [
      'task_create',
      'task_update',
      'decision_append',
      'handoff_set',
      'fact_add',
      'fact_link',
      'fact_confirm',
      'entity_merge',
      'harness_import',
    ]) {
      expect(byName.get(name)?.annotations?.readOnlyHint).toBeUndefined()
    }
  })
})

describe('resources', () => {
  it('expose the overview, board, handoff, decisions, log and plan', async () => {
    const list = await harness.client.listResources()
    const uris = list.resources.map((resource) => resource.uri).sort()
    expect(uris).toEqual(
      [
        'harness://overview',
        'harness://tasks',
        'harness://handoff',
        'harness://decisions',
        'harness://facts',
        'harness://session-log',
        'harness://plan',
      ].sort(),
    )
    expect(await resourceText(harness, 'harness://tasks')).toEqual({ tasks: [] })
    expect(await resourceText(harness, 'harness://overview')).toMatchObject({ tasks: { total: 0 } })
    expect(await resourceText(harness, 'harness://handoff')).toEqual({
      sections: [],
      updatedAt: null,
    })
    expect(await resourceText(harness, 'harness://decisions')).toEqual({ decisions: [] })
    expect(await resourceText(harness, 'harness://facts')).toEqual({ facts: [] })
    expect(await resourceText(harness, 'harness://session-log')).toEqual({ entries: [] })
    expect(await resourceMarkdown(harness, 'harness://plan')).toBe('# Plan\n\nNo sections yet.\n')
  })

  it('expand task template reads including the spec and edges', async () => {
    await harness.ok('task_create', { id: 'T0', title: 'root', spec: 'the seed' })
    await harness.ok('task_create', { id: 'T1', title: 'child' })
    await harness.ok('task_set_deps', { id: 'T1', dependsOn: ['T0'] })
    const list = await harness.client.listResources()
    expect(list.resources.map((resource) => resource.uri)).toContain('harness://tasks/T0')
    const detail = (await resourceText(harness, 'harness://tasks/T1')) as {
      task: { id: string }
      dependsOn: string[]
    }
    expect(detail.task.id).toBe('T1')
    expect(detail.dependsOn).toEqual(['T0'])
    const text = await harness.readResource('harness://tasks/nope').then(
      () => null,
      (error: unknown) => error,
    )
    expect(text).toBeInstanceOf(Error)
  })
})

describe('search', () => {
  beforeEach(async () => {
    await harness.ok('task_create', {
      id: 'T1',
      title: 'notification engine',
      spec: 'long-poll loop; backoff 1s to 30s',
    })
    await harness.ok('task_create', {
      id: 'T2',
      title: 'composer + send flow',
      spec: 'pill composer',
    })
    await harness.ok('decision_append', {
      title: 'engine poll window',
      body: 'gateway kills idle long-polls at ~15 s, so the engine polls with a 10 s window',
      category: 'api-facts',
    })
    await harness.ok('plan_put', {
      id: 'architecture',
      title: 'Architecture',
      content: 'notification engine long-polls; rate queue spaces calls',
    })
    await harness.ok('plan_put', { id: 'scope', title: 'Scope', content: 'text only, no media' })
    await harness.ok('plan_put', { id: 'plain', title: 'Engine notes', content: 'plain body' })
  })

  it('falls back to a plain snippet when the hit is only in the title', async () => {
    const results = (await harness.ok('search', { query: 'engine notes' })) as SearchResults
    expect(results.plan.map((section) => section.id)).toEqual(['plain'])
    const [section] = results.plan
    expect(section?.snippet).toBe('plain body')
  })

  it('finds records across collections', async () => {
    const results = (await harness.ok('search', { query: 'long-poll' })) as SearchResults
    expect(results.tasks.map((task) => task.id)).toEqual(['T1'])
    expect(results.decisions).toHaveLength(1)
    const [decision] = results.decisions
    expect(decision?.ref).toBe('D1')
    expect(results.plan.map((section) => section.id)).toEqual(['architecture'])
    const [section] = results.plan
    expect(section?.snippet).toContain('long-polls')
  })

  it('requires every term and searches specs too', async () => {
    const results = (await harness.ok('search', { query: 'engine backoff' })) as SearchResults
    expect(results.tasks.map((task) => task.id)).toEqual(['T1'])
    const noHit = (await harness.ok('search', { query: 'engine media' })) as SearchResults
    expect(noHit.tasks).toEqual([])
    expect(noHit.decisions).toEqual([])
    expect(noHit.plan).toEqual([])
  })

  it('is case-insensitive and rejects empty queries', async () => {
    const results = (await harness.ok('search', { query: '  PILL  Composer ' })) as SearchResults
    expect(results.tasks.map((task) => task.id)).toEqual(['T2'])
    for (const emptyQuery of ['   ', '']) {
      const text = await harness.err('search', { query: emptyQuery })
      expect(text).toBe('invalid: query must be a non-empty string')
    }
    const overLong = await harness.err('search', { query: 'q'.repeat(121) })
    expect(overLong).toBe('invalid: query must not exceed 120 characters')
  })

  it('respects the per-collection limit', async () => {
    await harness.ok('plan_put', { id: 'later', title: 'Later', content: 'engine notes' })
    const results = (await harness.ok('search', { query: 'engine', limit: 1 })) as SearchResults
    expect(results.tasks).toHaveLength(1)
    expect(results.plan).toHaveLength(1)
    const [section] = results.plan
    expect(section?.id).toBe('architecture')
  })

  it('feeds the overview from the same store', async () => {
    const snapshot = (await harness.ok('overview')) as Overview
    expect(snapshot.plan.sections).toBe(3)
    expect(snapshot.tasks.total).toBe(2)
    const [latest] = snapshot.recentDecisions
    expect(latest?.ref).toBe('D1')
  })
})
