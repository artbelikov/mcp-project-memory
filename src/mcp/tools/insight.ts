import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { buildOverview, type HarnessStore, searchAll } from '../../store.js'
import { MAX_SEARCH_QUERY_LENGTH } from '../../util.js'
import { asToolResult, guard } from '../support.js'

export function registerInsightTools(server: McpServer, store: HarnessStore): void {
  server.registerTool(
    'overview',
    {
      title: 'Harness overview',
      description:
        'One terse snapshot of the entire harness: task counts by status, the in-progress and blocked sets, the task_next resolution, the current handoff, the latest decisions and session-log lines, plan size, and knowledge-base size by kind. Call this at session START (it replaces reading a progress file) and before reporting anything about project state.',
      annotations: { readOnlyHint: true },
    },
    guard(() => asToolResult(buildOverview(store))),
  )

  server.registerTool(
    'search',
    {
      title: 'Search everything',
      description:
        'Substring search across task titles/specs, decision titles/bodies, and plan section contents, plus ranked full-text search over knowledge facts. Every term must match for tasks/decisions/plan (case-insensitive); facts use FTS5/bm25 with stemming and provenance weighting. Plan results carry a snippet around the first hit. Use for forensics ("where did we record the rate-limit rules?") instead of dumping the whole store; use fact_search for knowledge-only ranked retrieval. `query` is non-empty and ≤120 chars.',
      inputSchema: {
        query: z
          .string()
          .describe(`Search terms; non-empty, max ${MAX_SEARCH_QUERY_LENGTH} characters`),
        limit: z.number().int().min(1).max(50).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    guard((args: { query: string; limit?: number }) =>
      asToolResult(searchAll(store, args.query, args.limit)),
    ),
  )
}
