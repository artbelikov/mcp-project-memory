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
  it('exposes the session-start and plan-from-requirements prompts', async () => {
    const list = await harness.client.listPrompts()
    expect(list.prompts.map((prompt) => prompt.name).sort()).toEqual([
      'plan-from-requirements',
      'session-start',
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
