import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type { HarnessStore } from '../../store.js'
import { MAX_HANDOFF_BODY_LENGTH } from '../../util.js'
import { asToolResult, guard } from '../support.js'

export function registerHandoffTools(server: McpServer, store: HarnessStore): void {
  server.registerTool(
    'handoff_get',
    {
      title: 'Read handoff',
      description:
        'Read the current handoff block — the authoritative "here is where we are" snapshot the previous working session wrote (last-completed, next-up, blockers, follow-ups…). Read this FIRST in every session, together with task_next; it decides what you implement and what you report. Each section reports its current `length` and the `limit`, so you can size an edit (length + addition) before writing instead of guessing.',
      annotations: { readOnlyHint: true },
    },
    guard(() => asToolResult(store.handoff.get())),
  )

  server.registerTool(
    'handoff_set',
    {
      title: 'Write handoff section',
      description:
        'Atomically write ONE handoff section: `name` upserts a short section key (≤48 chars), `body` is the full replacement text (≤4000 chars; empty body deletes the section). Canonical names: last-completed, next-up, blockers, follow-ups, pushed — invent new keys only when truly necessary. Update this before ending the session; keep each section to a few short bullets. The latest session owns the block. On overflow the error reports the actual length and overage. For a small addition to a near-full section, prefer handoff_append instead of resending the whole body.',
      inputSchema: {
        name: z
          .string()
          .describe(
            'Short section key (last-completed, next-up, blockers, follow-ups, pushed); letters/digits/space/./-/ only, max 48 characters',
          ),
        body: z
          .string()
          .describe(
            `Full replacement text; max ${MAX_HANDOFF_BODY_LENGTH} characters; empty body deletes the section`,
          ),
      },
    },
    guard((args: { name: string; body: string }) =>
      asToolResult(store.handoff.set(args.name, args.body)),
    ),
  )

  server.registerTool(
    'handoff_append',
    {
      title: 'Append to handoff section',
      description: `Append text to ONE handoff section without resending its body — the fix for editing a near-full section. The text is newline-separated from the existing body (or creates the section if absent); the combined body must stay ≤${MAX_HANDOFF_BODY_LENGTH} characters. On overflow the error reports the resulting length and overage, so you know exactly how much to trim. Empty text is a no-op. Use handoff_set for full replacement; use this for small additions.`,
      inputSchema: {
        name: z
          .string()
          .describe(
            'Short section key (last-completed, next-up, blockers, follow-ups, pushed); letters/digits/space/./-/ only, max 48 characters',
          ),
        text: z
          .string()
          .describe(
            `Text to append; newline-separated from the existing body; the combined body must stay ≤${MAX_HANDOFF_BODY_LENGTH} characters`,
          ),
      },
    },
    guard((args: { name: string; text: string }) =>
      asToolResult(store.handoff.append(args.name, args.text)),
    ),
  )
}
