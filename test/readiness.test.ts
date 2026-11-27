import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import type { ReadinessAssessment, ReadinessRecord } from '../src/repositories/readiness.js'
import type { Task, TaskDetail } from '../src/repositories/tasks.js'
import type { Overview } from '../src/store.js'
import { createTestHarness, resourceText, type TestHarness } from './support.js'

let harness: TestHarness

afterEach(async () => {
  await harness.dispose()
})

const SPEC = '# Goal\n\nAC1: GET /health returns 200\nAC2: unknown id returns 404'

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

async function seedTask(
  options: { readinessGate?: 'off' | 'warn' | 'enforce' } = {},
): Promise<void> {
  harness = await createTestHarness(options)
  await harness.ok('task_create', { id: 'T0', title: 'health endpoint', spec: SPEC })
}

async function drill(overrides: Record<string, unknown> = {}): Promise<ReadinessRecord> {
  const result = (await harness.ok('readiness_set', {
    taskId: 'T0',
    goal: 'serve a health endpoint the load balancer can poll',
    acceptance: 'AC1: GET /health returns 200',
    serves: ['T0'],
    outOfScope: ['auth', 'metrics'],
    commands: ['pnpm test', 'pnpm lint'],
    ...overrides,
  })) as { record: ReadinessRecord }
  return result.record
}

