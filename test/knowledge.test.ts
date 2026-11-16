import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Fact, FactSearchHit } from '../src/repositories/facts.js'
import type { Neighbourhood } from '../src/repositories/graph.js'
import type { Overview, SearchResults } from '../src/store.js'
import { createTestHarness, type TestHarness } from './support.js'

let harness: TestHarness

beforeEach(async () => {
  harness = await createTestHarness()
})

afterEach(async () => {
  await harness.dispose()
})

async function addFact(overrides: Record<string, unknown> = {}): Promise<Fact> {
  const result = (await harness.ok('fact_add', {
    kind: 'gotcha',
    title: 'gateway kills idle long-polls',
    body: 'the upstream gateway terminates idle long polling connections at about fifteen seconds so the client must heartbeat below that window',
    ...overrides,
  })) as { fact: Fact }
  return result.fact
}

describe('fact_add', () => {
  it('allocates immutable F-refs and defaults origin to agent', async () => {
    const first = await addFact()
    const second = await addFact({ title: 'another quirk', body: 'unrelated body text' })
    expect(first.ref).toBe('F1')
    expect(second.ref).toBe('F2')
    expect(first.origin).toBe('agent')
    expect(first.confidence).toBe(1)
    expect(first.kind).toBe('gotcha')
  })

  it('records provenance, confidence, validity and task link', async () => {
    await harness.ok('task_create', { id: 'T0', title: 'root' })
    const fact = await addFact({
      origin: 'user',
      confidence: 0.5,
      taskId: 'T0',
      validFrom: '2026-01-01',
      validTo: '2026-12-31',
    })
    expect(fact.origin).toBe('user')
    expect(fact.confidence).toBe(0.5)
    expect(fact.taskId).toBe('T0')
    expect(fact.validFrom).toBe('2026-01-01')
    expect(fact.validTo).toBe('2026-12-31')
  })

  it('attaches inline links atomically and auto-creates entities', async () => {
    await harness.ok('task_create', { id: 'T3', title: 'storage work' })
    const result = (await harness.ok('fact_add', {
      kind: 'api-fact',
      title: 'wal checkpoint stalls',
      body: 'checkpoint blocks writers under load',
      links: [
        { rel: 'affects', dst: 'entity:storage-layer' },
        { rel: 'discovered-in', dst: 'task:T3' },
      ],
    })) as { fact: Fact }
    const detail = (await harness.ok('fact_get', { ref: result.fact.ref })) as {
      links: { src: string; rel: string; dst: string }[]
    }
    expect(detail.links).toHaveLength(2)
    expect(detail.links.map((link) => link.dst).sort()).toEqual(['entity:storage-layer', 'task:T3'])
  })

  it('warns about similar existing facts instead of silently duplicating', async () => {
    await addFact()
    const result = (await harness.ok('fact_add', {
      kind: 'gotcha',
      title: 'gateway kills idle long polls',
      body: 'the gateway terminates idle long polling connections near fifteen seconds',
    })) as { fact: Fact; similar: { ref: string }[] }
    expect(result.similar.map((entry) => entry.ref)).toContain('F1')
    expect(result.fact.ref).toBe('F2')
  })

  it('supersedes an older fact by reference without editing history', async () => {
    const old = await addFact()
    const newer = await addFact({
      title: 'gateway idle window is twenty seconds',
      body: 'measured again: the gateway actually allows twenty seconds idle',
      supersedes: old.ref,
    })
    expect(newer.supersedes).toBe(old.ref)
    const fetched = (await harness.ok('fact_get', { ref: old.ref })) as { fact: Fact }
    expect(fetched.fact.title).toBe(old.title)
  })

  it('rejects invalid input', async () => {
    expect(await harness.err('fact_add', { kind: 'bogus', title: 't', body: 'b' })).toContain(
      'Invalid option',
    )
    expect(await harness.err('fact_add', { kind: 'note', title: '  ', body: 'b' })).toBe(
      'invalid: title must be a non-empty string',
    )
    expect(
      await harness.err('fact_add', { kind: 'note', title: 't', body: 'b', confidence: 2 }),
    ).toContain('Too big')
    expect(
      await harness.err('fact_add', { kind: 'note', title: 't', body: 'b', validFrom: 'nope' }),
    ).toBe('invalid: validFrom must be an ISO date (YYYY-MM-DD)')
    expect(
      await harness.err('fact_add', { kind: 'note', title: 't', body: 'b', taskId: 'T999' }),
    ).toBe('not-found: task "T999" does not exist')
    expect(
      await harness.err('fact_add', { kind: 'note', title: 't', body: 'b', supersedes: 'F999' }),
    ).toBe('not-found: fact "F999" does not exist')
  })
})

