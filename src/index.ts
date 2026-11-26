import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { resolveConfig, SERVER_NAME } from './config.js'
import { closeDatabase, openDatabase } from './db/database.js'
import { buildHarnessServer } from './mcp/server.js'
import { createHarnessStore } from './store.js'

async function main(): Promise<void> {
  const config = resolveConfig(process.env, process.cwd())
  const db = openDatabase(config.databasePath)
  let closed = false
  const shutdown = (): void => {
    if (closed) return
    closed = true
    closeDatabase(db)
  }
  process.once('SIGINT', () => {
    shutdown()
    process.exit(0)
  })
  process.once('SIGTERM', () => {
    shutdown()
    process.exit(0)
  })
  const server = buildHarnessServer(createHarnessStore(db, { reviewGate: config.reviewGate }))
  try {
    await server.connect(new StdioServerTransport())
  } catch (error) {
    process.stderr.write(
      `fatal: failed to start ${SERVER_NAME}: ${error instanceof Error ? error.message : String(error)}\n`,
    )
    shutdown()
    process.exit(1)
  }
  process.stderr.write(`${SERVER_NAME} ready — sqlite at ${config.databasePath}\n`)
}

main().catch((error) => {
  process.stderr.write(
    `fatal: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  )
  process.exit(1)
})
