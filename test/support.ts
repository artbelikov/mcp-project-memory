import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { CallToolResult, ReadResourceResult } from '@modelcontextprotocol/sdk/types.js'
import { closeDatabase, openDatabase } from '../src/db/database.js'
import { buildHarnessServer } from '../src/mcp/server.js'
import { createHarnessStore, type HarnessStore } from '../src/store.js'

export type TestHarness = {
  db: DatabaseSync
  store: HarnessStore
  client: Client
  call: (name: string, args?: Record<string, unknown>) => Promise<CallToolResult>
  ok: (name: string, args?: Record<string, unknown>) => Promise<unknown>
  okText: (name: string, args?: Record<string, unknown>) => Promise<string>
  err: (name: string, args?: Record<string, unknown>) => Promise<string>
  readResource: (uri: string) => Promise<ReadResourceResult>
  dispose: () => Promise<void>
}

export async function createTestHarness(): Promise<TestHarness> {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'mcp-project-memory-'))
  const db: DatabaseSync = openDatabase(path.join(dataDir, 'harness.db'))
  const store = createHarnessStore(db)
  const server = buildHarnessServer(store)
  const client = new Client({ name: 'test-client', version: '0.0.0' })
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  await client.connect(clientTransport)

  const call: TestHarness['call'] = (name, args = {}) =>
    client.callTool({ name, arguments: args }) as unknown as Promise<CallToolResult>

  return {
    db,
    store,
    client,
    call,
    ok: async (name, args = {}) => {
      const result = await call(name, args)
      if (result.isError === true) throw new Error(`unexpected tool error: ${firstText(result)}`)
      return textJson(result)
    },
    okText: async (name, args = {}) => {
      const result = await call(name, args)
      if (result.isError === true) throw new Error(`unexpected tool error: ${firstText(result)}`)
      return firstText(result)
    },
    err: async (name, args = {}) => {
      const result = await call(name, args)
      if (result.isError !== true)
        throw new Error(`expected an error result, got: ${firstText(result)}`)
      return firstText(result)
    },
    readResource: async (uri) =>
      client.readResource({ uri }) as unknown as Promise<ReadResourceResult>,
    dispose: async () => {
      try {
        await client.close()
      } finally {
        await server.close()
      }
      closeDatabase(db)
      await rm(dataDir, { recursive: true, force: true })
    },
  }
}

export function firstText(result: CallToolResult): string {
  const block = result.content?.[0]
  if (block === undefined || block.type !== 'text') {
    throw new Error('tool returned no text content')
  }
  return block.text
}

export function textJson(result: CallToolResult): unknown {
  return JSON.parse(firstText(result))
}

export async function resourceText(harness: TestHarness, uri: string): Promise<unknown> {
  const result = await harness.readResource(uri)
  const block: { uri: string; text?: string } | undefined = result.contents.at(0)
  if (block === undefined || block.text === undefined) {
    throw new Error(`resource ${uri} returned no text`)
  }
  return JSON.parse(block.text)
}

export async function resourceMarkdown(harness: TestHarness, uri: string): Promise<string> {
  const result = await harness.readResource(uri)
  const block: { uri: string; text?: string } | undefined = result.contents.at(0)
  if (block === undefined || block.text === undefined) {
    throw new Error(`resource ${uri} returned no text`)
  }
  return block.text
}
