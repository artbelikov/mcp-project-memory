import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Decision } from '../src/repositories/decisions.js'
import type { Handoff } from '../src/repositories/handoff.js'
import type { SessionLogEntry } from '../src/repositories/session-log.js'
import type { Overview } from '../src/store.js'

import { createTestHarness, type TestHarness } from './support.js'

let harness: TestHarness

beforeEach(async () => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-11-14T12:00:00.000Z'))
  harness = await createTestHarness()
})

afterEach(async () => {
  vi.useRealTimers()
  await harness.dispose()
})

function asDecision(value: unknown): Decision {
  return value as Decision
}

function asHandoff(value: unknown): Handoff {
  return value as Handoff
}

async function seedTask(id: string): Promise<void> {
  await harness.ok('task_create', { id, title: `task ${id}` })
}

async function appendDecision(input: Record<string, unknown>): Promise<Decision> {
  return asDecision(await harness.ok('decision_append', input))
}

describe('session_log_add', () => {
  it('appends chronologically and defaults the date to today in UTC', async () => {
    await seedTask('T0')
    const first = (await harness.ok('session_log_add', {
      session: 't1-api-client',
      outcome: 'facades + rate queue landed',
      taskId: 'T0',
    })) as SessionLogEntry
    expect(first.id).toBe(1)
    expect(first.date).toBe('2026-11-14')
    const second = (await harness.ok('session_log_add', {
      session: 't1-follow-up',
      outcome: 'mappers hardened',
      taskId: 'T0',
      date: '2026-11-15',
    })) as SessionLogEntry
    expect(second.date).toBe('2026-11-15')
    const list = (await harness.ok('session_log_list')) as { entries: SessionLogEntry[] }
    expect(list.entries.map((entry) => entry.session)).toEqual(['t1-api-client', 't1-follow-up'])
  })

  it('rejects malformed dates and unknown tasks', async () => {
    const badDate = await harness.err('session_log_add', {
      session: 's',
      outcome: 'o',
      date: '11/2026-01',
    })
    expect(badDate).toBe('invalid: date "11/2026-01" must be formatted YYYY-MM-DD')
    const badTask = await harness.err('session_log_add', {
      session: 's',
      outcome: 'o',
      taskId: 'T42',
    })
    expect(badTask).toBe('not-found: task "T42" does not exist')
  })

  it('limits the listed window to the requested tail', async () => {
    for (let index = 0; index < 5; index += 1) {
      await harness.ok('session_log_add', { session: `s${index}`, outcome: 'kept it terse' })
    }
    const tail = (await harness.ok('session_log_list', { limit: 2 })) as {
      entries: SessionLogEntry[]
    }
    expect(tail.entries.map((entry) => entry.session)).toEqual(['s3', 's4'])
  })
})

describe('decision_append', () => {
  it('allocates stable immutable D-refs', async () => {
    await seedTask('T0')
    const first = await appendDecision({
      title: 'Rate limits are hard: history 1 rps',
      body: 'every call rides the per-method RateQueue, never raw fetch',
      category: 'api-facts',
      taskId: 'T0',
    })
    expect(first.ref).toBe('D1')
    expect(first.taskId).toBe('T0')
    const second = await appendDecision({
      title: 'No comments in code',
      body: 'self-documenting names instead',
    })
    expect(second.ref).toBe('D2')
    const fetched = asDecision(await harness.ok('decision_get', { ref: 'D2' }))
    expect(fetched.title).toBe('No comments in code')
  })

  it('lists newest first, filtered by query terms and category', async () => {
    await appendDecision({
      title: 'detail A',
      body: 'stale-window hydration passes abortable',
      category: 'architecture',
    })
    await appendDecision({
      title: 'detail B',
      body: 'preview-attempt state owned by the store',
      category: 'testing',
    })
    await appendDecision({
      title: 'detail C',
      body: 'abortable hydration passes again',
      category: 'architecture',
    })
    const newestFirst = (await harness.ok('decision_list')) as { decisions: Decision[] }
    expect(newestFirst.decisions.map((decision) => decision.ref)).toEqual(['D3', 'D2', 'D1'])
    const byQuery = (await harness.ok('decision_list', { query: 'abortable passes' })) as {
      decisions: Decision[]
    }
    expect(byQuery.decisions.map((decision) => decision.ref)).toEqual(['D3', 'D1'])
    const byCategory = (await harness.ok('decision_list', { category: 'testing' })) as {
      decisions: Decision[]
    }
    expect(byCategory.decisions.map((decision) => decision.ref)).toEqual(['D2'])
  })

  it('validates supersedes and task references', async () => {
    await appendDecision({ title: 'old rule', body: 'superseded soon' })
    const unknownSupersedes = await harness.err('decision_append', {
      title: 'nope',
      body: 'x',
      supersedes: 'D9',
    })
    expect(unknownSupersedes).toBe('not-found: decision "D9" does not exist')
    const chained = await appendDecision({
      title: 'new rule',
      body: 'replaces the old rule',
      supersedes: 'D1',
    })
    expect(chained.supersedes).toBe('D1')
    await seedTask('T5')
    const withTask = await appendDecision({ title: 'tied rule', body: 'b', taskId: 'T5' })
    expect(withTask.taskId).toBe('T5')
    const unknownTask = await harness.err('decision_append', {
      title: 'x',
      body: 'b',
      taskId: 'T9',
    })
    expect(unknownTask).toBe('not-found: task "T9" does not exist')
  })
})

