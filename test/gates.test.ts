import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Decision } from '../src/repositories/decisions.js'
import type { PlanSection } from '../src/repositories/plan.js'
import type { SessionLogEntry } from '../src/repositories/session-log.js'
import type { Task, TaskDetail } from '../src/repositories/tasks.js'
import { createTestHarness, type TestHarness } from './support.js'

let harness: TestHarness

beforeEach(async () => {
  harness = await createTestHarness()
})

afterEach(async () => {
  await harness.dispose()
})

async function createAtCap(id: string, title: string): Promise<Task> {
  return (await harness.ok('task_create', { id, title })) as Task
}

describe('length caps surface as invalid', () => {
  it('rejects an over-long title at create and at update', async () => {
    const overLong = 'x'.repeat(201)
    const created = await harness.err('task_create', { title: overLong })
    expect(created).toBe('invalid: title must not exceed 200 characters')
    await createAtCap('T0', 'short')
    const updated = await harness.err('task_update', { id: 'T0', title: overLong })
    expect(updated).toBe('invalid: title must not exceed 200 characters')
  })

  it('accepts a title at exactly the cap', async () => {
    const atCap = 'x'.repeat(200)
    const task = await createAtCap('T0', atCap)
    expect(task.title).toBe(atCap)
  })

  it('rejects over-long specs at create and update', async () => {
    const spec = 'y'.repeat(20_001)
    const created = await harness.err('task_create', { title: 'ok', spec })
    expect(created).toBe('invalid: spec must not exceed 20000 characters')
    await createAtCap('T0', 'ok')
    const updated = await harness.err('task_update', { id: 'T0', spec })
    expect(updated).toBe('invalid: spec must not exceed 20000 characters')
  })

  it('rejects over-long session log fields', async () => {
    const badSession = await harness.err('session_log_add', {
      session: 's'.repeat(81),
      outcome: 'ok',
    })
    expect(badSession.startsWith('invalid:')).toBe(true)
    const badOutcome = await harness.err('session_log_add', {
      session: 'ok',
      outcome: 'o'.repeat(301),
    })
    expect(badOutcome.startsWith('invalid:')).toBe(true)
  })

  it('rejects over-long decision fields and categories', async () => {
    const badTitle = await harness.err('decision_append', { title: 't'.repeat(161), body: 'ok' })
    expect(badTitle).toBe('invalid: title must not exceed 160 characters')
    const badBody = await harness.err('decision_append', { title: 'ok', body: 'b'.repeat(8001) })
    expect(badBody).toBe('invalid: body must not exceed 8000 characters')
    const badCategory = await harness.err('decision_append', {
      title: 'ok',
      body: 'b',
      category: 'c'.repeat(41),
    })
    expect(badCategory).toBe('invalid: category must not exceed 40 characters')
  })

  it('rejects over-long handoff sections', async () => {
    const text = await harness.err('handoff_set', { name: 'next-up', body: 'h'.repeat(4001) })
    expect(text).toBe('invalid: section body must not exceed 4000 characters')
    const emptyName = await harness.err('handoff_set', { name: '', body: 'x' })
    expect(emptyName.startsWith('invalid:')).toBe(true)
  })

  it('rejects over-long plan section titles', async () => {
    const text = await harness.err('plan_put', {
      id: 'scope',
      title: 'p'.repeat(121),
      content: 'x',
    })
    expect(text).toBe('invalid: title must not exceed 120 characters')
  })
})

describe('blank and unknown values', () => {
  it('rejects blank titles and lets unknown refs fail cleanly', async () => {
    await createAtCap('T0', 'root')
    const blankCreate = await harness.err('task_create', { title: '   ' })
    expect(blankCreate).toBe('invalid: title must be a non-empty string')
    const blankUpdate = await harness.err('task_update', { id: 'T0', title: '' })
    expect(blankUpdate).toBe('invalid: title must be a non-empty string')
    const blankSession = await harness.err('session_log_add', { session: '', outcome: 'ok' })
    expect(blankSession).toBe('invalid: session must be a non-empty string')
    const blankOutcome = await harness.err('session_log_add', { session: 'ok', outcome: '  ' })
    expect(blankOutcome).toBe('invalid: outcome must be a non-empty string')
    const blankDecisionTitle = await harness.err('decision_append', { title: '', body: 'b' })
    expect(blankDecisionTitle).toBe('invalid: title must be a non-empty string')
    const blankDecisionBody = await harness.err('decision_append', { title: 't', body: '' })
    expect(blankDecisionBody).toBe('invalid: body must be a non-empty string')
    const blankPlanTitle = await harness.err('plan_put', { id: 'scope', title: '', content: 'x' })
    expect(blankPlanTitle).toBe('invalid: title must be a non-empty string')
    const unknownDecision = await harness.err('decision_get', { ref: 'D99' })
    expect(unknownDecision).toBe('not-found: decision "D99" does not exist')
  })
})

describe('filters and position guards', () => {
  it('filters the session log by session substring and task', async () => {
    await createAtCap('T1', 'task one')
    await harness.ok('task_create', { id: 'T2', title: 'task two' })
    await harness.ok('session_log_add', { session: 't1-api-client', outcome: 'one', taskId: 'T1' })
    await harness.ok('session_log_add', { session: 't2-session', outcome: 'two', taskId: 'T2' })
    const bySession = (await harness.ok('session_log_list', { session: 't1' })) as {
      entries: SessionLogEntry[]
    }
    expect(bySession.entries.map((entry) => entry.session)).toEqual(['t1-api-client'])
    const byTask = (await harness.ok('session_log_list', { taskId: 'T2' })) as {
      entries: SessionLogEntry[]
    }
    expect(byTask.entries.map((entry) => entry.taskId)).toEqual(['T2'])
  })

  it('clamps the decision list window', async () => {
    for (let index = 0; index < 5; index += 1) {
      await harness.ok('decision_append', { title: `d${index}`, body: 'b' })
    }
    const list = (await harness.ok('decision_list', { limit: 1 })) as { decisions: Decision[] }
    expect(list.decisions.map((decision) => decision.ref)).toEqual(['D5'])
  })

  it('keeps position when re-putting an existing section with an after anchor', async () => {
    const a = (await harness.ok('plan_put', {
      id: 'a',
      title: 'A',
      content: 'alpha',
    })) as PlanSection
    await harness.ok('plan_put', { id: 'b', title: 'B', content: 'beta' })
    const rePut = (await harness.ok('plan_put', {
      id: 'a',
      title: 'A reworded',
      content: 'alpha again',
      after: 'b',
    })) as PlanSection
    expect(rePut.position).toBe(a.position)
    const outline = (await harness.ok('plan_list')) as { sections: { id: string }[] }
    expect(outline.sections.map((section) => section.id)).toEqual(['a', 'b'])
  })

  it('clears dependencies with an empty set', async () => {
    await createAtCap('T0', 'root')
    await harness.ok('task_set_deps', { id: 'T0', dependsOn: [] })
    const detail = (await harness.ok('task_get', { id: 'T0' })) as TaskDetail
    expect(detail.dependsOn).toEqual([])
  })
})