describe('fact_search', () => {
  it('recalls by stem and paraphrase where substring search fails', async () => {
    await harness.ok('fact_add', {
      kind: 'api-fact',
      title: 'engine poll cadence',
      body: 'the engine polls the queue every ten seconds',
    })
    const byStem = (await harness.ok('fact_search', { query: 'polling' })) as {
      facts: FactSearchHit[]
    }
    expect(byStem.facts.map((fact) => fact.ref)).toEqual(['F1'])
    expect(byStem.facts[0]?.snippet).toContain('[polls]')
    const substring = (await harness.ok('search', { query: 'polling' })) as SearchResults
    expect(substring.tasks).toEqual([])
    expect(substring.facts.map((fact) => fact.ref)).toEqual(['F1'])
  })

  it('ranks user-stated facts above agent inferences of equal relevance', async () => {
    await addFact({
      title: 'timeout window',
      body: 'the timeout window is fifteen seconds',
      origin: 'agent',
    })
    await addFact({
      title: 'timeout window',
      body: 'the timeout window is fifteen seconds',
      origin: 'user',
    })
    const hits = (await harness.ok('fact_search', { query: 'timeout window' })) as {
      facts: FactSearchHit[]
    }
    expect(hits.facts[0]?.origin).toBe('user')
    expect(hits.facts[0]?.rank).toBeLessThan(hits.facts[1]?.rank ?? 0)
  })

  it('filters by kind, origin, task and entity', async () => {
    await harness.ok('task_create', { id: 'T0', title: 'root' })
    await addFact({
      kind: 'gotcha',
      taskId: 'T0',
      links: [{ rel: 'affects', dst: 'entity:storage-layer' }],
    })
    await addFact({
      kind: 'insight',
      title: 'unrelated insight',
      body: 'a different observation entirely',
    })
    const byKind = (await harness.ok('fact_search', { kind: 'insight' })) as { facts: Fact[] }
    expect(byKind.facts.map((fact) => fact.ref)).toEqual(['F2'])
    const byTask = (await harness.ok('fact_search', { taskId: 'T0' })) as { facts: Fact[] }
    expect(byTask.facts.map((fact) => fact.ref)).toEqual(['F1'])
    const byEntity = (await harness.ok('fact_search', { entity: 'storage-layer' })) as {
      facts: Fact[]
    }
    expect(byEntity.facts.map((fact) => fact.ref)).toEqual(['F1'])
    const byOrigin = (await harness.ok('fact_search', { origin: 'user' })) as { facts: Fact[] }
    expect(byOrigin.facts).toEqual([])
  })

  it('hides superseded and expired facts unless asked', async () => {
    const old = await addFact({ title: 'window fifteen', body: 'the window is fifteen seconds' })
    await addFact({
      title: 'window twenty',
      body: 'the window is twenty seconds',
      supersedes: old.ref,
    })
    await addFact({
      title: 'expired window',
      body: 'the window was thirty seconds',
      validTo: '2020-01-01',
    })
    const current = (await harness.ok('fact_search', { query: 'window' })) as { facts: Fact[] }
    expect(current.facts.map((fact) => fact.ref)).toEqual(['F2'])
    const all = (await harness.ok('fact_search', { query: 'window', includeSuperseded: true })) as {
      facts: Fact[]
    }
    expect(all.facts.map((fact) => fact.ref).sort()).toEqual(['F1', 'F2'])
  })

  it('lists recent facts when no query is given and validates limit', async () => {
    await addFact()
    await addFact({ title: 'second', body: 'second body' })
    const recent = (await harness.ok('fact_search', {})) as { facts: Fact[] }
    expect(recent.facts.map((fact) => fact.ref)).toEqual(['F2', 'F1'])
    expect(await harness.err('fact_search', { limit: 0 })).toContain('Too small')
  })
})

