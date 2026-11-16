import fc from 'fast-check'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { HarnessError } from '../src/errors.js'
import { ftsMatchQuery } from '../src/util.js'
import { createTestHarness, type TestHarness } from './support.js'

let harness: TestHarness

beforeEach(async () => {
  harness = await createTestHarness()
})

afterEach(async () => {
  await harness.dispose()
})

function factCount(): number {
  return (harness.db.prepare('SELECT COUNT(*) AS n FROM facts').get() as { n: number }).n
}

function refsSince(start: number): string[] {
  const rows = harness.db.prepare('SELECT ref FROM facts ORDER BY id').all() as unknown as {
    ref: string
  }[]
  return rows.slice(start).map((row) => row.ref)
}

describe('properties', () => {
  it('allocates a gapless, monotonically increasing F-ref sequence', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 10 }), async (n) => {
        const start = factCount()
        for (let i = 0; i < n; i += 1) {
          await harness.ok('fact_add', {
            kind: 'note',
            title: `sequence ${start}-${i}`,
            body: `body for sequence entry number ${i}`,
          })
        }
        expect(refsSince(start)).toEqual(Array.from({ length: n }, (_, i) => `F${start + 1 + i}`))
      }),
      { numRuns: 12 },
    )
  })

  it('never leaks a raw database error out of search', async () => {
    await fc.assert(
      fc.asyncProperty(fc.string({ maxLength: 80 }), async (query) => {
        try {
          harness.store.facts.search({ query })
        } catch (error) {
          expect(error).toBeInstanceOf(HarnessError)
        }
        try {
          ftsMatchQuery(query)
        } catch (error) {
          expect(error).toBeInstanceOf(HarnessError)
        }
      }),
      { numRuns: 120 },
    )
  })

  it('accepts or rejects arbitrary fact_add input without internal errors', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ maxLength: 300 }),
        fc.string({ maxLength: 200 }),
        async (title, body) => {
          const result = await harness.call('fact_add', { kind: 'note', title, body })
          if (result.isError !== true) return
          const text = result.content?.[0]
          if (text === undefined || text.type !== 'text') throw new Error('error without text')
          expect(text.text).toMatch(/^(invalid|not-found): /)
        },
      ),
      { numRuns: 40 },
    )
  })

  it('returns exactly the BFS-reachable set within depth on arbitrary graphs', async () => {
    const edgeArb = fc.array(fc.tuple(fc.nat({ max: 5 }), fc.nat({ max: 5 }), fc.boolean()), {
      maxLength: 18,
    })
    await fc.assert(
      fc.asyncProperty(
        edgeArb,
        fc.nat({ max: 5 }),
        fc.integer({ min: 1, max: 4 }),
        async (edges, startAt, depth) => {
          const refs: string[] = []
          for (let i = 0; i < 6; i += 1) {
            const result = (await harness.ok('fact_add', {
              kind: 'note',
              title: `graph node ${i}`,
              body: `graph node body ${i}`,
            })) as { fact: { ref: string } }
            refs.push(result.fact.ref)
          }
          const known = new Set<string>()
          const adjacency = new Map<string, Set<string>>()
          const connect = (a: string, b: string): void => {
            known.add(`${a}|relates-to|${b}`)
            const forward = adjacency.get(a) ?? new Set<string>()
            forward.add(b)
            adjacency.set(a, forward)
            const backward = adjacency.get(b) ?? new Set<string>()
            backward.add(a)
            adjacency.set(b, backward)
          }
          for (const [a, b, flipped] of edges) {
            const from = refs[flipped ? b : a]
            const to = refs[flipped ? a : b]
            if (from === undefined || to === undefined || from === to) continue
            await harness.ok('fact_link', {
              src: `fact:${from}`,
              rel: 'relates-to',
              dst: `fact:${to}`,
            })
            connect(from, to)
          }

          const start = refs[startAt]
          if (start === undefined) throw new Error('missing start ref')
          const distance = new Map<string, number>([[start, 0]])
          let frontier = [start]
          for (let step = 1; step <= depth; step += 1) {
            const next: string[] = []
            for (const node of frontier) {
              for (const neighbour of adjacency.get(node) ?? []) {
                if (distance.has(neighbour)) continue
                distance.set(neighbour, step)
                next.push(neighbour)
              }
            }
            frontier = next
          }

          const hood = (await harness.ok('fact_neighbourhood', {
            start: `fact:${start}`,
            depth,
          })) as {
            nodes: { ref: string; depth: number }[]
            edges: { src: string; rel: string; dst: string }[]
          }
          const expected = [...distance.keys()].map((ref) => `fact:${ref}`)
          expect(hood.nodes.map((node) => node.ref).sort()).toEqual(expected.sort())
          for (const node of hood.nodes) {
            const ref = node.ref.replace(/^fact:/, '')
            expect(node.depth).toBe(distance.get(ref))
          }
          const nodeRefs = new Set(hood.nodes.map((node) => node.ref))
          for (const edge of hood.edges) {
            expect(nodeRefs.has(edge.src)).toBe(true)
            expect(nodeRefs.has(edge.dst)).toBe(true)
            expect(
              known.has(
                `${edge.src.replace(/^fact:/, '')}|${edge.rel}|${edge.dst.replace(/^fact:/, '')}`,
              ),
            ).toBe(true)
          }
        },
      ),
      { numRuns: 12 },
    )
  })
})
