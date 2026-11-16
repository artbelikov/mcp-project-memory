import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type { HarnessStore } from '../store.js'

export function registerHarnessPrompts(server: McpServer, store: HarnessStore): void {
  server.registerPrompt(
    'session-start',
    {
      title: 'Session start ritual',
      description:
        'The read-before-write protocol: dashboard, handoff, next task, then prior knowledge about the area you are about to touch.',
      argsSchema: { focus: z.string().optional() },
    },
    (args: { focus?: string }) => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: sessionStartText(store, args.focus),
          },
        },
      ],
    }),
  )

  server.registerPrompt(
    'plan-from-requirements',
    {
      title: 'Plan from requirements',
      description:
        'Kick off the work-planning skill: harvest requirements, probe the live system, then write a verified plan and session-ready tasks into the store.',
      argsSchema: { deliverable: z.string() },
    },
    (args: { deliverable: string }) => ({
      messages: [
        {
          role: 'user',
          content: { type: 'text', text: planFromRequirementsText(args.deliverable) },
        },
      ],
    }),
  )
}

function sessionStartText(store: HarnessStore, focus: string | undefined): string {
  const focusLine = focus
    ? `\n- Focus area for this session: ${focus}. Run fact_search and fact_neighbourhood on it before you change anything.`
    : ''
  const counts = store.facts.summary().total
  return `Run the session-start ritual against the project-memory MCP server before writing any code.

1. Call overview — read task counts, task_next, handoff and knowledge health.
2. Call handoff_get — the previous session's last-completed, next-up, blockers and follow-ups are authoritative.
3. Call task_next — start the task it names, or stop and report what you are blocked on. Do not pick your own work.
4. Call fact_search (and fact_neighbourhood on the component you will touch) — the answer to your next question may already be recorded. The knowledge base holds ${counts} fact(s).
5. Call fact_health if the dashboard shows orphans, duplicates or stale facts; clean them as you go.
6. Flip task status to in-progress the moment you start, and keep plan_put honest as you learn.${focusLine}

Rules: append-only state — record decisions with decision_append, observations with fact_add (linked), never rewrite history; one condensed line in session_log_add and fresh handoff_set sections when you end.`
}

function planFromRequirementsText(deliverable: string): string {
  return `Turn this deliverable into a verified, session-ready plan using the work-planning skill and the project-memory MCP server:

Deliverable: ${deliverable}

1. Harvest: collect every requirement from the conversation and any provided files; write them into a plan section (plan_put). Mark each as stated, derived or open — no silent assumptions.
2. Probe: ground-truth the live system where safe (read-only endpoints, health checks, response shapes). Record each probed behavior as a fact (fact_add, kind api-fact) linked to its entity; when a probe contradicts docs, the probe wins and the conflict goes into the plan.
3. Design: write the plan sections (scope, architecture, risks, verified-facts) with plan_put; route binding choices to decision_append with rationale and rejected alternatives.
4. Break down: create tasks with task_create — each with goal/scope/acceptance criteria in the spec, dependencies wired through task_set_deps so task_next resolves.
5. Track: set the handoff block (handoff_set), then run session_log_add. Every later session starts with overview + handoff_get + task_next + fact_search.

Never keep plan, task or decision state in chat — the store is the lookup.`
}
