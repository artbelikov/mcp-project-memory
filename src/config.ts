import { isAbsolute, join } from 'node:path'

export type HarnessConfig = {
  dataDir: string
  databasePath: string
}

export const SERVER_NAME = 'project-memory'
export const SERVER_VERSION = '0.2.0'

export function resolveConfig(env: Record<string, string | undefined>, cwd: string): HarnessConfig {
  const raw = (env.DATA_DIR ?? 'data').trim()
  const dataDir = raw.length === 0 ? join(cwd, 'data') : isAbsolute(raw) ? raw : join(cwd, raw)
  return { dataDir, databasePath: join(dataDir, 'harness.db') }
}
