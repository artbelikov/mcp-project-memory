import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Task, TaskDetail } from '../src/repositories/tasks.js'
import { createTestHarness, type TestHarness } from './support.js'

let harness: TestHarness

beforeEach(async () => {
  harness = await createTestHarness()
})

afterEach(async () => {
  await harness.dispose()
})

function asTask(value: unknown): Task {
  return value as Task
}

function asDetail(value: unknown): TaskDetail {
  return value as TaskDetail
}

function createTask(id: string, title?: string): Promise<Task> {
  return harness.ok('task_create', { id, title: title ?? `task ${id}` }).then(asTask)
}

function updateTask(id: string, patch: Record<string, unknown>): Promise<Task> {
  return harness.ok('task_update', { id, ...patch }).then(asTask)
}

describe('task_create', () => {
  it('allocates sequential T-numbers and starts todo', async () => {
    const first = asTask(await harness.ok('task_create', { title: 'scaffold + gates' }))
    const second = asTask(await harness.ok('task_create', { title: 'api client + rate queue' }))
    expect(first.id).toBe('T0')
    expect(first.status).toBe('todo')
    expect(first.blockedReason).toBeNull()
    expect(second.id).toBe('T1')
  })

  it('continues past the greatest explicit reference', async () => {
    await createTask('T0')
    await createTask('T99')
    const next = asTask(await harness.ok('task_create', { title: 'tail' }))
    expect(next.id).toBe('T100')
  })

  it('rejects duplicate ids as a conflict', async () => {
    await createTask('T0')
    const text = await harness.err('task_create', { id: 'T0', title: 'again' })
    expect(text).toBe('conflict: task "T0" already exists')
  })

  it('accepts numbered refs and lowercase slugs, rejects the rest', async () => {
    await createTask('T3')
    await createTask('chat-sync-1')
    for (const id of ['UPPER', 'with space', '.leading-dot']) {
      const text = await harness.err('task_create', { id, title: 'x' })
      expect(text.startsWith('invalid:')).toBe(true)
    }
  })

  it('requires a reason for blocked and refuses stray reasons otherwise', async () => {
    const text = await harness.err('task_create', { title: 'x', status: 'blocked' })
    expect(text).toBe('invalid: status "blocked" requires blockedReason')
    const stray = await harness.err('task_create', { title: 'x', blockedReason: 'why' })
    expect(stray).toBe('invalid: blockedReason applies only when status is "blocked"')
    const blocked = asTask(
      await harness.ok('task_create', {
        title: 'parked work',
        status: 'blocked',
        blockedReason: 'waiting for API fixtures',
      }),
    )
    expect(blocked.status).toBe('blocked')
    expect(blocked.blockedReason).toBe('waiting for API fixtures')
  })

  it('keeps a one-line title and the full spec', async () => {
    const task = asTask(
      await harness.ok('task_create', {
        id: 'T0',
        title: '  api client  ',
        spec: '# Goal\nrate-queue with per-method spacing',
      }),
    )
    expect(task.title).toBe('api client')
    const detail = asDetail(await harness.ok('task_get', { id: 'T0' }))
    expect(detail.task.spec).toBe('# Goal\nrate-queue with per-method spacing')
    expect(detail.dependsOn).toEqual([])
    expect(detail.dependents).toEqual([])
  })
})

describe('task_update', () => {
  it('stamps updated_at and runs the whole transition set', async () => {
    const before = await createTask('T0', 'draft title')
    const moved = await updateTask('T0', {
      title: 'api client + rate queue',
      status: 'in-progress',
    })
    expect(moved.title).toBe('api client + rate queue')
    expect(moved.status).toBe('in-progress')
    expect(moved.updatedAt >= before.updatedAt).toBe(true)
    const done = await updateTask('T0', { status: 'done' })
    expect(done.status).toBe('done')
    const reopened = await updateTask('T0', { status: 'todo' })
    expect(reopened.status).toBe('todo')
  })

  it('clears the blocked reason when leaving blocked', async () => {
    await createTask('T0')
    const blocked = await updateTask('T0', { status: 'blocked', blockedReason: 'on hold' })
    expect(blocked.blockedReason).toBe('on hold')
    const resumed = await updateTask('T0', { status: 'todo' })
    expect(resumed.blockedReason).toBeNull()
  })

  it('rejects unknown ids and stray reasons', async () => {
    const unknown = await harness.err('task_update', { id: 'Z9', status: 'done' })
    expect(unknown).toBe('not-found: task "Z9" does not exist')
    await createTask('T0')
    const stray = await harness.err('task_update', {
      id: 'T0',
      status: 'todo',
      blockedReason: 'why',
    })
    expect(stray).toBe('invalid: blockedReason applies only when status is "blocked"')
  })
})

