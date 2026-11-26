import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createTestHarness, type TestHarness } from './support.js'

let harness: TestHarness

beforeEach(async () => {
  harness = await createTestHarness()
})

afterEach(async () => {
  await harness.dispose()
})

function promptText(result: { messages: { content: { type: string; text?: string } }[] }): string {
  const block = result.messages.at(0)?.content
  if (block === undefined || block.type !== 'text' || block.text === undefined) {
    throw new Error('prompt returned no text content')
  }
  return block.text
}

describe('prompts', () => {
  it('exposes the session-start, plan, review and drift prompts', async () => {
    const list = await harness.client.listPrompts()
    expect(list.prompts.map((prompt) => prompt.name).sort()).toEqual([
      'code-review',
      'drift-report',
      'plan-from-requirements',
      'plan-review',
      'review-recap',
      'review-refute',
      'review-triage',
      'session-start',
      'task-completion',
    ])
  })

  it('renders the session-start ritual with the focus area', async () => {
    const result = await harness.client.getPrompt({
      name: 'session-start',
      arguments: { focus: 'storage layer' },
    })
    const text = promptText(result)
    expect(text).toContain('overview')
    expect(text).toContain('handoff_get')
    expect(text).toContain('task_next')
    expect(text).toContain('fact_search')
    expect(text).toContain('storage layer')
    expect(text).toContain('0 fact(s)')
  })

  it('renders the review prompts from stored state', async () => {
    await harness.ok('task_create', {
      id: 'T0',
      title: 'review me',
      spec: 'AC: GET /x returns 200',
    })
    await harness.ok('task_update', { id: 'T0', status: 'in-progress' })
    const review = (await harness.ok('review_start', {
      taskId: 'T0',
      risk: 'low',
      headSha: 'abc123',
      oracle: 'AC: GET /x returns 200',
      reviewer: 'finder-1',
    })) as { ref: string }
    const recorded = (await harness.ok('review_record_findings', {
      ref: review.ref,
      findings: [
        {
          lens: 'correctness',
          title: 'wrong status',
          file: 'src/x.ts',
          line: 7,
          claim: 'returns 500 instead of 200',
          failureMode: 'GET /x returns 500',
          evidence: 'res.status(500)',
        },
      ],
    })) as { recorded: { id: number }[] }
    const findingId = recorded.recorded[0]?.id
    expect(findingId).toBeDefined()

    const code = promptText(
      await harness.client.getPrompt({ name: 'code-review', arguments: { taskId: 'T0' } }),
    )
    expect(code).toContain('fresh-context code reviewer')
    expect(code).toContain('AC: GET /x returns 200')
    expect(code).toContain('review_record_findings')

    const refute = promptText(
      await harness.client.getPrompt({
        name: 'review-refute',
        arguments: { reviewRef: review.ref, findingId: String(findingId) },
      }),
    )
    expect(refute).toContain('returns 500 instead of 200')
    expect(refute).toContain('review_refute')
    expect(refute).toContain('Upstream guard')

    const completion = promptText(
      await harness.client.getPrompt({ name: 'task-completion', arguments: { taskId: 'T0' } }),
    )
    expect(completion).toContain('review_close')
    expect(completion).toContain('headSha')
  })

  it('renders the planning prompt around the deliverable', async () => {
    const result = await harness.client.getPrompt({
      name: 'plan-from-requirements',
      arguments: { deliverable: 'Ship the export tool' },
    })
    const text = promptText(result)
    expect(text).toContain('Ship the export tool')
    expect(text).toContain('plan_put')
    expect(text).toContain('task_create')
    expect(text).toContain('decision_append')
  })

  it('requires the deliverable argument', async () => {
    await expect(
      harness.client.getPrompt({ name: 'plan-from-requirements', arguments: {} }),
    ).rejects.toThrow()
  })
})

describe('plan-review prompt', () => {
  it('renders the whole plan for a reviewer with no conversation history', async () => {
    await harness.ok('plan_put', { id: 'scope', title: 'Scope', content: 'MVP-1 demo flow' })
    await harness.ok('plan_put', {
      id: 'risks',
      title: 'Risks',
      content: 'migration reversibility',
      after: 'scope',
    })
    const result = await harness.client.getPrompt({ name: 'plan-review', arguments: {} })
    const text = promptText(result)
    expect(text).toContain('NO prior conversation')
    expect(text).toContain('the whole plan')
    expect(text).toContain('MVP-1 demo flow')
    expect(text).toContain('migration reversibility')
    expect(text).toContain('blocker | major | minor')
    expect(text).toContain('approve, approve-with-changes, or reject')
  })

  it('scopes to one section and falls back when the section is unknown', async () => {
    await harness.ok('plan_put', { id: 'scope', title: 'Scope', content: 'MVP-1 demo flow' })
    await harness.ok('plan_put', { id: 'risks', title: 'Risks', content: 'the risk table' })
    const scoped = await harness.client.getPrompt({
      name: 'plan-review',
      arguments: { section: 'risks' },
    })
    const scopedText = promptText(scoped)
    expect(scopedText).toContain('only the "risks" section')
    expect(scopedText).toContain('the risk table')
    expect(scopedText).not.toContain('MVP-1 demo flow')

    const fallback = await harness.client.getPrompt({
      name: 'plan-review',
      arguments: { section: 'nope' },
    })
    const fallbackText = promptText(fallback)
    expect(fallbackText).toContain('the requested section was not found')
    expect(fallbackText).toContain('MVP-1 demo flow')
  })
})

describe('drift-report prompt', () => {
  it('renders an empty-state message when nothing is stale', async () => {
    const result = await harness.client.getPrompt({ name: 'drift-report', arguments: {} })
    const text = promptText(result)
    expect(text).toContain('none: every fact was re-confirmed')
    expect(text).toContain('fact_confirm')
    expect(text).toContain('supersedes')
    expect(text).toContain('verified-facts')
  })

  it('lists stale facts with their age and supports a focus scope', async () => {
    await harness.ok('fact_add', {
      kind: 'api-fact',
      title: 'gateway kills idle long-polls',
      body: 'the gateway drops idle connections at 15 seconds',
      links: [{ rel: 'affects', dst: 'entity:storage-layer' }],
    })
    harness.db.exec(`UPDATE facts SET created_at = '2020-01-01T00:00:00.000Z' WHERE ref = 'F1'`)
    const result = await harness.client.getPrompt({
      name: 'drift-report',
      arguments: { focus: 'storage-layer' },
    })
    const text = promptText(result)
    expect(text).toContain('F1 (')
    expect(text).toContain('gateway kills idle long-polls')
    expect(text).toContain('entity:storage-layer')
    expect(text).toContain('out of scope')
    expect(text).not.toContain('none: every fact')
  })
})
