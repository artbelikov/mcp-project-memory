import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Fact, FactHealth, FactSearchHit } from '../src/repositories/facts.js'
import type { Neighbourhood } from '../src/repositories/graph.js'
import type { Overview, SearchResults } from '../src/store.js'
import { createTestHarness, resourceText, type TestHarness } from './support.js'

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

describe('fact_confirm', () => {
  it('re-stamps a fact without editing its content', async () => {
    const fact = await addFact()
    const first = (await harness.ok('fact_confirm', {
      ref: fact.ref,
      note: 're-probed live',
    })) as { ref: string; confirmedAt: string; note: string | null; confirmations: number }
    expect(first.ref).toBe('F1')
    expect(first.note).toBe('re-probed live')
    expect(first.confirmations).toBe(1)
    expect(first.confirmedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)

    await harness.ok('fact_confirm', { ref: fact.ref })
    const detail = (await harness.ok('fact_get', { ref: fact.ref })) as {
      fact: Fact
      confirmations: { confirmedAt: string; note: string | null }[]
      lastConfirmedAt: string | null
    }
    expect(detail.confirmations).toHaveLength(2)
    expect(detail.confirmations.at(-1)?.note).toBeNull()
    expect(detail.lastConfirmedAt).toBe(detail.confirmations.at(-1)?.confirmedAt)
    expect(detail.fact.title).toBe(fact.title)
    expect(detail.fact.createdAt).toBe(fact.createdAt)
  })

  it('validates the ref and the note', async () => {
    expect(await harness.err('fact_confirm', { ref: 'F99' })).toBe(
      'not-found: fact "F99" does not exist',
    )
    const fact = await addFact()
    expect(await harness.err('fact_confirm', { ref: fact.ref, note: 'n'.repeat(201) })).toContain(
      'note must not exceed 200 characters',
    )
  })
})

describe('fact_health', () => {
  it('flags orphans, duplicate pairs, unused entities and stale facts', async () => {
    const orphan = await addFact({ title: 'lonely observation', body: 'this fact touches nothing' })
    const linked = await addFact({
      title: 'wired observation',
      body: 'this fact is linked to a component',
      links: [{ rel: 'affects', dst: 'entity:storage' }],
    })
    await addFact({ title: 'checkpoint stalls under load', body: 'wal checkpoint blocks writers' })
    await addFact({ title: 'checkpoint stalls under load', body: 'wal checkpoint blocks writers' })
    await harness.ok('fact_link', {
      src: `fact:${linked.ref}`,
      rel: 'about',
      dst: 'entity:temp-node',
    })
    await harness.ok('fact_unlink', {
      src: `fact:${linked.ref}`,
      rel: 'about',
      dst: 'entity:temp-node',
    })
    harness.db.exec(
      `UPDATE facts SET created_at = '2020-01-01T00:00:00.000Z' WHERE ref = '${orphan.ref}'`,
    )

    const health = (await harness.ok('fact_health')) as FactHealth
    expect(health.orphanFacts.map((entry) => entry.ref)).toContain(orphan.ref)
    expect(health.orphanFacts.map((entry) => entry.ref)).not.toContain(linked.ref)
    const duplicateRefs = health.duplicatePairs.flatMap((pair) => [pair.a, pair.b])
    expect(duplicateRefs).toContain('F3')
    expect(duplicateRefs).toContain('F4')
    expect(health.unusedEntities).toContain('temp-node')
    expect(health.unusedEntities).not.toContain('storage')
    expect(health.staleFacts.map((entry) => entry.ref)).toEqual([orphan.ref])
    expect(health.staleFacts[0]?.daysSince).toBeGreaterThan(90)
    expect(health.counts.orphanFacts).toBe(3)
    expect(health.counts.duplicatePairs).toBeGreaterThanOrEqual(1)
    expect(health.counts.unusedEntities).toBe(1)
    expect(health.counts.staleFacts).toBe(1)
  })

  it('drops a fact from staleness once it is re-confirmed', async () => {
    const fact = await addFact({ title: 'old quirk', body: 'recorded long ago' })
    harness.db.exec(
      `UPDATE facts SET created_at = '2020-01-01T00:00:00.000Z' WHERE ref = '${fact.ref}'`,
    )
    const before = (await harness.ok('fact_health')) as FactHealth
    expect(before.staleFacts.map((entry) => entry.ref)).toContain(fact.ref)
    await harness.ok('fact_confirm', { ref: fact.ref })
    const after = (await harness.ok('fact_health')) as FactHealth
    expect(after.staleFacts.map((entry) => entry.ref)).not.toContain(fact.ref)
    expect(after.counts.staleFacts).toBe(0)
  })

  it('surfaces health counts in the overview', async () => {
    const snapshot = (await harness.ok('overview')) as Overview
    expect(snapshot.facts.health).toEqual({
      orphanFacts: 0,
      duplicatePairs: 0,
      unusedEntities: 0,
      staleFacts: 0,
    })
  })
})

