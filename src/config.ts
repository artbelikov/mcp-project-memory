import { isAbsolute, join } from 'node:path'

export const GATE_MODES = ['off', 'warn', 'enforce'] as const
export type GateMode = (typeof GATE_MODES)[number]

export const REVIEW_GATE_MODES = GATE_MODES
export type ReviewGateMode = GateMode
export type ReadinessGateMode = GateMode

export type HarnessConfig = {
  dataDir: string
  databasePath: string
  reviewGate: ReviewGateMode
  readinessGate: ReadinessGateMode
}

export const SERVER_NAME = 'project-memory'
export const SERVER_VERSION = '0.3.0'

export function resolveConfig(env: Record<string, string | undefined>, cwd: string): HarnessConfig {
  const raw = (env.DATA_DIR ?? 'data').trim()
  const dataDir = raw.length === 0 ? join(cwd, 'data') : isAbsolute(raw) ? raw : join(cwd, raw)
  return {
    dataDir,
    databasePath: join(dataDir, 'harness.db'),
    reviewGate: readGate(env.HARNESS_REVIEW_GATE, 'HARNESS_REVIEW_GATE', 'enforce'),
    readinessGate: readGate(env.HARNESS_READINESS_GATE, 'HARNESS_READINESS_GATE', 'warn'),
  }
}

function readGate(rawValue: string | undefined, name: string, fallback: GateMode): GateMode {
  const raw = (rawValue ?? fallback).trim().toLowerCase()
  if (!GATE_MODES.includes(raw as GateMode)) {
    throw new Error(`${name} must be one of ${GATE_MODES.join(', ')}; got "${raw}"`)
  }
  return raw as GateMode
}
