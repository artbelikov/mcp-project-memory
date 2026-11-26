import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type {
  Review,
  ReviewDetail,
  ReviewFindingDetail,
  ReviewHealth,
} from '../src/repositories/reviews.js'
import type { Task } from '../src/repositories/tasks.js'
import type { Overview } from '../src/store.js'
import { createTestHarness, type TestHarness } from './support.js'

let harness: TestHarness

beforeEach(async () => {
  harness = await createTestHarness({ reviewGate: 'enforce' })
})

afterEach(async () => {
  await harness.dispose()
})

async function createInProgress(id = 'T0', spec = 'AC: the behavior is observable'): Promise<void> {
  await harness.ok('task_create', { id, title: `task ${id}`, spec })
  await harness.ok('task_update', { id, status: 'in-progress' })
}

async function start(overrides: Record<string, unknown> = {}): Promise<Review> {
  return (await harness.ok('review_start', {
    taskId: 'T0',
    risk: 'low',
    headSha: 'head-1',
    oracle: 'AC: the behavior is observable',
    reviewer: 'finder-1',
    freshContext: true,
    changedPaths: ['src/x.ts'],
    ...overrides,
  })) as Review
}

async function coverage(ref = 'CR1', lens = 'correctness', result = 'clean'): Promise<void> {
  await harness.ok('review_coverage', {
    ref,
    coverage: [
      {
        lens,
        filesExamined: 'src/x.ts',
        result,
        evidence: `read ${lens} paths`,
      },
    ],
  })
}

async function check(ref = 'CR1', name = 'test', exitCode = 0): Promise<void> {
  await harness.ok('review_check', {
    ref,
    checks: [{ name, command: `pnpm ${name}`, exitCode }],
  })
}

async function finding(overrides: Record<string, unknown> = {}): Promise<ReviewFindingDetail> {
  const result = (await harness.ok('review_record_findings', {
    ref: 'CR1',
    findings: [
      {
        lens: 'correctness',
        title: 'unchecked input reaches the parser',
        file: 'src/x.ts',
        line: 42,
        claim: 'the parser trusts the request body',
        failureMode: 'POST /x with a string body parses as an object and crashes the handler',
        evidence: 'const parsed = JSON.parse(body)',
        ...overrides,
      },
    ],
  })) as { recorded: ReviewFindingDetail[] }
  return result.recorded[0] as ReviewFindingDetail
}

async function refute(
  findingId: number,
  refuter: string,
  verdict = 'confirmed',
  overrides: Record<string, unknown> = {},
): Promise<void> {
  await harness.ok('review_refute', {
    ref: 'CR1',
    verdicts: [
      {
        findingId,
        refuter,
        verdict,
        reasoning: 'traced the call path and the guard is absent',
        killStrategy: 'checked for an upstream schema guard; none exists',
        evidence: 'src/x.ts:42',
        ...overrides,
      },
    ],
  })
}

async function verifyCleanRound(headSha = 'head-1'): Promise<ReviewDetail> {
  await coverage()
  await check()
  return (await harness.ok('review_close', {
    ref: 'CR1',
    headSha,
  })) as ReviewDetail
}

