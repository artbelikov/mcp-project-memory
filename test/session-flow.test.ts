import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Decision } from '../src/repositories/decisions.js'
import type { Handoff } from '../src/repositories/handoff.js'
import type { SessionLogEntry } from '../src/repositories/session-log.js'
import type { NextReport, Task } from '../src/repositories/tasks.js'
import type { Overview, SearchResults } from '../src/store.js'
import { createTestHarness, resourceText, type TestHarness } from './support.js'

let harness: TestHarness

beforeEach(async () => {
  harness = await createTestHarness()
})

afterEach(async () => {
  await harness.dispose()
})

describe('the session protocol walk-through', () => {
  it('drives a full working session without touching any file', async () => {
    await harness.ok('task_create', { id: 'T0', title: 'scaffold + gates' })
    await harness.ok('task_create', { id: 'T1', title: 'api client + rate queue + mappers' })
    await harness.ok('task_create', { id: 'T2', title: 'session + connect + bootstrap' })
    await harness.ok('task_set_deps', { id: 'T1', dependsOn: ['T0'] })
    await harness.ok('task_set_deps', { id: 'T2', dependsOn: ['T1'] })

    const emptyStart = (await harness.ok('handoff_get')) as Handoff
    expect(emptyStart.sections).toEqual([])

    const queue = (await harness.ok('task_next')) as NextReport
    expect(queue.next?.id).toBe('T0')
    await harness.ok('task_update', { id: 'T0', status: 'in-progress' })

    const midSession = (await harness.ok('task_next')) as NextReport
    expect(midSession.next).toBeNull()
    expect(midSession.blockedOn).not.toBeNull()
    expect(midSession.blockedOn?.task.id).toBe('T1')
    expect(midSession.blockedOn?.unmet).toEqual([{ id: 'T0', status: 'in-progress' }])

    await harness.ok('task_update', { id: 'T0', status: 'done' })
    const afterDone = (await harness.ok('task_next')) as NextReport
    expect(afterDone.next?.id).toBe('T1')
    expect(afterDone.ready.map((task: Task) => task.id)).toEqual(['T1'])

    const decision = (await harness.ok('decision_append', {
      title: 'gateway kills idle long-polls at ~15 s',
      body: 'the engine polls with a 10 s window; the constant is exported',
      category: 'api-facts',
      taskId: 'T1',
    })) as Decision
    expect(decision.ref).toBe('D1')

    await harness.ok('task_update', {
      id: 'T1',
      status: 'blocked',
      blockedReason: 'live-verified fixtures missing for the Mappers',
    })
    const snapshot = (await harness.ok('overview')) as Overview
    expect(snapshot.tasks.byStatus).toEqual({
      todo: 1,
      'in-progress': 0,
      blocked: 1,
      done: 1,
      cancelled: 0,
    })
    expect(snapshot.tasks.blocked.map((task: Task) => task.id)).toEqual(['T1'])
    expect(snapshot.recentDecisions).toEqual([
      { ref: 'D1', title: 'gateway kills idle long-polls at ~15 s' },
    ])

    await harness.ok('handoff_set', {
      name: 'last-completed',
      body: 'T0 scaffold shipped, gates green.',
    })
    await harness.ok('handoff_set', {
      name: 'next-up',
      body: 'T1 api client — resume after fixtures land. Parked: none.',
    })
    await harness.ok('handoff_set', {
      name: 'blockers',
      body: 'T1 blocked: live-verified vendor fixtures missing.',
    })
    await harness.ok('session_log_add', {
      session: 't1-api-client',
      outcome: 'RateQueue + facades landed; T1 parked on fixtures (D1)',
      taskId: 'T1',
    })

    const handoff = (await harness.ok('handoff_get')) as Handoff
    expect(handoff.sections.map((section) => section.name)).toEqual([
      'last-completed',
      'next-up',
      'blockers',
    ])
    expect(handoff.updatedAt).not.toBeNull()

    const resumed = (await harness.ok('overview')) as Overview
    expect(resumed.handoff.sections).toHaveLength(3)
    expect(resumed.recentSessionLog).toEqual([
      expect.objectContaining({ session: 't1-api-client', taskId: 'T1' }),
    ])

    const forensic = (await harness.ok('search', { query: 'rate queue' })) as SearchResults
    expect(forensic.tasks.map((task) => task.id)).toEqual(['T1'])
    expect(forensic.decisions).toEqual([])

    await harness.ok('plan_put', {
      id: 'architecture',
      title: 'Architecture',
      content: 'Pure SPA; per-method rate queue.',
    })
    const seeded = (await harness.ok('search', { query: 'rate queue' })) as SearchResults
    expect(seeded.plan.map((section) => section.id)).toEqual(['architecture'])

    const board = (await resourceText(harness, 'harness://tasks')) as { tasks: Task[] }
    expect(board.tasks.map((task: Task) => task.id)).toEqual(['T0', 'T1', 'T2'])
    const log = (await harness.ok('session_log_list')) as { entries: SessionLogEntry[] }
    expect(log.entries.map((entry) => entry.session)).toEqual(['t1-api-client'])
  })

  it('keeps the task graph acyclic so the protocol order stays meaningful', async () => {
    await harness.ok('task_create', { id: 'T0', title: 'root' })
    await harness.ok('task_create', { id: 'T1', title: 'child' })
    await harness.ok('task_set_deps', { id: 'T1', dependsOn: ['T0'] })
    await harness.err('task_set_deps', { id: 'T0', dependsOn: ['T1'] })
    const queue = (await harness.ok('task_next')) as NextReport
    expect(queue.next?.id).toBe('T0')
  })
})
