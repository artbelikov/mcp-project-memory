import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveConfig } from '../src/config.js'
import {
  compareNatural,
  matchesAll,
  naturalOrderKey,
  nextNumberIn,
  searchTerms,
  truncate,
} from '../src/util.js'

const CWD = path.resolve('E:/repo')

describe('resolveConfig', () => {
  it('defaults to ./data under the working directory', () => {
    const config = resolveConfig({}, CWD)
    expect(config.dataDir).toBe(path.join(CWD, 'data'))
    expect(config.databasePath).toBe(path.join(CWD, 'data', 'harness.db'))
  })

  it('resolves a relative DATA_DIR against cwd and honors absolute paths', () => {
    const relative = resolveConfig({ DATA_DIR: 'state/db' }, CWD)
    expect(relative.dataDir).toBe(path.join(CWD, 'state', 'db'))
    const absolute = resolveConfig({ DATA_DIR: 'D:/absolute/path' }, CWD)
    expect(absolute.dataDir).toBe('D:/absolute/path')
  })

  it('falls back to ./data when DATA_DIR is blank', () => {
    const config = resolveConfig({ DATA_DIR: '   ' }, CWD)
    expect(config.dataDir).toBe(path.join(CWD, 'data'))
  })
})

describe('util primitives', () => {
  it('orders tasks by T-number before slugs', () => {
    expect(naturalOrderKey('T12')).toBe(12)
    expect(naturalOrderKey('review-fixes')).toBe(Number.MAX_SAFE_INTEGER)
    expect(compareNatural('T2', 'T10')).toBeLessThan(0)
    expect(compareNatural('T10', 'T9')).toBeGreaterThan(0)
    expect(compareNatural('review-fixes', 'T9')).toBeGreaterThan(0)
  })

  it('scans for the next free number with a floor', () => {
    expect(nextNumberIn([], /^T(\d{1,4})$/, -1)).toBe(0)
    expect(nextNumberIn(['T1', 'T4'], /^T(\d{1,4})$/, -1)).toBe(5)
    expect(nextNumberIn(['D1'], /^D(\d{1,4})$/)).toBe(2)
    expect(nextNumberIn(['weird'], /^D(\d{1,4})$/)).toBe(1)
    expect(nextNumberIn(['D007'], /^D(\d{1,4})$/)).toBe(8)
  })

  it('truncates with the ellipsis only when needed', () => {
    expect(truncate('short', 100)).toBe('short')
    expect(truncate('abcdefghij', 5)).toBe('abcd…')
  })

  it('splits searches into lowercase terms and requires all of them', () => {
    expect(searchTerms('  Rate   QUEUE ')).toEqual(['rate', 'queue'])
    expect(matchesAll('RateQueue lives here', ['rate', 'queue'])).toBe(true)
    expect(matchesAll('RateQueue lives here', ['rate', 'queue', 'absent'])).toBe(false)
  })
})
