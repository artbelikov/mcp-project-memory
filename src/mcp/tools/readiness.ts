import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type { ReadinessInput } from '../../repositories/readiness.js'
import type { HarnessStore } from '../../store.js'
import {
  MAX_READINESS_ACCEPTANCE_LENGTH,
  MAX_READINESS_COMMAND_LENGTH,
  MAX_READINESS_GOAL_LENGTH,
  MAX_READINESS_ITEMS,
  MAX_READINESS_OUT_OF_SCOPE_LENGTH,
  MAX_READINESS_SERVE_LENGTH,
} from '../../util.js'
import { asToolResult, guard } from '../support.js'

const taskIdSchema = z
  .string()
  .describe('Task id: a T-number (T0-T9999) or a lowercase slug [a-z][a-z0-9-]; max 48 characters')

export function registerReadinessTools(server: McpServer, store: HarnessStore): void {
  server.registerTool(
    'readiness_set',
    {
      title: 'Record the pre-work readiness drill',
      description:
        'The sanity check before any code changes: restate the task in falsifiable terms and attach evidence, not prose. `acceptance` must quote the task spec verbatim (whitespace-insensitive), so a task with no testable AC cannot pass. `serves` cites the R/D/F/T refs the task implements (they must exist), `outOfScope` freezes what this task will not do, `commands` names the exact checks that will prove it. Append-only: each call adds a revision; a spec change makes the drill stale. Under HARNESS_READINESS_GATE=enforce, task_update(status:"in-progress") refuses without a valid drill.',
      inputSchema: {
        taskId: taskIdSchema,
        goal: z
          .string()
          .describe(
            `One-line restatement of the task goal in your own words; max ${MAX_READINESS_GOAL_LENGTH} chars`,
          ),
        acceptance: z
          .string()
          .describe(
            `Verbatim quote of the task spec's acceptance criteria (whitespace-insensitive; at least 8 chars); max ${MAX_READINESS_ACCEPTANCE_LENGTH} chars`,
          ),
        serves: z
          .array(z.string())
          .optional()
          .describe(
            `Refs this task implements: R<n> plan requirement, D<n> decision, F<n> fact, T<n> task; max ${MAX_READINESS_ITEMS} entries of ${MAX_READINESS_SERVE_LENGTH} chars`,
          ),
        outOfScope: z
          .array(z.string())
          .describe(
            `Explicit non-goals for this task (use ["none"] only if genuinely nothing is excluded); max ${MAX_READINESS_ITEMS} entries of ${MAX_READINESS_OUT_OF_SCOPE_LENGTH} chars`,
          ),
        commands: z
          .array(z.string())
          .describe(
            `Exact commands that will prove the work (e.g. "pnpm test", "pnpm lint"); max ${MAX_READINESS_ITEMS} entries of ${MAX_READINESS_COMMAND_LENGTH} chars`,
          ),
      },
    },
    guard((args: ReadinessInput) =>
      asToolResult({
        record: store.readiness.record(args),
        gate: store.readinessGate,
      }),
    ),
  )

  server.registerTool(
    'readiness_get',
    {
      title: 'Read the readiness drill',
      description:
        "Fetch a task's latest readiness drill plus the start gate: `record` (null when never recorded), `blockers` (`readiness-required` when missing, `readiness-stale` when the task spec changed after the drill) and `canStart`. Read-only. The reviewer at the exit gate compares this brief-back against the actual diff.",
      inputSchema: { taskId: taskIdSchema },
      annotations: { readOnlyHint: true },
    },
    guard((args: { taskId: string }) =>
      asToolResult({
        taskId: args.taskId,
        gate: store.readinessGate,
        ...store.readiness.assess(args.taskId),
      }),
    ),
  )
}