describe('task_list', () => {
  it('filters by status and sorts naturally', async () => {
    await createTask('T10')
    await createTask('T2')
    await createTask('review-fixes')
    const todo = (await harness.ok('task_list', { status: 'todo' })) as { tasks: Task[] }
    expect(todo.tasks.map((task) => task.id)).toEqual(['T2', 'T10', 'review-fixes'])
    await updateTask('T2', { status: 'in-progress' })
    const stillTodo = (await harness.ok('task_list', { status: 'todo' })) as { tasks: Task[] }
    expect(stillTodo.tasks.map((task) => task.id)).toEqual(['T10', 'review-fixes'])
    const everything = (await harness.ok('task_list')) as { tasks: Task[] }
    expect(everything.tasks).toHaveLength(3)
  })

  it('with a spec excluded and one line per task', async () => {
    await createTask('T0')
    const list = (await harness.ok('task_list')) as { tasks: Task[] }
    for (const task of list.tasks) expect(task.spec).toBe('')
  })
})

describe('task_get', () => {
  it('rejects unknown ids', async () => {
    const text = await harness.err('task_get', { id: 'T7' })
    expect(text).toBe('not-found: task "T7" does not exist')
  })
})

describe('task_delete', () => {
  it('refuses while depended on and releases edges with force', async () => {
    await createTask('T0')
    await createTask('T1')
    await harness.ok('task_set_deps', { id: 'T1', dependsOn: ['T0'] })
    const guardText = await harness.err('task_delete', { id: 'T0' })
    expect(guardText).toBe(
      'blocked-by-dependents: task "T0" is a dependency of T1 — resolve or re-plan them first, or pass force: true',
    )
    const forced = (await harness.ok('task_delete', { id: 'T0', force: true })) as {
      id: string
      releasedDependents: string[]
    }
    expect(forced.id).toBe('T0')
    expect(forced.releasedDependents).toEqual(['T1'])
    const survivor = asDetail(await harness.ok('task_get', { id: 'T1' }))
    expect(survivor.dependsOn).toEqual([])
    await harness.err('task_get', { id: 'T0' })
  })

  it('rejects unknown ids', async () => {
    const text = await harness.err('task_delete', { id: 'ghost' })
    expect(text).toBe('not-found: task "ghost" does not exist')
  })
})

describe('task_set_deps', () => {
  it('replaces the dependency set wholesale', async () => {
    await createTask('T0')
    await createTask('T1')
    await createTask('T2')
    await harness.ok('task_set_deps', { id: 'T2', dependsOn: ['T0', 'T1'] })
    const first = asDetail(await harness.ok('task_get', { id: 'T2' }))
    expect(first.dependsOn).toEqual(['T0', 'T1'])
    expect(first.dependents).toEqual([])
    expect(asDetail(await harness.ok('task_get', { id: 'T0' })).dependents).toEqual(['T2'])
    await harness.ok('task_set_deps', { id: 'T2', dependsOn: ['T1'] })
    const second = asDetail(await harness.ok('task_get', { id: 'T2' }))
    expect(second.dependsOn).toEqual(['T1'])
    expect(asDetail(await harness.ok('task_get', { id: 'T0' })).dependents).toEqual([])
  })

  it('rejects self-references and unknown tasks', async () => {
    await createTask('T0')
    const self = await harness.err('task_set_deps', { id: 'T0', dependsOn: ['T0'] })
    expect(self).toBe('invalid: task "T0" cannot depend on itself')
    const unknownDeps = await harness.err('task_set_deps', { id: 'T0', dependsOn: ['T9'] })
    expect(unknownDeps).toBe('not-found: unknown dependencies for "T0": T9')
  })

  it('rejects cycles with the traversed path', async () => {
    await createTask('T1')
    await createTask('T2')
    await createTask('T3')
    await harness.ok('task_set_deps', { id: 'T2', dependsOn: ['T1'] })
    await harness.ok('task_set_deps', { id: 'T3', dependsOn: ['T2'] })
    const text = await harness.err('task_set_deps', { id: 'T1', dependsOn: ['T3'] })
    expect(text).toBe('dependency-cycle: T3 → T2 → T1')
  })

  it('swallows duplicate edges and rewriting existing edges', async () => {
    await createTask('T0')
    await createTask('T1')
    await createTask('T2')
    await harness.ok('task_set_deps', { id: 'T2', dependsOn: ['T0', 'T0', 'T1'] })
    const detail = asDetail(await harness.ok('task_get', { id: 'T2' }))
    expect(detail.dependsOn).toEqual(['T0', 'T1'])
  })
})
