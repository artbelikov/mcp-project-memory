import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type { HarnessStore } from '../../store.js'
import { asToolResult, guard } from '../support.js'

export function registerHandoffTools(server: McpServer, store: HarnessStore): void {
  server.registerTool(
    'handoff_get',
    {
      title: 'Read handoff',
      description:
        'Read the current handoff block — the authoritative "here is where we are" snapshot the previous working session wrote (last-completed, next-up, blockers, follow-ups…). Read this FIRST in every session, together with task_next; it decides what you implement and what you report.',
      annotations: { readOnlyHint: true },
    },
    guard(() => asToolResult(store.handoff.get())),
  )

  server.registerTool(
    'handoff_set',
    {
      title: 'Write handoff section',
      description:
        'Atomically write ONE handoff section: `name` upserts a short section key, `body` is the full replacement text (empty body deletes the section). Canonical names: last-completed, next-up, blockers, follow-ups, pushed — invent new keys only when truly necessary. Update this before ending the session; keep each section to a few short bullets. The latest session owns the block.',
      inputSchema: {
        name: z.string(),
        body: z.string(),
      },
    },
    guard((args: { name: string; body: string }) =>
      asToolResult(store.handoff.set(args.name, args.body)),
    ),
  )
}