describe('entity_merge', () => {
  it('moves every link to the surviving entity and deletes the source', async () => {
    await harness.ok('task_create', { id: 'T0', title: 'storage work' })
    await harness.ok('decision_append', {
      title: 'use wal',
      body: 'wal mode chosen',
      category: 'architecture',
    })
    const fact = await addFact({ links: [{ rel: 'affects', dst: 'entity:storage' }] })
    await harness.ok('fact_link', { src: 'decision:D1', rel: 'about', dst: 'entity:storage' })
    await harness.ok('fact_link', { src: 'task:T0', rel: 'implements', dst: 'entity:storage' })
    const other = await addFact({
      title: 'second component fact',
      body: 'about the other component',
      links: [{ rel: 'affects', dst: 'entity:storage-layer' }],
    })

    const merged = (await harness.ok('entity_merge', {
      from: 'entity:storage',
      to: 'entity:storage-layer',
    })) as { from: string; to: string; relinked: number }
    expect(merged).toEqual({
      from: 'entity:storage',
      to: 'entity:storage-layer',
      relinked: 3,
    })

    const detail = (await harness.ok('fact_get', { ref: fact.ref })) as {
      links: { dst: string }[]
    }
    expect(detail.links.map((link) => link.dst)).toEqual(['entity:storage-layer'])

    const hood = (await harness.ok('fact_neighbourhood', {
      start: 'entity:storage-layer',
      depth: 1,
    })) as Neighbourhood
    expect(hood.nodes.map((node) => node.ref).sort()).toEqual(
      [
        `fact:${fact.ref}`,
        `fact:${other.ref}`,
        'decision:D1',
        'entity:storage-layer',
        'task:T0',
      ].sort(),
    )

    expect(
      await harness.err('entity_merge', {
        from: 'entity:storage',
        to: 'entity:storage-layer',
      }),
    ).toContain('entity "storage" does not exist')
    expect(
      await harness.err('entity_merge', { from: `fact:${fact.ref}`, to: 'entity:storage-layer' }),
    ).toContain('two entity refs')
    expect(
      await harness.err('entity_merge', {
        from: 'entity:storage-layer',
        to: 'entity:storage-layer',
      }),
    ).toContain('into itself')
    expect(
      await harness.err('entity_merge', { from: 'entity:storage-layer', to: 'entity:nope' }),
    ).toContain('entity "nope" does not exist')
  })
})

describe('fact resource and pagination', () => {
  it('exposes facts through the resource template', async () => {
    const fact = await addFact({ title: 'resource-worthy', body: 'readable through the template' })
    const templates = await harness.client.listResourceTemplates()
    expect(templates.resourceTemplates.map((template) => template.uriTemplate)).toContain(
      'harness://facts/{ref}',
    )
    const list = await harness.client.listResources()
    expect(list.resources.map((resource) => resource.uri)).toContain(`harness://facts/${fact.ref}`)
    const payload = (await resourceText(harness, `harness://facts/${fact.ref}`)) as {
      fact: Fact
      links: unknown[]
      confirmations: unknown[]
      lastConfirmedAt: string | null
    }
    expect(payload.fact.ref).toBe(fact.ref)
    expect(payload.fact.title).toBe('resource-worthy')
    const missing = await harness.readResource('harness://facts/F99').then(
      () => null,
      (error: unknown) => error,
    )
    expect(missing).toBeInstanceOf(Error)
  })

  it('pages through facts with limit and offset', async () => {
    await addFact({ title: 'page alpha', body: 'first page entry' })
    await addFact({ title: 'page beta', body: 'second page entry' })
    await addFact({ title: 'page gamma', body: 'third page entry' })
    const first = (await harness.ok('fact_search', { limit: 2, offset: 0 })) as {
      facts: Fact[]
    }
    expect(first.facts.map((fact) => fact.ref)).toEqual(['F3', 'F2'])
    const second = (await harness.ok('fact_search', { limit: 2, offset: 1 })) as {
      facts: Fact[]
    }
    expect(second.facts.map((fact) => fact.ref)).toEqual(['F2', 'F1'])
    const ranked = (await harness.ok('fact_search', {
      query: 'page',
      limit: 1,
      offset: 1,
    })) as { facts: Fact[] }
    expect(ranked.facts).toHaveLength(1)
    expect(await harness.err('fact_search', { offset: -1 })).toContain('Too small')
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
