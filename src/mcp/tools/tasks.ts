import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { HarnessError } from '../../errors.js'
import { TASK_STATUSES, type TaskStatus } from '../../repositories/tasks.js'
import type { HarnessStore } from '../../store.js'
import { MAX_REVIEW_HEAD_LENGTH, MAX_SPEC_LENGTH, MAX_TITLE_LENGTH } from '../../util.js'
import { asToolResult, guard } from '../support.js'

const idSchema = z
  .string()
  .describe('Task id: a T-number (T0–T9999) or a lowercase slug [a-z][a-z0-9-]; max 48 characters')
const titleSchema = z
  .string()
  .describe(`One-line summary; non-empty, max ${MAX_TITLE_LENGTH} characters`)
const specSchema = z
  .string()
  .describe(
    `Long-form goal/scope/acceptance criteria as markdown; max ${MAX_SPEC_LENGTH} characters`,
  )
const blockedReasonSchema = z
  .string()
  .describe('Required when status is "blocked"; cleared automatically when leaving blocked')
const statusSchema = z.enum(TASK_STATUSES)
const headShaSchema = z
  .string()
  .describe(
    `Reviewed commit SHA used to prove the review matches the code being completed; max ${MAX_REVIEW_HEAD_LENGTH} characters`,
  )
const diffHashSchema = z
  .string()
  .describe(
    `Reviewed diff fingerprint used to prove the worktree matches the review; max ${MAX_REVIEW_HEAD_LENGTH} characters`,
  )

export function registerTaskTools(server: McpServer, store: HarnessStore): void {
  server.registerTool(
    'task_next',
    {
      title: 'Next task to work on',
      description:
        'Resolve the work queue: `next` is the recommended task (first todo task whose dependencies are done or cancelled), `ready` lists every unblocked todo task, and `blockedOn` exposes the highest-ranked todo task that still waits on dependencies (with their ids and statuses). Call this at session start, together with handoff_get, and implement exactly this task unless the handoff overrides it.',
      annotations: { readOnlyHint: true },
    },
    guard(() => asToolResult(store.tasks.next())),
  )

  server.registerTool(
    'task_list',
    {
      title: 'List tasks',
      description:
        'List tasks on the board, optionally filtered by status, naturally sorted (T0, T1, T10…). One row per task with title/status/blockedReason and timestamps; spec text is excluded — use task_get for it.',
      inputSchema: { status: statusSchema.optional() },
      annotations: { readOnlyHint: true },
    },
    guard((args: { status?: TaskStatus }) =>
      asToolResult({ tasks: store.tasks.list(args.status) }),
    ),
  )

  server.registerTool(
    'task_get',
    {
      title: 'Get task',
      description:
        'Fetch a single task: the full record including its long-form spec (goal/scope/acceptance criteria as markdown) plus both dependency directions (`dependsOn`, `dependents`).',
      inputSchema: { id: idSchema },
      annotations: { readOnlyHint: true },
    },
    guard((args: { id: string }) => {
      const detail = store.tasks.detail(args.id)
      return asToolResult({ ...detail, review: store.reviews.summaryForTask(args.id) })
    }),
  )

  server.registerTool(
    'task_create',
    {
      title: 'Create task',
      description:
        'Append a task to the board. Auto-allocates the next T-number unless `id` is given (duplicates are rejected). Keep `title` a one-line summary (≤200 chars); put the detailed goal/scope/acceptance criteria into `spec` as markdown (≤20000 chars). New tasks start as todo, or as blocked (then `blockedReason` is required). Run task_next first when unsure where this task belongs.',
      inputSchema: {
        title: titleSchema,
        id: idSchema.optional(),
        spec: specSchema.optional(),
        status: statusSchema.optional(),
        blockedReason: blockedReasonSchema.optional(),
      },
    },
    guard(
      (args: {
        title: string
        id?: string
        spec?: string
        status?: TaskStatus
        blockedReason?: string
      }) => {
        if (args.status === 'done' && store.reviewGate === 'enforce') {
          throw new HarnessError(
            'review-required',
            'new tasks cannot be created as done under the review gate; create it as todo or in-progress, run the review, then complete it',
          )
        }
        return asToolResult(store.tasks.create(args))
      },
    ),
  )

  server.registerTool(
    'task_update',
    {
      title: 'Update task',
      description:
        'Update a task partially. Status transitions are free: todo → in-progress → done, anything → blocked (then `blockedReason` is required and cleared automatically when leaving blocked); done/cancelled can be reopened (reopening a done task invalidates its review and forces a new round). updated_at is stamped for you. Under the review gate, `done` also requires the reviewed `headSha` (and `diffHash` when the review recorded one). Flip status here at every state change during the session, then finish with session_log_add and handoff_set before ending.',
      inputSchema: {
        id: idSchema,
        title: titleSchema.optional(),
        spec: specSchema.optional(),
        status: statusSchema.optional(),
        blockedReason: blockedReasonSchema.optional(),
        headSha: headShaSchema.optional(),
        diffHash: diffHashSchema.optional(),
      },
    },
    guard(
      (args: {
        id: string
        title?: string
        spec?: string
        status?: TaskStatus
        blockedReason?: string
        headSha?: string
        diffHash?: string
      }) => {
        const { id, headSha, diffHash, ...patch } = args
        const existing = store.tasks.get(id)
        if (patch.status === 'done' && existing.status !== 'done') {
          store.reviews.assertCanComplete(id, headSha, diffHash)
        }
        const updated = store.tasks.update(id, patch)
        if (
          existing.status === 'done' &&
          patch.status !== undefined &&
          patch.status !== 'done' &&
          patch.status !== 'cancelled'
        ) {
          store.reviews.reopen(id)
        }
        return asToolResult(updated)
      },
    ),
  )

  server.registerTool(
    'task_delete',
    {
      title: 'Delete task',
      description:
        'Delete a task permanently (history entries are separate and untouched). Refuses while other tasks still depend on it unless `force` is given, which silently drops the stale edges of the dependents — document that plan change with decision_append.',
      inputSchema: { id: idSchema, force: z.boolean().optional() },
    },
    guard((args: { id: string; force?: boolean }) =>
      asToolResult(store.tasks.delete(args.id, args.force ?? false)),
    ),
  )

  server.registerTool(
    'task_set_deps',
    {
      title: 'Set task dependencies',
      description:
        'Replace the complete dependency set of a task (empty array clears every edge). Accepts an error pointing at unknown tasks, self-references, and dependency cycles. Keep the graph accurate so task_next stays honest.',
      inputSchema: { id: idSchema, dependsOn: z.array(idSchema) },
    },
    guard((args: { id: string; dependsOn: string[] }) =>
      asToolResult(store.tasks.setDependencies(args.id, args.dependsOn)),
    ),
  )
}
