import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import {
  DUMP_FORMAT,
  exportHarness,
  type ImportMode,
  importHarness,
} from '../../repositories/transfer.js'
import type { HarnessStore } from '../../store.js'
import { asToolResult, guard } from '../support.js'

const dumpRow = z.record(z.string(), z.unknown())

const dumpSchema = z.object({
  format: z.literal(DUMP_FORMAT),
  schemaVersion: z.number().int().positive(),
  exportedAt: z.string().optional(),
  tasks: z.array(dumpRow),
  task_deps: z.array(dumpRow),
  readiness_checks: z.array(dumpRow),
  decisions: z.array(dumpRow),
  session_log: z.array(dumpRow),
  handoff_sections: z.array(dumpRow),
  plan_sections: z.array(dumpRow),
  facts: z.array(dumpRow),
  fact_confirmations: z.array(dumpRow),
  entities: z.array(dumpRow),
  links: z.array(dumpRow),
  reviews: z.array(dumpRow),
  review_findings: z.array(dumpRow),
  review_refutations: z.array(dumpRow),
  review_checks: z.array(dumpRow),
  review_coverage: z.array(dumpRow),
})

export function registerPortabilityTools(server: McpServer, store: HarnessStore): void {
  server.registerTool(
    'harness_export',
    {
      title: 'Export harness',
      description:
        'Dump the whole store as one JSON payload: format tag, schemaVersion, and every raw row of tasks, task_deps, readiness_checks, decisions, session_log, handoff_sections, plan_sections, facts, fact_confirmations, entities, links, reviews, review_findings, review_refutations, review_checks and review_coverage. Read-only — use it for backups, for diffing two projects, or as the input of harness_import after moving the data. The schemaVersion must match the importing server.',
      annotations: { readOnlyHint: true },
    },
    guard(() => asToolResult(exportHarness(store.db))),
  )

  server.registerTool(
    'harness_import',
    {
      title: 'Import harness',
      description:
        'Load a dump produced by harness_export. `mode` is required: `replace` wipes every table first (destructive, use for restore), `merge` keeps existing rows and inserts only rows whose primary key or ref does not exist yet (conflicts are skipped, counted in `skipped`). The dump format tag and schemaVersion must match this server, and the whole import runs in one transaction — it either applies completely or not at all. Returns per-table inserted/skipped counts.',
      inputSchema: { data: dumpSchema, mode: z.enum(['replace', 'merge']) },
    },
    guard((args: { data: z.output<typeof dumpSchema>; mode: ImportMode }) =>
      asToolResult(importHarness(store.db, args.data, args.mode)),
    ),
  )
}