describe('the task completion gate', () => {
  it('refuses done without a review, including create-as-done', async () => {
    await createInProgress()
    const missing = await harness.err('task_update', {
      id: 'T0',
      status: 'done',
      headSha: 'head-1',
    })
    expect(missing.startsWith('review-required:')).toBe(true)

    const created = await harness.err('task_create', {
      title: 'sneaky done',
      status: 'done',
    })
    expect(created.startsWith('review-required:')).toBe(true)
  })

  it('requires in-progress, an oracle, a reviewer and fresh context', async () => {
    await harness.ok('task_create', { id: 'T0', title: 'not started' })
    const notStarted = await harness.err('review_start', { taskId: 'T0', risk: 'low' })
    expect(notStarted.startsWith('invalid:')).toBe(true)

    await harness.ok('task_update', { id: 'T0', status: 'in-progress' })
    const noOracle = await harness.err('review_start', {
      taskId: 'T0',
      risk: 'low',
      reviewer: 'finder-1',
    })
    expect(noOracle).toContain('requires an oracle')
    const noReviewer = await harness.err('review_start', {
      taskId: 'T0',
      risk: 'low',
      oracle: 'AC: x',
    })
    expect(noReviewer).toContain('requires a reviewer identity')
    const noFresh = await harness.err('review_start', {
      taskId: 'T0',
      risk: 'medium',
      oracle: 'AC: x',
      reviewer: 'finder-1',
    })
    expect(noFresh).toContain('requires a fresh-context reviewer')
  })

  it('completes only at the reviewed head', async () => {
    await createInProgress()
    await start({ diffHash: 'diff-1' })
    const closed = await verifyCleanRound()
    expect(closed.review.verdict).toBe('verified')
    expect(closed.gate.canComplete).toBe(true)

    const stale = await harness.err('task_update', {
      id: 'T0',
      status: 'done',
      headSha: 'head-2',
      diffHash: 'diff-1',
    })
    expect(stale.startsWith('review-stale:')).toBe(true)
    const staleDiff = await harness.err('task_update', {
      id: 'T0',
      status: 'done',
      headSha: 'head-1',
      diffHash: 'diff-2',
    })
    expect(staleDiff.startsWith('review-stale:')).toBe(true)

    const done = (await harness.ok('task_update', {
      id: 'T0',
      status: 'done',
      headSha: 'head-1',
      diffHash: 'diff-1',
    })) as Task
    expect(done.status).toBe('done')
    const overview = (await harness.ok('overview')) as Overview
    expect(overview.reviews.verified).toBe(1)
    expect(overview.reviews.doneWithoutReview).toBe(0)
  })

  it('requires a green check and lens coverage before close', async () => {
    await createInProgress()
    await start()
    const noChecks = await harness.err('review_close', { ref: 'CR1', headSha: 'head-1' })
    expect(noChecks.startsWith('review-checks:')).toBe(true)

    await check()
    const noCoverage = await harness.err('review_close', { ref: 'CR1', headSha: 'head-1' })
    expect(noCoverage.startsWith('review-lens-missing:')).toBe(true)

    await coverage()
    const closed = (await harness.ok('review_close', {
      ref: 'CR1',
      headSha: 'head-1',
    })) as ReviewDetail
    expect(closed.review.verdict).toBe('verified')
  })

  it('invalidates a verified review when the task is reopened', async () => {
    await createInProgress()
    await start()
    await verifyCleanRound()
    await harness.ok('task_update', { id: 'T0', status: 'done', headSha: 'head-1' })

    await harness.ok('task_update', { id: 'T0', status: 'in-progress' })
    const reopened = (await harness.ok('review_get', { ref: 'CR1' })) as ReviewDetail
    expect(reopened.review.phase).toBe('hunting')
    expect(reopened.review.round).toBe(2)

    const blocked = await harness.err('task_update', {
      id: 'T0',
      status: 'done',
      headSha: 'head-1',
    })
    expect(blocked.startsWith('review-open:')).toBe(true)

    const restarted = await start({ headSha: 'head-1' })
    expect(restarted.round).toBe(2)
    await coverage()
    await check()
    await harness.ok('review_close', { ref: 'CR1', headSha: 'head-1' })
    const done = (await harness.ok('task_update', {
      id: 'T0',
      status: 'done',
      headSha: 'head-1',
    })) as Task
    expect(done.status).toBe('done')
  })

  it('requires a decision to exempt a medium-risk review', async () => {
    await createInProgress()
    await start({ risk: 'medium', freshContext: true })
    const missing = await harness.err('review_close', {
      ref: 'CR1',
      verdict: 'exempt',
      summary: 'skip it',
    })
    expect(missing.startsWith('invalid:')).toBe(true)

    await harness.ok('decision_append', {
      title: 'skip the medium-risk review',
      body: 'the change is behind a disabled flag and ships next week',
      category: 'process',
    })
    const closed = (await harness.ok('review_close', {
      ref: 'CR1',
      verdict: 'exempt',
      summary: 'skip it',
      decisionRef: 'D1',
    })) as ReviewDetail
    expect(closed.review.verdict).toBe('exempt')
  })

  it('exempts non-code work with an explicit reason', async () => {
    await harness.ok('task_create', { id: 'T0', title: 'docs-only', spec: 'AC: link works' })
    const review = (await harness.ok('review_start', {
      taskId: 'T0',
      risk: 'exempt',
    })) as Review
    const closed = (await harness.ok('review_close', {
      ref: review.ref,
      verdict: 'exempt',
      summary: 'documentation-only change; no executable behavior',
    })) as ReviewDetail
    expect(closed.review.verdict).toBe('exempt')

    const done = (await harness.ok('task_update', {
      id: 'T0',
      status: 'done',
    })) as Task
    expect(done.status).toBe('done')
  })
})

