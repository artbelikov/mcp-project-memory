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

  server.registerPrompt(
    'plan-review',
    {
      title: 'Fresh-context plan review',
      description:
        'The goldfish input: the plan document alone, framed for a reviewer spawned without the conversation that wrote it.',
      argsSchema: { section: z.string().optional() },
    },
    (args: { section?: string }) => ({
      messages: [
        { role: 'user', content: { type: 'text', text: planReviewText(store, args.section) } },
      ],
    }),
  )

  server.registerPrompt(
    'drift-report',
    {
      title: 'Knowledge drift report',
      description:
        'Render the stale-fact list and the re-verify protocol: compare what the store claims with what the code does right now.',
      argsSchema: { focus: z.string().optional() },
    },
    (args: { focus?: string }) => ({
      messages: [
        { role: 'user', content: { type: 'text', text: driftReportText(store, args.focus) } },
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

function planReviewText(store: HarnessStore, section: string | undefined): string {
  const { scope, document } = renderPlan(store, section)
  return `You are the fresh-eyes reviewer for a design. You have NO prior conversation — you never saw the requirements discussion, the reasoning, or the drafts. Everything you may rely on is the document below and the code it references in this repository. Verify against the code; do not trust the document.

Challenge ${scope} on:

1. Unstated assumptions — anything taken as true without evidence (versions, APIs, data shapes, user behavior).
2. Requirements coverage — requirements the document does not address or resolves differently than stated.
3. Acceptance criteria — non-testable wording, presence-not-behavior checks, or missing criteria for clickable behavior.
4. Fit with the code — files, components or interfaces the plan names that do not exist or work differently than described; read them yourself.
5. Implementation risks — ordering, migrations, concurrency, rollback, scope creep against the deadline.

Output a numbered findings list. Each finding: severity (blocker | major | minor), the exact section, and concrete evidence (file:line or a quote from the document). If a suspected problem is contradicted by the code, cite the code instead of reporting it. End with an explicit verdict: approve, approve-with-changes, or reject.

Review scope: ${scope}

${document}`
}

function renderPlan(
  store: HarnessStore,
  section: string | undefined,
): {
  scope: string
  document: string
} {
  if (section === undefined) {
    return { scope: 'the whole plan', document: store.plan.export() }
  }
  try {
    const planSection = store.plan.get(section)
    return {
      scope: `only the "${section}" section`,
      document: `# ${planSection.title}\n\n${planSection.content}`,
    }
  } catch {
    return {
      scope: 'the whole plan (the requested section was not found)',
      document: store.plan.export(),
    }
  }
}

function driftReportText(store: HarnessStore, focus: string | undefined): string {
  const health = store.facts.health()
  const staleLines =
    health.staleFacts.length === 0
      ? '- none: every fact was re-confirmed within the last 90 days'
      : health.staleFacts
          .map((fact) => `- ${fact.ref} (${fact.daysSince} days): ${fact.title}`)
          .join('\n')
  const focusLine = focus
    ? `\nScope the probes to "${focus}": start from fact_neighbourhood on entity:${focus} and drift-check only the facts reachable from it; report the rest as out of scope.`
    : ''
  return `Run a drift report: compare what the store claims with what the code does right now. Knowledge that used to be true but no longer is the failure mode this catches.

Knowledge health counts: ${JSON.stringify(health.counts)}

Stale facts (not re-confirmed for 90+ days) — re-probe each against the live code or a read-only probe:${staleLines}${focusLine}

For each fact in scope:
1. Re-verify it: read the referenced code or run the probe the fact is about; note the evidence (file:line or probe result).
2. Still true → fact_confirm(ref, note) with that evidence.
3. Changed → fact_add the corrected fact with supersedes pointing at the old ref, carrying the same links; say what changed in the body.
4. Gone or unverifiable → supersede it with a note saying why, rather than leaving it standing.

Also compare the verified-facts plan section with current behavior: drifted entries are fixed with plan_put, and every changed behavior becomes a fact.

Finish with one session_log_add line (confirmed / superseded counts) and fact_health if new problems surfaced.`
}
