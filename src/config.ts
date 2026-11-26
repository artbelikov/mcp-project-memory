import { isAbsolute, join } from 'node:path'

export const REVIEW_GATE_MODES = ['off', 'warn', 'enforce'] as const
export type ReviewGateMode = (typeof REVIEW_GATE_MODES)[number]

export type HarnessConfig = {
  dataDir: string
  databasePath: string
  reviewGate: ReviewGateMode
}

export const SERVER_NAME = 'project-memory'
export const SERVER_VERSION = '0.3.0'

export function resolveConfig(env: Record<string, string | undefined>, cwd: string): HarnessConfig {
  const raw = (env.DATA_DIR ?? 'data').trim()
  const dataDir = raw.length === 0 ? join(cwd, 'data') : isAbsolute(raw) ? raw : join(cwd, raw)
  const rawGate = (env.HARNESS_REVIEW_GATE ?? 'enforce').trim().toLowerCase()
  if (!REVIEW_GATE_MODES.includes(rawGate as ReviewGateMode)) {
    throw new Error(
      `HARNESS_REVIEW_GATE must be one of ${REVIEW_GATE_MODES.join(', ')}; got "${rawGate}"`,
    )
  }
  return {
    dataDir,
    databasePath: join(dataDir, 'harness.db'),
    reviewGate: rawGate as ReviewGateMode,
  }
}