describe('hunt, refute, fix and re-review', () => {
  it('closes a refuted candidate without touching the code', async () => {
    await createInProgress()
    await start()
    const candidate = await finding()
    await refute(candidate.id, 'skeptic-1', 'refuted', {
      reasoning: 'the upstream schema already rejects a string body',
      killStrategy: 'upstream guard found in the router',
      evidence: 'src/router.ts:12 validates the body before the handler',
    })
    const closed = await verifyCleanRound()
    expect(closed.review.verdict).toBe('verified')
    const stored = closed.findings.find((entry) => entry.id === candidate.id)
    expect(stored?.status).toBe('refuted')
  })

  it('needs two confirmations for a blocker, then a fix and a later round', async () => {
    await createInProgress()
    await start()
    const candidate = await finding({ severityHint: 'blocker', classKey: 'missing-body-guard' })

    await refute(candidate.id, 'skeptic-1', 'confirmed', { severity: 'blocker' })
    let detail = (await harness.ok('review_get', { ref: 'CR1' })) as ReviewDetail
    expect(detail.findings[0]?.status).toBe('plausible')

    await refute(candidate.id, 'skeptic-2', 'confirmed', { severity: 'blocker' })
    detail = (await harness.ok('review_get', { ref: 'CR1' })) as ReviewDetail
    expect(detail.findings[0]?.status).toBe('confirmed')

    await harness.ok('review_resolve', {
      ref: 'CR1',
      resolutions: [
        {
          findingId: candidate.id,
          status: 'fixed',
          reason: 'reject non-object bodies at the edge',
          evidence: 'src/router.ts:20',
          classScan:
            'grepped every JSON.parse in the request path; one other caller uses the same guard',
        },
      ],
    })
    const tooEarly = await harness.err('review_close', { ref: 'CR1', headSha: 'head-1' })
    expect(tooEarly.startsWith('review-open:')).toBe(true)

    const next = (await harness.ok('review_start', {
      taskId: 'T0',
      headSha: 'head-2',
    })) as Review
    expect(next.round).toBe(2)
    await coverage()
    await coverage('CR1', 'tests')
    await check()
    const closed = (await harness.ok('review_close', {
      ref: 'CR1',
      headSha: 'head-2',
    })) as ReviewDetail
    expect(closed.review.verdict).toBe('verified')
    expect(closed.findings[0]?.status).toBe('fixed')
  })

  it('requires a decision for a waiver and reports it in the verdict', async () => {
    await createInProgress()
    await start()
    const candidate = await finding()
    await refute(candidate.id, 'skeptic-1')

    const noDecision = await harness.err('review_resolve', {
      ref: 'CR1',
      resolutions: [{ findingId: candidate.id, status: 'waived', reason: 'accepted risk' }],
    })
    expect(noDecision.startsWith('invalid:')).toBe(true)

    await harness.ok('decision_append', {
      title: 'accept the parser risk for now',
      body: 'the upstream gateway strips the field today',
      category: 'process',
    })
    await harness.ok('review_resolve', {
      ref: 'CR1',
      resolutions: [
        {
          findingId: candidate.id,
          status: 'waived',
          reason: 'accepted risk',
          decisionRef: 'D1',
        },
      ],
    })
    await coverage()
    await check()
    const closed = (await harness.ok('review_close', {
      ref: 'CR1',
      headSha: 'head-1',
    })) as ReviewDetail
    expect(closed.review.verdict).toBe('verified-with-waivers')
    expect(closed.findings[0]?.decisionRef).toBe('D1')
  })

  it('deduplicates the same candidate across rounds', async () => {
    await createInProgress()
    await start()
    const first = await harness.ok('review_record_findings', {
      ref: 'CR1',
      findings: [
        {
          lens: 'correctness',
          title: 'same bug',
          file: 'src/x.ts',
          line: 10,
          claim: 'x',
          failureMode: 'x',
          evidence: 'x',
        },
        {
          lens: 'correctness',
          title: 'same bug',
          file: 'src/x.ts',
          line: 11,
          claim: 'x',
          failureMode: 'x',
          evidence: 'x',
        },
      ],
    })
    expect((first as { recorded: unknown[] }).recorded).toHaveLength(1)
    expect((first as { duplicates: unknown[] }).duplicates).toHaveLength(1)
  })

  it('caps review rounds at three', async () => {
    await createInProgress()
    await start()
    await verifyCleanRound()
    await start({ headSha: 'head-2' })
    await verifyCleanRound('head-2')
    await start({ headSha: 'head-3' })
    await verifyCleanRound('head-3')
    const capped = await harness.err('review_start', {
      taskId: 'T0',
      headSha: 'head-4',
    })
    expect(capped.startsWith('review-round-cap:')).toBe(true)
  })

  it('requires tests coverage for medium risk', async () => {
    await createInProgress()
    await start({ risk: 'medium', freshContext: true })
    await check()
    await coverage('CR1', 'correctness')
    const missing = await harness.err('review_close', { ref: 'CR1', headSha: 'head-1' })
    expect(missing).toContain('tests')
    await coverage('CR1', 'tests')
    const closed = (await harness.ok('review_close', {
      ref: 'CR1',
      headSha: 'head-1',
    })) as ReviewDetail
    expect(closed.review.verdict).toBe('verified')
  })
})

describe('review health', () => {
  it('surfaces done-without-review and unrefuted findings', async () => {
    harness.db
      .prepare(
        `INSERT INTO tasks (id, title, status, spec, created_at, updated_at)
         VALUES ('LEGACY', 'legacy done', 'done', '', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
      )
      .run()
    await createInProgress('T1')
    await start({ taskId: 'T1' })
    await finding()

    const health = (await harness.ok('review_health')) as ReviewHealth
    expect(health.doneWithoutReview).toBe(1)
    expect(health.open).toBe(1)
    expect(health.unrefutedFindings).toBe(1)
    expect(health.coverageGaps).toBe(1)
  })
})
