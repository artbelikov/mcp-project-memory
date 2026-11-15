import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type { HarnessStore } from '../../store.js'
import { asToolResult, guard } from '../support.js'

export function registerProgressTools(server: McpServer, store: HarnessStore): void {
  server.registerTool(
    'session_log_add',
    {
      title: 'Append session log line',
      description:
        'Append ONE condensed line to the append-only, cross-session log — never rewritten, never deleted, newest entries land at the bottom. Do this before ending any working session: `session` is a short kebab-style session name, `outcome` one line stating what was done and the resulting state. date defaults to today in UTC (YYYY-MM-DD) and may be backfilled for past sessions.',
      inputSchema: {
        session: z.string(),
        outcome: z.string(),
        taskId: z.string().optional(),
        date: z.string().optional(),
      },
    },
    guard((args: { session: string; outcome: string; taskId?: string; date?: string }) =>
      asToolResult(store.sessionLog.append(args)),
    ),
  )

  server.registerTool(
    'session_log_list',
    {
      title: 'List session log',
      description:
        'Read the append-only session log in chronological order (optionally filtered by `session` name substring or `taskId`, latest `limit` rows, default 20). Orient yourself on past work here instead of asking the user.',
      inputSchema: {
        limit: z.number().int().min(1).max(100).optional(),
        session: z.string().optional(),
        taskId: z.string().optional(),
      },
      annotations: { readOnlyHint: true },
    },
    guard((args: { limit?: number; session?: string; taskId?: string }) =>
      asToolResult({ entries: store.sessionLog.list(args) }),
    ),
  )

  server.registerTool(
    'decision_append',
    {
      title: 'Record decision',
      description:
        'Record a durable decision or gotcha. A stable D-number is auto-assigned once (from D1) and is IMMUTABLE — this log is append-only and never renumbered. One record per fact; titles name the behavior concretely ("gateway kills idle long-polls at ~15 s"), bodies state the binding rule and any accepted trade-off. `supersedes` retires an older decision by referencing it instead of editing history; `category` is an open short slug (api-facts, process, architecture, testing…). Unknown taskId/supersedes values are rejected.',
      inputSchema: {
        title: z.string(),
        body: z.string(),
        category: z.string().optional(),
        taskId: z.string().optional(),
        supersedes: z.string().optional(),
      },
    },
    guard(
      (args: {
        title: string
        body: string
        category?: string
        taskId?: string
        supersedes?: string
      }) => asToolResult(store.decisions.append(args)),
    ),
  )

  server.registerTool(
    'decision_list',
    {
      title: 'List decisions',
      description:
        'Search and list recorded decisions — newest first; optional `query` (every term must appear in title or body), `category`, `taskId`, `limit` (default 20). This is the memory of binding rules: consult instead of guessing conventions.',
      inputSchema: {
        query: z.string().optional(),
        category: z.string().optional(),
        taskId: z.string().optional(),
        limit: z.number().int().min(1).max(100).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    guard((args: { query?: string; category?: string; taskId?: string; limit?: number }) =>
      asToolResult({ decisions: store.decisions.list(args) }),
    ),
  )

  server.registerTool(
    'decision_get',
    {
      title: 'Get decision',
      description:
        'Fetch one decision by its exact D-number (for example D79), including body, category, task link and what it supersedes.',
      inputSchema: { ref: z.string() },
      annotations: { readOnlyHint: true },
    },
    guard((args: { ref: string }) => asToolResult(store.decisions.get(args.ref))),
  )
}
