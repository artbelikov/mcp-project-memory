import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FactSearchHit } from '../src/repositories/facts.js'
import { createTestHarness, type TestHarness } from './support.js'

let harness: TestHarness

beforeEach(async () => {
  harness = await createTestHarness()
})

afterEach(async () => {
  await harness.dispose()
})

async function addFact(title: string, body: string): Promise<string> {
  const result = (await harness.ok('fact_add', { kind: 'note', title, body })) as {
    fact: { ref: string }
  }
  return result.fact.ref
}

describe('FTS index integrity', () => {
  it('tracks direct updates and deletes against the facts table', async () => {
    const first = await addFact('alpha quirk', 'the alpha behaviour of the store')
    await addFact('beta quirk', 'the beta behaviour of the store')

    harness.db.exec(
      `UPDATE facts SET title = 'renamed quirk', body = 'the renamed behaviour' WHERE ref = '${first}'`,
    )
    harness.db.exec(`DELETE FROM facts WHERE ref = 'F2'`)

    const renamed = (await harness.ok('fact_search', { query: 'renamed' })) as {
      facts: FactSearchHit[]
    }
    expect(renamed.facts.map((fact) => fact.ref)).toEqual([first])

    const staleTitle = (await harness.ok('fact_search', { query: 'alpha' })) as {
      facts: FactSearchHit[]
    }
    expect(staleTitle.facts).toEqual([])

    const deleted = (await harness.ok('fact_search', { query: 'beta' })) as {
      facts: FactSearchHit[]
    }
    expect(deleted.facts).toEqual([])
  })

  it('passes the FTS5 integrity check and row counts after churn', async () => {
    await addFact('first entry', 'some body text one')
    await addFact('second entry', 'some body text two')
    harness.db.exec(`UPDATE facts SET body = 'rewritten body text' WHERE ref = 'F1'`)
    harness.db.exec(`DELETE FROM facts WHERE ref = 'F2'`)
    await addFact('third entry', 'fresh body text')

    expect(() =>
      harness.db.exec(`INSERT INTO facts_fts (facts_fts) VALUES ('integrity-check')`),
    ).not.toThrow()

    const rows = harness.db
      .prepare(
        'SELECT (SELECT COUNT(*) FROM facts) AS facts, (SELECT COUNT(*) FROM facts_fts) AS indexed',
      )
      .get() as { facts: number; indexed: number }
    expect(rows.indexed).toBe(rows.facts)
    expect(rows.facts).toBe(2)
  })
})