describe('readiness_set', () => {
  it('records the drill and appends revisions', async () => {
    await seedTask()
    const first = await drill()
    expect(first.taskId).toBe('T0')
    expect(first.revision).toBe(1)
    expect(first.goal).toBe('serve a health endpoint the load balancer can poll')
    expect(first.acceptance).toBe('AC1: GET /health returns 200')
    expect(first.serves).toEqual(['T0'])
    expect(first.outOfScope).toEqual(['auth', 'metrics'])
    expect(first.commands).toEqual(['pnpm test', 'pnpm lint'])
    expect(first.specHash).toMatch(/^[a-f0-9]{64}$/)

    const second = await drill({ goal: 'same task, sharper wording' })
    expect(second.revision).toBe(2)
    const rows = harness.db
      .prepare('SELECT revision, goal FROM readiness_checks WHERE task_id = ? ORDER BY revision')
      .all('T0') as { revision: number; goal: string }[]
    expect(rows).toEqual([
      { revision: 1, goal: 'serve a health endpoint the load balancer can poll' },
      { revision: 2, goal: 'same task, sharper wording' },
    ])
    const fetched = (await harness.ok('readiness_get', { taskId: 'T0' })) as ReadinessAssessment
    expect(fetched.record?.revision).toBe(2)
    expect(fetched.record?.goal).toBe('same task, sharper wording')
  })

  it('reports readiness-required through readiness_get before any drill', async () => {
    await seedTask()
    const result = (await harness.ok('readiness_get', { taskId: 'T0' })) as ReadinessAssessment & {
      gate: string
    }
    expect(result.record).toBeNull()
    expect(result.canStart).toBe(false)
    expect(result.blockers[0]?.code).toBe('readiness-required')
    expect(result.gate).toBe('off')
  })

  it('normalizes whitespace when matching the spec quote', async () => {
    await seedTask()
    const record = await drill({ acceptance: 'AC1: GET /health\n  returns 200' })
    expect(record.acceptance).toBe('AC1: GET /health\n  returns 200')
  })

  it('re-derives a whitespace-variant acceptance on the read path', async () => {
    await seedTask({ readinessGate: 'enforce' })
    await drill({ acceptance: 'AC1: GET /health\n   returns 200' })
    const ready = (await harness.ok('readiness_get', { taskId: 'T0' })) as ReadinessAssessment
    expect(ready.canStart).toBe(true)
    expect(ready.blockers).toEqual([])
    const started = (await harness.ok('task_update', {
      id: 'T0',
      status: 'in-progress',
    })) as Task
    expect(started.status).toBe('in-progress')
  })

  it('accepts an exactly 8-character quote and refuses a 7-character one', async () => {
    await seedTask()
    const boundary = await drill({ acceptance: 'AC1: GET' })
    expect(boundary.acceptance).toBe('AC1: GET')
    const short = await harness.err('readiness_set', {
      taskId: 'T0',
      goal: 'g',
      acceptance: 'AC1: GE',
      outOfScope: ['none'],
      commands: ['pnpm test'],
    })
    expect(short.startsWith('invalid: acceptance must be at least 8 characters')).toBe(true)
  })

  it('refuses a paraphrase, an empty spec and empty lists', async () => {
    await seedTask()
    const paraphrase = await harness.err('readiness_set', {
      taskId: 'T0',
      goal: 'g',
      acceptance: 'the health check works',
      outOfScope: ['none'],
      commands: ['pnpm test'],
    })
    expect(paraphrase.startsWith('invalid: acceptance must quote the task spec')).toBe(true)

    await harness.ok('task_create', { id: 'T1', title: 'no spec' })
    const emptySpec = await harness.err('readiness_set', {
      taskId: 'T1',
      goal: 'g',
      acceptance: 'AC1: GET /health returns 200',
      outOfScope: ['none'],
      commands: ['pnpm test'],
    })
    expect(emptySpec).toBe(
      'invalid: task spec is empty; write testable acceptance criteria into the task spec before running the readiness drill',
    )

    const noScope = await harness.err('readiness_set', {
      taskId: 'T0',
      goal: 'g',
      acceptance: 'AC1: GET /health returns 200',
      outOfScope: [],
      commands: ['pnpm test'],
    })
    expect(noScope).toBe('invalid: outOfScope must have at least one entry')

    const noCommands = await harness.err('readiness_set', {
      taskId: 'T0',
      goal: 'g',
      acceptance: 'AC1: GET /health returns 200',
      outOfScope: ['none'],
      commands: [],
    })
    expect(noCommands).toBe('invalid: commands must have at least one entry')
  })

  it('enforces the item cap and normalizes serve refs', async () => {
    await seedTask()
    await harness.ok('decision_append', { title: 'health route is public', body: 'no auth' })
    const capped = await harness.err('readiness_set', {
      taskId: 'T0',
      goal: 'g',
      acceptance: 'AC1: GET /health returns 200',
      outOfScope: ['none'],
      commands: Array.from({ length: 21 }, (_, index) => `cmd-${index}`),
    })
    expect(capped).toBe('invalid: commands has 21 entries; limit 20')

    const longGoal = await harness.err('readiness_set', {
      taskId: 'T0',
      goal: 'x'.repeat(501),
      acceptance: 'AC1: GET /health returns 200',
      outOfScope: ['none'],
      commands: ['pnpm test'],
    })
    expect(longGoal).toContain('goal')

    const boundaryGoal = await drill({ goal: 'x'.repeat(500) })
    expect(boundaryGoal.goal).toHaveLength(500)

    const manyServes = await harness.err('readiness_set', {
      taskId: 'T0',
      goal: 'g',
      acceptance: 'AC1: GET /health returns 200',
      serves: Array.from({ length: 21 }, (_, index) => `R${index + 1}`),
      outOfScope: ['none'],
      commands: ['pnpm test'],
    })
    expect(manyServes).toBe('invalid: serves has 21 entries; limit 20')

    const record = await drill({ serves: ['d1', 'D1', 'R1'] })
    expect(record.serves).toEqual(['D1', 'R1'])
  })

  it('validates serves refs against the store', async () => {
    await seedTask()
    await harness.ok('decision_append', { title: 'health route is public', body: 'no auth' })
    await harness.ok('fact_add', { kind: 'api-fact', title: 'lb polls /health', body: 'every 5s' })

    const valid = await drill({ serves: ['R1', 'D1', 'F1', 'T0'] })
    expect(valid.serves).toEqual(['R1', 'D1', 'F1', 'T0'])

    const unknownDecision = await harness.err('readiness_set', {
      taskId: 'T0',
      goal: 'g',
      acceptance: 'AC1: GET /health returns 200',
      serves: ['D9'],
      outOfScope: ['none'],
      commands: ['pnpm test'],
    })
    expect(unknownDecision).toBe('not-found: decision "D9" does not exist')

    const unknownFact = await harness.err('readiness_set', {
      taskId: 'T0',
      goal: 'g',
      acceptance: 'AC1: GET /health returns 200',
      serves: ['F9'],
      outOfScope: ['none'],
      commands: ['pnpm test'],
    })
    expect(unknownFact).toBe('not-found: fact "F9" does not exist')

    const unknownTask = await harness.err('readiness_set', {
      taskId: 'T0',
      goal: 'g',
      acceptance: 'AC1: GET /health returns 200',
      serves: ['T9'],
      outOfScope: ['none'],
      commands: ['pnpm test'],
    })
    expect(unknownTask).toBe('not-found: task "T9" does not exist')

    const badRef = await harness.err('readiness_set', {
      taskId: 'T0',
      goal: 'g',
      acceptance: 'AC1: GET /health returns 200',
      serves: ['X1'],
      outOfScope: ['none'],
      commands: ['pnpm test'],
    })
    expect(badRef.startsWith('invalid: serves entry "X1"')).toBe(true)
  })

  it('accepts an existing 5-digit decision ref', async () => {
    await seedTask()
    harness.db
      .prepare('INSERT INTO decisions (ref, title, body, created_at) VALUES (?, ?, ?, ?)')
      .run('D10000', 'ten thousand', 'b', '2026-01-01T00:00:00.000Z')
    const record = await drill({ serves: ['D10000'] })
    expect(record.serves).toEqual(['D10000'])
  })

  it('refuses to drill a finished or unknown task', async () => {
    await seedTask()
    await harness.ok('task_update', { id: 'T0', status: 'cancelled' })
    const cancelled = await harness.err('readiness_set', {
      taskId: 'T0',
      goal: 'g',
      acceptance: 'AC1: GET /health returns 200',
      outOfScope: ['none'],
      commands: ['pnpm test'],
    })
    expect(cancelled).toBe(
      'invalid: task "T0" is cancelled; the readiness drill runs before work starts, not after it ends',
    )

    await harness.ok('task_create', { id: 'T1', title: 'done task', spec: SPEC })
    await harness.ok('task_update', { id: 'T1', status: 'done' })
    const done = await harness.err('readiness_set', {
      taskId: 'T1',
      goal: 'g',
      acceptance: 'AC1: GET /health returns 200',
      outOfScope: ['none'],
      commands: ['pnpm test'],
    })
    expect(done).toBe(
      'invalid: task "T1" is done; the readiness drill runs before work starts, not after it ends',
    )

    const unknown = await harness.err('readiness_get', { taskId: 'Z9' })
    expect(unknown).toBe('not-found: task "Z9" does not exist')

    const unknownSet = await harness.err('readiness_set', {
      taskId: 'Z9',
      goal: 'g',
      acceptance: 'AC1: GET /health returns 200',
      outOfScope: ['none'],
      commands: ['pnpm test'],
    })
    expect(unknownSet).toBe('not-found: task "Z9" does not exist')
  })
})

