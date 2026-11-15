import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { TASK_STATUSES, type TaskStatus } from '../../repositories/tasks.js'
import type { HarnessStore } from '../../store.js'
import { asToolResult, guard } from '../support.js'

const idSchema = z.string()
const titleSchema = z.string()
const specSchema = z.string()
const blockedReasonSchema = z.string()
const statusSchema = z.enum(TASK_STATUSES)

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
    guard((args: { id: string }) => asToolResult(store.tasks.detail(args.id))),
  )

  server.registerTool(
    'task_create',
    {
      title: 'Create task',
      description:
        'Append a task to the board. Auto-allocates the next T-number unless `id` is given (duplicates are rejected). Keep `title` a one-line summary; put the detailed goal/scope/acceptance criteria into `spec` as markdown. New tasks start as todo, or as blocked (then `blockedReason` is required). Run task_next first when unsure where this task belongs.',
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
      }) => asToolResult(store.tasks.create(args)),
    ),
  )

  server.registerTool(
    'task_update',
    {
      title: 'Update task',
      description:
        'Update a task partially. Status transitions are free: todo → in-progress → done, anything → blocked (then `blockedReason` is required and cleared automatically when leaving blocked); done/cancelled can be reopened. updated_at is stamped for you. Flip status here at every state change during the session, then finish with session_log_add and handoff_set before ending.',
      inputSchema: {
        id: idSchema,
        title: titleSchema.optional(),
        spec: specSchema.optional(),
        status: statusSchema.optional(),
        blockedReason: blockedReasonSchema.optional(),
      },
    },
    guard(
      (args: {
        id: string
        title?: string
        spec?: string
        status?: TaskStatus
        blockedReason?: string
      }) => {
        const { id, ...patch } = args
        return asToolResult(store.tasks.update(id, patch))
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