describe('handoff', () => {
  it('starts empty', async () => {
    const empty = asHandoff(await harness.ok('handoff_get'))
    expect(empty.sections).toEqual([])
    expect(empty.updatedAt).toBeNull()
  })

  it('writes sections atomically and keeps insertion order', async () => {
    await harness.ok('handoff_set', { name: 'last-completed', body: 'T0 merged' })
    await harness.ok('handoff_set', { name: 'next-up', body: 'T1' })
    await harness.ok('handoff_set', { name: 'blockers', body: 'none' })
    const handoff = asHandoff(await harness.ok('handoff_get'))
    expect(handoff.sections.map((section) => section.name)).toEqual([
      'last-completed',
      'next-up',
      'blockers',
    ])
    expect(handoff.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('replaces a section body without moving it', async () => {
    await harness.ok('handoff_set', { name: 'a', body: 'first' })
    await harness.ok('handoff_set', { name: 'b', body: 'second' })
    await harness.ok('handoff_set', { name: 'a', body: 'rewritten by this session' })
    const handoff = asHandoff(await harness.ok('handoff_get'))
    expect(handoff.sections.map((section) => [section.name, section.body])).toEqual([
      ['a', 'rewritten by this session'],
      ['b', 'second'],
    ])
  })

  it('drops a section when the body is empty and rejects bad names', async () => {
    await harness.ok('handoff_set', { name: 'a', body: 'one' })
    await harness.ok('handoff_set', { name: 'b', body: 'two' })
    await harness.ok('handoff_set', { name: 'a', body: '   ' })
    const handoff = asHandoff(await harness.ok('handoff_get'))
    expect(handoff.sections.map((section) => section.name)).toEqual(['b'])
    const badName = await harness.err('handoff_set', { name: '!bad', body: 'x' })
    expect(badName.startsWith('invalid:')).toBe(true)
  })
})

describe('overview', () => {
  it('reflects empty state', async () => {
    const snapshot = (await harness.ok('overview')) as Overview
    expect(snapshot.tasks.total).toBe(0)
    expect(snapshot.tasks.byStatus).toEqual({
      todo: 0,
      'in-progress': 0,
      blocked: 0,
      done: 0,
      cancelled: 0,
    })
    expect(snapshot.tasks.next.next).toBeNull()
    expect(snapshot.handoff.updatedAt).toBeNull()
    expect(snapshot.plan.sections).toBe(0)
  })

  it('condenses a populated board into counts and sets', async () => {
    await seedTask('T0')
    await seedTask('T1')
    await seedTask('T2')
    await seedTask('T3')
    await harness.ok('task_update', { id: 'T0', status: 'done' })
    await harness.ok('task_update', { id: 'T1', status: 'in-progress' })
    await harness.ok('task_update', {
      id: 'T2',
      status: 'blocked',
      blockedReason: 'credentials pending',
    })
    await harness.ok('task_set_deps', { id: 'T3', dependsOn: ['T1'] })
    await harness.ok('handoff_set', { name: 'last-completed', body: 'T0 shipped' })
    await appendDecision({ title: 'rule', body: 'binding' })
    await harness.ok('session_log_add', { session: 'log-line', outcome: 'logged' })
    await harness.ok('plan_put', { id: 'scope', title: 'Scope', content: 'MVP-1' })

    const snapshot = (await harness.ok('overview')) as Overview
    expect(snapshot.tasks.total).toBe(4)
    expect(snapshot.tasks.byStatus).toEqual({
      todo: 1,
      'in-progress': 1,
      blocked: 1,
      done: 1,
      cancelled: 0,
    })
    expect(snapshot.tasks.inProgress.map((task) => task.id)).toEqual(['T1'])
    expect(snapshot.tasks.blocked.map((task) => task.id)).toEqual(['T2'])
    expect(snapshot.tasks.blocked.map((task) => task.blockedReason)).toEqual([
      'credentials pending',
    ])
    expect(snapshot.tasks.next.next).toBeNull()
    expect(snapshot.tasks.next.blockedOn).toEqual({
      task: expect.objectContaining({ id: 'T3' }),
      unmet: [{ id: 'T1', status: 'in-progress' }],
    })
    expect(snapshot.handoff.sections).toEqual([expect.objectContaining({ name: 'last-completed' })])
    expect(snapshot.recentDecisions).toEqual([expect.objectContaining({ ref: 'D1' })])
    expect(snapshot.recentSessionLog).toEqual([expect.objectContaining({ session: 'log-line' })])
    expect(snapshot.plan.sections).toBe(1)
  })
})
