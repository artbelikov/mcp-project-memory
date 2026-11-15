import { type McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js'
import { ErrorCode, McpError, type ReadResourceResult } from '@modelcontextprotocol/sdk/types.js'
import { HarnessError } from '../errors.js'
import { buildOverview, type HarnessStore } from '../store.js'

export function registerHarnessResources(server: McpServer, store: HarnessStore): void {
  server.registerResource(
    'overview',
    'harness://overview',
    {
      title: 'Harness overview',
      description: 'The full overview snapshot (same payload as the overview tool).',
      mimeType: 'application/json',
    },
    (uri) => asResource(uri.toString(), 'application/json', buildOverview(store)),
  )

  server.registerResource(
    'tasks',
    'harness://tasks',
    {
      title: 'Task board',
      description:
        'Every task on the board (without spec text): id, title, status, blockedReason, timestamps.',
      mimeType: 'application/json',
    },
    (uri) => asResource(uri.toString(), 'application/json', { tasks: store.tasks.list() }),
  )

  server.registerResource(
    'task',
    new ResourceTemplate('harness://tasks/{id}', {
      list: () => ({
        resources: store.tasks.list().map((task) => ({
          uri: `harness://tasks/${task.id}`,
          name: task.title,
          mimeType: 'application/json',
        })),
      }),
    }),
    {
      title: 'Task',
      description: 'One task in full: fields, spec, and both dependency directions.',
      mimeType: 'application/json',
    },
    (uri) => {
      const match = /harness:\/\/tasks\/(.+)$/.exec(uri.toString())
      if (match === null) {
        throw new McpError(ErrorCode.InvalidRequest, `malformed task uri: ${uri.toString()}`)
      }
      const id = decodeURIComponent(match[1] ?? '')
      try {
        return asResource(uri.toString(), 'application/json', store.tasks.detail(id))
      } catch (error) {
        throw wrapError(error)
      }
    },
  )

  server.registerResource(
    'handoff',
    'harness://handoff',
    {
      title: 'Current handoff',
      description: 'The authoritative cross-session handoff sections.',
      mimeType: 'application/json',
    },
    (uri) => asResource(uri.toString(), 'application/json', store.handoff.get()),
  )

  server.registerResource(
    'decisions',
    'harness://decisions',
    {
      title: 'Decisions',
      description: 'The append-only decisions log (latest 200, newest first).',
      mimeType: 'application/json',
    },
    (uri) =>
      asResource(uri.toString(), 'application/json', {
        decisions: store.decisions.list({ limit: 200 }),
      }),
  )

  server.registerResource(
    'session-log',
    'harness://session-log',
    {
      title: 'Session log',
      description: 'The append-only session log (latest 200 entries, chronological).',
      mimeType: 'application/json',
    },
    (uri) =>
      asResource(uri.toString(), 'application/json', {
        entries: store.sessionLog.list({ limit: 200 }),
      }),
  )

  server.registerResource(
    'plan',
    'harness://plan',
    {
      title: 'Plan (markdown)',
      description: 'The whole plan exported as one markdown document.',
      mimeType: 'text/markdown',
    },
    (uri) => ({
      contents: [{ uri: uri.toString(), mimeType: 'text/markdown', text: store.plan.export() }],
    }),
  )
}

function asResource(uri: string, mimeType: string, value: unknown): ReadResourceResult {
  return { contents: [{ uri, mimeType, text: JSON.stringify(value, null, 2) }] }
}

function wrapError(error: unknown): unknown {
  if (error instanceof HarnessError) {
    return new McpError(ErrorCode.InvalidRequest, `${error.code}: ${error.message}`)
  }
  return error
}
