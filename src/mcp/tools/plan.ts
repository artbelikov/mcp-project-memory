import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type { HarnessStore } from '../../store.js'
import { asTextResult, asToolResult, guard } from '../support.js'

const sectionIdSchema = z.string()

export function registerPlanTools(server: McpServer, store: HarnessStore): void {
  server.registerTool(
    'plan_list',
    {
      title: 'List plan sections',
      description:
        'Outline the plan: every section with id, title, content size and last update, in reading order. Use plan_get for full section text; do not assume the plan lives in a file — this IS the plan.',
      annotations: { readOnlyHint: true },
    },
    guard(() => asToolResult({ sections: store.plan.list() })),
  )

  server.registerTool(
    'plan_get',
    {
      title: 'Get plan section',
      description: 'Fetch one full plan section (markdown content plus position metadata) by id.',
      inputSchema: { id: sectionIdSchema },
      annotations: { readOnlyHint: true },
    },
    guard((args: { id: string }) => asToolResult(store.plan.get(args.id))),
  )

  server.registerTool(
    'plan_put',
    {
      title: 'Write plan section',
      description:
        'Create or replace ONE plan section atomically by id (upsert; `title` + full markdown `content`). New sections append at the end unless `after` names an id to insert behind; `after` is ignored for existing ids. No line-level patching, no giant monolithic file to re-emit — write only the section that changed. Content is free-form markdown, 50000 characters max.',
      inputSchema: {
        id: sectionIdSchema,
        title: z.string(),
        content: z.string(),
        after: sectionIdSchema.optional(),
      },
    },
    guard((args: { id: string; title: string; content: string; after?: string }) =>
      asToolResult(store.plan.put(args)),
    ),
  )

  server.registerTool(
    'plan_delete',
    {
      title: 'Delete plan section',
      description:
        'Remove one plan section by id; relative order of the remaining sections is preserved.',
      inputSchema: { id: sectionIdSchema },
    },
    guard((args: { id: string }) => asToolResult(store.plan.delete(args.id))),
  )

  server.registerTool(
    'plan_export',
    {
      title: 'Export plan markdown',
      description:
        'Export the whole plan as a single markdown document (sections in order) — for humans, for review agents, or to bootstrap a fresh repo before the harness is installed there.',
      annotations: { readOnlyHint: true },
    },
    guard(() => asTextResult(store.plan.export())),
  )
}