describe('graph links and neighbourhood', () => {
  it('links typed nodes idempotently and unlinks', async () => {
    const fact = await addFact()
    await harness.ok('task_create', { id: 'T0', title: 'root' })
    const first = (await harness.ok('fact_link', {
      src: `fact:${fact.ref}`,
      rel: 'discovered-in',
      dst: 'task:T0',
    })) as { created: boolean }
    expect(first.created).toBe(true)
    const again = (await harness.ok('fact_link', {
      src: `fact:${fact.ref}`,
      rel: 'discovered-in',
      dst: 'task:T0',
    })) as { created: boolean }
    expect(again.created).toBe(false)
    const removed = (await harness.ok('fact_unlink', {
      src: `fact:${fact.ref}`,
      rel: 'discovered-in',
      dst: 'task:T0',
    })) as { removed: number }
    expect(removed.removed).toBe(1)
  })

  it('rejects self-links, unknown nodes and malformed refs/rels', async () => {
    const fact = await addFact()
    expect(
      await harness.err('fact_link', {
        src: `fact:${fact.ref}`,
        rel: 'relates-to',
        dst: `fact:${fact.ref}`,
      }),
    ).toBe('invalid: a node cannot link to itself')
    expect(
      await harness.err('fact_link', { src: `fact:${fact.ref}`, rel: 'affects', dst: 'task:T999' }),
    ).toBe('not-found: task "T999" does not exist')
    expect(
      await harness.err('fact_link', { src: 'bogus:x', rel: 'affects', dst: 'entity:y' }),
    ).toContain('invalid: node ref')
    expect(
      await harness.err('fact_link', { src: `fact:${fact.ref}`, rel: 'Bad Rel!', dst: 'entity:y' }),
    ).toContain('invalid: rel')
  })

  it('walks the neighbourhood from a component to everything known about it', async () => {
    await harness.ok('task_create', { id: 'T0', title: 'storage work' })
    await harness.ok('decision_append', {
      title: 'use wal',
      body: 'wal mode chosen',
      category: 'architecture',
    })
    const fact = await addFact({ links: [{ rel: 'affects', dst: 'entity:storage-layer' }] })
    await harness.ok('fact_link', { src: 'decision:D1', rel: 'about', dst: 'entity:storage-layer' })
    await harness.ok('fact_link', {
      src: 'task:T0',
      rel: 'implements',
      dst: 'entity:storage-layer',
    })
    const hood = (await harness.ok('fact_neighbourhood', {
      start: 'entity:storage-layer',
      depth: 1,
    })) as Neighbourhood
    const refs = hood.nodes.map((node) => node.ref).sort()
    expect(refs).toEqual(
      [`fact:${fact.ref}`, 'decision:D1', 'entity:storage-layer', 'task:T0'].sort(),
    )
    expect(hood.edges).toHaveLength(3)
    const factNode = hood.nodes.find((node) => node.ref === `fact:${fact.ref}`)
    expect(factNode?.label).toBe(fact.title)
  })

  it('respects direction and depth and survives cycles', async () => {
    const a = await addFact({ title: 'alpha', body: 'alpha body' })
    const b = await addFact({ title: 'beta', body: 'beta body' })
    await harness.ok('fact_link', { src: `fact:${a.ref}`, rel: 'relates-to', dst: `fact:${b.ref}` })
    await harness.ok('fact_link', { src: `fact:${b.ref}`, rel: 'relates-to', dst: `fact:${a.ref}` })
    const out = (await harness.ok('fact_neighbourhood', {
      start: `fact:${a.ref}`,
      direction: 'out',
      depth: 1,
    })) as Neighbourhood
    expect(out.nodes.map((node) => node.ref).sort()).toEqual(
      [`fact:${a.ref}`, `fact:${b.ref}`].sort(),
    )
    const cyclic = (await harness.ok('fact_neighbourhood', {
      start: `fact:${a.ref}`,
      depth: 5,
    })) as Neighbourhood
    expect(cyclic.nodes).toHaveLength(2)
    expect(await harness.err('fact_neighbourhood', { start: `fact:${a.ref}`, depth: 9 })).toContain(
      'Too big',
    )
  })

  it('cleans up links and taskId when a task or plan section is deleted', async () => {
    await harness.ok('task_create', { id: 'T0', title: 'root' })
    await harness.ok('plan_put', { id: 'scope', title: 'Scope', content: 'text' })
    const fact = await addFact({
      taskId: 'T0',
      links: [
        { rel: 'discovered-in', dst: 'task:T0' },
        { rel: 'about', dst: 'plan:scope' },
      ],
    })
    await harness.ok('task_delete', { id: 'T0' })
    await harness.ok('plan_delete', { id: 'scope' })
    const detail = (await harness.ok('fact_get', { ref: fact.ref })) as {
      fact: Fact
      links: unknown[]
    }
    expect(detail.links).toEqual([])
    expect(detail.fact.taskId).toBeNull()
  })
})

describe('overview and search integration', () => {
  it('summarizes the knowledge base in the overview', async () => {
    await addFact({ kind: 'gotcha' })
    await addFact({ kind: 'insight', title: 'insight', body: 'insight body' })
    const snapshot = (await harness.ok('overview')) as Overview
    expect(snapshot.facts.total).toBe(2)
    expect(snapshot.facts.byKind.gotcha).toBe(1)
    expect(snapshot.facts.byKind.insight).toBe(1)
    expect(snapshot.facts.recent[0]?.ref).toBe('F2')
  })

  it('exposes facts through the resource and the unified search', async () => {
    await addFact()
    const resource = (await harness.readResource('harness://facts').then((result) => {
      const block = result.contents.at(0) as { text?: string }
      return JSON.parse(block.text ?? '{}')
    })) as { facts: Fact[] }
    expect(resource.facts.map((fact) => fact.ref)).toEqual(['F1'])
    const results = (await harness.ok('search', { query: 'gateway' })) as SearchResults
    expect(results.facts.map((fact) => fact.ref)).toEqual(['F1'])
  })
})
