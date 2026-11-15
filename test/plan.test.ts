import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { PlanSection, PlanSectionSummary } from '../src/repositories/plan.js'
import { createTestHarness, type TestHarness } from './support.js'

let harness: TestHarness

beforeEach(async () => {
  harness = await createTestHarness()
})

afterEach(async () => {
  await harness.dispose()
})

function asSection(value: unknown): PlanSection {
  return value as PlanSection
}

function listPlan(): Promise<PlanSectionSummary[]> {
  return harness
    .ok('plan_list')
    .then((value) => (value as { sections: PlanSectionSummary[] }).sections)
}

function putSection(input: Record<string, unknown>): Promise<PlanSection> {
  return harness.ok('plan_put', input).then(asSection)
}

describe('plan', () => {
  it('appends new sections in order and outlines without bodies', async () => {
    await putSection({
      id: 'requirements',
      title: 'Requirement mapping',
      content: 'requirement table',
    })
    await putSection({ id: 'facts', title: 'Verified facts', content: 'ground truth' })
    const sections = await listPlan()
    expect(sections.map((section) => section.id)).toEqual(['requirements', 'facts'])
    expect(sections.map((section) => section.contentChars)).toEqual([
      'requirement table'.length,
      'ground truth'.length,
    ])
    expect(sections.every((section) => !('content' in section))).toBe(true)
  })

  it('exports the assembled document with sections in order', async () => {
    await putSection({
      id: 'scope',
      title: 'Product scope',
      content: 'MVP-1 first.\n\nTier-3 optional.',
    })
    await putSection({ id: 'arch', title: 'Architecture', content: 'Pure SPA.' })
    const markdown = await harness.okText('plan_export')
    expect(markdown).toBe(
      '# Plan\n\n## Product scope\n\nMVP-1 first.\n\nTier-3 optional.\n\n## Architecture\n\nPure SPA.\n',
    )
  })

  it('exports an empty-plan placeholder', async () => {
    const markdown = await harness.okText('plan_export')
    expect(markdown).toBe('# Plan\n\nNo sections yet.\n')
  })

  it('updates an existing section in place', async () => {
    await putSection({ id: 'scope', title: 'Product scope', content: 'v1' })
    await putSection({ id: 'arch', title: 'Architecture', content: 'Pure SPA.' })
    const updated = await putSection({
      id: 'scope',
      title: 'Product scope (reiterated)',
      content: 'MVP-1 + MVP-2',
    })
    expect(updated.id).toBe('scope')
    expect(updated.position).toBe(1)
    const sections = await listPlan()
    expect(sections.map((section) => section.id)).toEqual(['scope', 'arch'])
    const fetched = asSection(await harness.ok('plan_get', { id: 'scope' }))
    expect(fetched.title).toBe('Product scope (reiterated)')
    expect(fetched.content).toBe('MVP-1 + MVP-2')
  })

  it('inserts between sections with the after anchor', async () => {
    await putSection({ id: 'a', title: 'A', content: 'alpha' })
    await putSection({ id: 'b', title: 'B', content: 'beta' })
    await putSection({ id: 'c', title: 'C', content: 'gamma' })
    await putSection({ id: 'arch', title: 'A2', content: 'between a and b', after: 'a' })
    const sections = await listPlan()
    expect(sections.map((section) => section.id)).toEqual(['a', 'arch', 'b', 'c'])
  })

  it('appends behind the last section when after is omitted', async () => {
    await putSection({ id: 'a', title: 'A', content: 'alpha' })
    await putSection({ id: 'z', title: 'Z', content: 'zeta' })
    const sections = await listPlan()
    expect(sections.map((section) => section.id)).toEqual(['a', 'z'])
  })

  it('rejects unknown after anchors and malformed ids', async () => {
    const unknownAnchor = await harness.err('plan_put', {
      id: 'new',
      title: 'N',
      content: 'x',
      after: 'ghost',
    })
    expect(unknownAnchor).toBe('not-found: plan section "ghost" does not exist')
    const badId = await harness.err('plan_put', { id: 'Bad', title: 'N', content: 'x' })
    expect(badId.startsWith('invalid:')).toBe(true)
  })

  it('deletes sections and preserves the rest', async () => {
    await putSection({ id: 'a', title: 'A', content: 'alpha' })
    await putSection({ id: 'b', title: 'B', content: 'beta' })
    await harness.ok('plan_delete', { id: 'a' })
    const sections = await listPlan()
    expect(sections.map((section) => section.id)).toEqual(['b'])
    const text = await harness.err('plan_get', { id: 'a' })
    expect(text).toBe('not-found: plan section "a" does not exist')
    const deleted = await harness.err('plan_delete', { id: 'a' })
    expect(deleted).toBe('not-found: plan section "a" does not exist')
  })
})