describe('readiness staleness, health and import', () => {
  it('marks the drill stale when the task spec changes', async () => {
    await seedTask()
    await drill()
    const fresh = (await harness.ok('readiness_get', { taskId: 'T0' })) as ReadinessAssessment
    expect(fresh.canStart).toBe(true)
    expect(fresh.blockers).toEqual([])

    await harness.ok('task_update', { id: 'T0', spec: `${SPEC}\nAC3: HEAD returns 200` })
    const stale = (await harness.ok('readiness_get', { taskId: 'T0' })) as ReadinessAssessment
    expect(stale.canStart).toBe(false)
    expect(stale.blockers[0]?.code).toBe('readiness-stale')
  })

  it('clears staleness when re-drilled against the edited spec', async () => {
    await seedTask({ readinessGate: 'enforce' })
    await drill()
    await harness.ok('task_update', { id: 'T0', status: 'in-progress' })
    await harness.ok('task_update', { id: 'T0', spec: `${SPEC}\nAC3: HEAD returns 200` })
    const stale = await harness.err('task_update', { id: 'T0', status: 'in-progress' })
    expect(stale.startsWith('readiness-stale:')).toBe(true)

    await drill({ acceptance: 'AC3: HEAD returns 200' })
    const fresh = (await harness.ok('readiness_get', { taskId: 'T0' })) as ReadinessAssessment
    expect(fresh.canStart).toBe(true)
    const started = (await harness.ok('task_update', { id: 'T0', status: 'in-progress' })) as Task
    expect(started.status).toBe('in-progress')
  })

  it('counts missing and stale drills for in-progress tasks in the overview', async () => {
    await seedTask({ readinessGate: 'warn' })
    await harness.ok('task_create', { id: 'T1', title: 'unready' })
    await harness.ok('task_update', { id: 'T1', status: 'in-progress' })
    const missing = (await harness.ok('overview')) as Overview
    expect(missing.readiness).toEqual({
      inProgress: 1,
      missing: 1,
      stale: 0,
      samples: { missing: ['T1'], stale: [] },
      gate: 'warn',
    })

    await harness.ok('task_update', { id: 'T1', spec: `${SPEC}\nAC3: HEAD returns 200` })
    await drill({ taskId: 'T1' })
    const drilled = (await harness.ok('overview')) as Overview
    expect(drilled.readiness.missing).toBe(0)
    expect(drilled.readiness.stale).toBe(0)
    await harness.ok('task_update', { id: 'T1', spec: `${SPEC}\nAC4: HEAD returns 200` })
    const stale = (await harness.ok('overview')) as Overview
    expect(stale.readiness.stale).toBe(1)
    expect(stale.readiness.samples.stale).toEqual(['T1'])
  })

  it('surfaces the drill in task_get and the task resource', async () => {
    await seedTask()
    await drill()
    const detail = (await harness.ok('task_get', { id: 'T0' })) as TaskDetail & {
      readiness: ReadinessAssessment
    }
    expect(detail.readiness.record?.revision).toBe(1)
    expect(detail.readiness.canStart).toBe(true)

    const resource = (await resourceText(harness, 'harness://tasks/T0')) as {
      readiness: ReadinessAssessment
    }
    expect(resource.readiness.record?.revision).toBe(1)
    expect(resource.readiness.canStart).toBe(true)
  })

  it('rejects forged and malformed readiness rows on import', async () => {
    await seedTask({ readinessGate: 'enforce' })
    const dump = (await harness.ok('harness_export')) as {
      readiness_checks: Record<string, unknown>[]
    } & Record<string, unknown>
    const row: Record<string, unknown> = {
      task_id: 'T0',
      revision: 1,
      goal: 'forged',
      acceptance: 'anything at all',
      serves: '["T0"]',
      out_of_scope: '["none"]',
      commands: '["pnpm test"]',
      spec_hash: sha256(SPEC),
      created_at: '2026-01-01T00:00:00.000Z',
    }

    dump.readiness_checks = [row]
    await harness.ok('harness_import', { data: dump, mode: 'replace' })
    const forged = (await harness.ok('readiness_get', { taskId: 'T0' })) as ReadinessAssessment
    expect(forged.canStart).toBe(false)
    expect(forged.blockers[0]?.code).toBe('readiness-stale')
    const blocked = await harness.err('task_update', { id: 'T0', status: 'in-progress' })
    expect(blocked.startsWith('readiness-stale:')).toBe(true)

    dump.readiness_checks = [{ ...row, serves: 'NOT-JSON' }]
    const badList = await harness.err('harness_import', { data: dump, mode: 'replace' })
    expect(badList).toContain('readiness_checks[0].serves')
    const stillThere = (await harness.ok('task_get', { id: 'T0' })) as TaskDetail
    expect(stillThere.task.id).toBe('T0')

    dump.readiness_checks = [{ ...row, out_of_scope: '[]' }]
    const emptyList = await harness.err('harness_import', { data: dump, mode: 'replace' })
    expect(emptyList).toContain('out_of_scope must have at least one entry')

    dump.readiness_checks = [{ ...row, serves: '["D999"]' }]
    const dangling = await harness.err('harness_import', { data: dump, mode: 'replace' })
    expect(dangling).toBe('not-found: decision "D999" does not exist')

    dump.readiness_checks = [{ ...row, serves: '["F999"]' }]
    const missingFact = await harness.err('harness_import', { data: dump, mode: 'replace' })
    expect(missingFact).toBe('not-found: fact "F999" does not exist')

    dump.readiness_checks = [
      { ...row, commands: JSON.stringify(Array.from({ length: 21 }, (_, index) => `c${index}`)) },
    ]
    const tooMany = await harness.err('harness_import', { data: dump, mode: 'replace' })
    expect(tooMany).toContain('commands has 21 entries; limit 20')

    dump.readiness_checks = [{ ...row, revision: 'not-a-number' }]
    const badRevision = await harness.err('harness_import', { data: dump, mode: 'replace' })
    expect(badRevision.startsWith('invalid:')).toBe(true)
    expect(badRevision).toContain('readiness_checks')
  })

  it('re-derives the eight-character acceptance minimum on the read path', async () => {
    await seedTask({ readinessGate: 'enforce' })
    const dump = (await harness.ok('harness_export')) as {
      readiness_checks: Record<string, unknown>[]
    } & Record<string, unknown>
    dump.readiness_checks = [
      {
        task_id: 'T0',
        revision: 1,
        goal: 'too short to quote',
        acceptance: 'AC1: GE',
        serves: '["T0"]',
        out_of_scope: '["none"]',
        commands: '["pnpm test"]',
        spec_hash: sha256(SPEC),
        created_at: '2026-01-01T00:00:00.000Z',
      },
    ]
    await harness.ok('harness_import', { data: dump, mode: 'replace' })
    const imported = (await harness.ok('readiness_get', { taskId: 'T0' })) as ReadinessAssessment
    expect(imported.canStart).toBe(false)
    expect(imported.blockers[0]?.code).toBe('readiness-stale')
    const blocked = await harness.err('task_update', { id: 'T0', status: 'in-progress' })
    expect(blocked.startsWith('readiness-stale:')).toBe(true)
  })

  it('imports a historical drill for a done task', async () => {
    await seedTask()
    await drill()
    await harness.ok('task_update', { id: 'T0', status: 'done' })
    const dump = (await harness.ok('harness_export')) as Record<string, unknown>
    await harness.ok('harness_import', { data: dump, mode: 'replace' })
    const imported = (await harness.ok('readiness_get', { taskId: 'T0' })) as ReadinessAssessment
    expect(imported.record?.revision).toBe(1)
    expect(imported.canStart).toBe(true)
  })

  it('accepts an uppercase spec_hash that encodes the same digest', async () => {
    await seedTask()
    const dump = (await harness.ok('harness_export')) as {
      readiness_checks: Record<string, unknown>[]
    } & Record<string, unknown>
    dump.readiness_checks = [
      {
        task_id: 'T0',
        revision: 1,
        goal: 'serve health',
        acceptance: 'AC1: GET /health returns 200',
        serves: '["T0"]',
        out_of_scope: '["none"]',
        commands: '["pnpm test"]',
        spec_hash: sha256(SPEC).toUpperCase(),
        created_at: '2026-01-01T00:00:00.000Z',
      },
    ]
    await harness.ok('harness_import', { data: dump, mode: 'replace' })
    const imported = (await harness.ok('readiness_get', { taskId: 'T0' })) as ReadinessAssessment
    expect(imported.canStart).toBe(true)
  })

  it('rejects importing a dump whose history cites a force-deleted task', async () => {
    await seedTask()
    await harness.ok('task_create', { id: 'T1', title: 'served task', spec: SPEC })
    await drill({ serves: ['T1'] })
    await harness.ok('task_delete', { id: 'T1', force: true })
    const dump = (await harness.ok('harness_export')) as Record<string, unknown>
    const rejected = await harness.err('harness_import', { data: dump, mode: 'replace' })
    expect(rejected).toBe('not-found: task "T1" does not exist')
  })

  it('cascades the drill when the task is deleted', async () => {
    await seedTask()
    await drill()
    await harness.ok('task_delete', { id: 'T0' })
    const count = (
      harness.db.prepare('SELECT COUNT(*) AS n FROM readiness_checks').get() as { n: number }
    ).n
    expect(count).toBe(0)
  })

  it('refuses to delete a task cited by another drill unless forced', async () => {
    await seedTask()
    await harness.ok('task_create', { id: 'T1', title: 'served task', spec: SPEC })
    await drill({ serves: ['T1'] })
    const blocked = await harness.err('task_delete', { id: 'T1' })
    expect(blocked).toBe(
      'blocked-by-dependents: task "T1" is cited by the readiness drill(s) of T0 — re-drill those tasks first, or pass force: true',
    )
    await harness.ok('task_delete', { id: 'T1', force: true })
    const remaining = (await harness.ok('task_get', { id: 'T0' })) as TaskDetail
    expect(remaining.task.id).toBe('T0')
    const citation = (await harness.ok('readiness_get', {
      taskId: 'T0',
    })) as ReadinessAssessment
    expect(citation.record?.serves).toEqual(['T1'])
  })

  it('lets a re-drill supersede a citation so the cited task can be deleted', async () => {
    await seedTask()
    await harness.ok('task_create', { id: 'T1', title: 'served task', spec: SPEC })
    await drill({ serves: ['T1'] })
    await drill({ serves: ['T0'] })
    await harness.ok('task_delete', { id: 'T1' })
    const gone = await harness.err('task_get', { id: 'T1' })
    expect(gone).toBe('not-found: task "T1" does not exist')
  })

  it('selects the highest revision even when a lower revision is appended later', async () => {
    await seedTask()
    await harness.ok('task_create', { id: 'T1', title: 'cited task', spec: SPEC })
    const insertRow = (revision: number, goal: string, serves: string): void => {
      harness.db
        .prepare(
          `INSERT INTO readiness_checks
            (task_id, revision, goal, acceptance, serves, out_of_scope, commands, spec_hash, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          'T0',
          revision,
          goal,
          'AC1: GET /health returns 200',
          serves,
          '["none"]',
          '["pnpm test"]',
          sha256(SPEC),
          '2026-01-01T00:00:00.000Z',
        )
    }
    insertRow(5, 'five', '["T1"]')
    insertRow(2, 'two', '["T0"]')
    const latest = (await harness.ok('readiness_get', { taskId: 'T0' })) as ReadinessAssessment
    expect(latest.record?.revision).toBe(5)
    expect(latest.canStart).toBe(true)

    const blocked = await harness.err('task_delete', { id: 'T1' })
    expect(blocked.startsWith('blocked-by-dependents:')).toBe(true)
  })
})

describe('readiness gate', () => {
  it('refuses in-progress without a drill under enforce, then allows it', async () => {
    await seedTask({ readinessGate: 'enforce' })
    const before = (await harness.ok('readiness_get', { taskId: 'T0' })) as ReadinessAssessment & {
      gate: string
    }
    expect(before.gate).toBe('enforce')
    const blocked = await harness.err('task_update', { id: 'T0', status: 'in-progress' })
    expect(blocked.startsWith('readiness-required: task "T0" has no readiness drill')).toBe(true)

    await drill()
    const started = (await harness.ok('task_update', {
      id: 'T0',
      status: 'in-progress',
    })) as Task
    expect(started.status).toBe('in-progress')
  })

  it('refuses creating a task directly as in-progress under enforce', async () => {
    await harness.dispose()
    harness = await createTestHarness({ readinessGate: 'enforce' })
    const blocked = await harness.err('task_create', {
      title: 'sneaky',
      status: 'in-progress',
    })
    expect(
      blocked.startsWith('readiness-required: new tasks cannot be created as in-progress'),
    ).toBe(true)
  })

  it('allows creating an in-progress task under warn and off', async () => {
    await harness.dispose()
    harness = await createTestHarness({ readinessGate: 'warn' })
    const warnTask = (await harness.ok('task_create', {
      id: 'T0',
      title: 'warn start',
      status: 'in-progress',
    })) as Task
    expect(warnTask.status).toBe('in-progress')

    await harness.dispose()
    harness = await createTestHarness({ readinessGate: 'off' })
    const offTask = (await harness.ok('task_create', {
      id: 'T0',
      title: 'off start',
      status: 'in-progress',
    })) as Task
    expect(offTask.status).toBe('in-progress')
  })

  it('gates blocked and done entry, and accepts the reopen -> drill -> start path', async () => {
    await seedTask({ readinessGate: 'enforce' })
    await harness.ok('task_create', {
      id: 'T1',
      title: 'blocked task',
      spec: SPEC,
      status: 'blocked',
      blockedReason: 'waiting on fixtures',
    })
    const blocked = await harness.err('task_update', { id: 'T1', status: 'in-progress' })
    expect(blocked.startsWith('readiness-required:')).toBe(true)
    await drill({ taskId: 'T1' })
    await harness.ok('task_update', { id: 'T1', status: 'in-progress' })

    await harness.ok('task_create', { id: 'T2', title: 'done task', spec: SPEC })
    await harness.ok('task_update', { id: 'T2', status: 'done' })
    const done = await harness.err('task_update', { id: 'T2', status: 'in-progress' })
    expect(done.startsWith('readiness-required:')).toBe(true)
    await harness.ok('task_update', { id: 'T2', status: 'todo' })
    await drill({ taskId: 'T2' })
    const reopened = (await harness.ok('task_update', {
      id: 'T2',
      status: 'in-progress',
    })) as Task
    expect(reopened.status).toBe('in-progress')
  })

  it('re-checks an already in-progress task under enforce', async () => {
    await seedTask({ readinessGate: 'enforce' })
    harness.db.prepare("UPDATE tasks SET status = 'in-progress' WHERE id = 'T0'").run()
    const blocked = await harness.err('task_update', { id: 'T0', status: 'in-progress' })
    expect(blocked.startsWith('readiness-required:')).toBe(true)
    await drill()
    const started = (await harness.ok('task_update', {
      id: 'T0',
      status: 'in-progress',
    })) as Task
    expect(started.status).toBe('in-progress')
  })

  it('refuses a spec change in the same call that starts the task', async () => {
    await seedTask({ readinessGate: 'enforce' })
    await drill()
    const blocked = await harness.err('task_update', {
      id: 'T0',
      status: 'in-progress',
      spec: `${SPEC}\nAC3: HEAD returns 200`,
    })
    expect(blocked.startsWith('readiness-stale:')).toBe(true)
  })

  it('lets warn mode start without a drill but reports it', async () => {
    await seedTask({ readinessGate: 'warn' })
    const started = (await harness.ok('task_update', {
      id: 'T0',
      status: 'in-progress',
    })) as Task
    expect(started.status).toBe('in-progress')
    const snapshot = (await harness.ok('overview')) as Overview
    expect(snapshot.readiness.missing).toBe(1)
  })

  it('lets off mode start without a drill and reports the off gate', async () => {
    await seedTask({ readinessGate: 'off' })
    const started = (await harness.ok('task_update', {
      id: 'T0',
      status: 'in-progress',
    })) as Task
    expect(started.status).toBe('in-progress')
    const snapshot = (await harness.ok('overview')) as Overview
    expect(snapshot.readiness.gate).toBe('off')
    expect(snapshot.readiness.missing).toBe(1)
  })
})
