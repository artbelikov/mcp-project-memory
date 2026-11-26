import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import {
  type ReviewDetail,
  type ReviewFindingDetail,
  requiredLenses,
} from '../repositories/reviews.js'
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

  server.registerPrompt(
    'code-review',
    {
      title: 'Fresh-context code review',
      description:
        'The hunter brief for a task review: task spec, oracle, scope, risk tier and lens checklists, framed for a reviewer spawned without the conversation that wrote the code. Record candidates only; fixes and severity come later.',
      argsSchema: { taskId: z.string(), lens: z.string().optional() },
    },
    (args: { taskId: string; lens?: string }) => ({
      messages: [
        {
          role: 'user',
          content: { type: 'text', text: codeReviewText(store, args.taskId, args.lens) },
        },
      ],
    }),
  )

  server.registerPrompt(
    'review-refute',
    {
      title: 'Refute one review finding',
      description:
        'The skeptic brief for one candidate: claim, evidence and scope only — not the finder’s reasoning. Try to kill it, then record a verdict with review_refute.',
      argsSchema: { reviewRef: z.string(), findingId: z.string() },
    },
    (args: { reviewRef: string; findingId: string }) => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: refuteText(store, args.reviewRef, args.findingId),
          },
        },
      ],
    }),
  )

  server.registerPrompt(
    'review-triage',
    {
      title: 'Triage the surviving findings',
      description:
        'Render the confirmed/plausible findings and the fix protocol: fix the class, record waivers as decisions, re-review the delta, then close.',
      argsSchema: { reviewRef: z.string() },
    },
    (args: { reviewRef: string }) => ({
      messages: [
        {
          role: 'user',
          content: { type: 'text', text: triageText(store, args.reviewRef) },
        },
      ],
    }),
  )

  server.registerPrompt(
    'review-recap',
    {
      title: 'Review recap',
      description:
        'Render one review as a human-readable report: verdict, rounds, findings by status, checks, coverage and the remaining gate blockers.',
      argsSchema: { reviewRef: z.string() },
    },
    (args: { reviewRef: string }) => ({
      messages: [
        {
          role: 'user',
          content: { type: 'text', text: recapText(store, args.reviewRef) },
        },
      ],
    }),
  )

  server.registerPrompt(
    'task-completion',
    {
      title: 'Task completion ritual',
      description:
        'The mandatory end-of-task sequence: run checks, start the review, hunt, refute, fix survivors, re-review the delta, close the gate, then mark the task done with the head SHA.',
      argsSchema: { taskId: z.string() },
    },
    (args: { taskId: string }) => ({
      messages: [
        {
          role: 'user',
          content: { type: 'text', text: taskCompletionText(store, args.taskId) },
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
6. Flip task status to in-progress the moment you start, and keep plan_put honest as you learn.
7. Before marking any task done, close its adversarial review gate: run the project checks, start review_start, complete the hunt/refute/fix/re-review rounds, then task_update with the reviewed headSha. The gate refuses done without a verified review.${focusLine}

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

function codeReviewText(store: HarnessStore, taskId: string, lens: string | undefined): string {
  let task: ReturnType<HarnessStore['tasks']['get']>
  try {
    task = store.tasks.get(taskId)
  } catch {
    return `Task "${taskId}" does not exist. Call task_list and use a real task id.`
  }
  const review = store.reviews.findByTask(taskId)
  if (review === null) {
    return `Task ${taskId} — ${task.title} has no review on record. Call review_start({ taskId: "${taskId}", headSha, oracle, reviewer, freshContext: true }) first, then run this brief.`
  }
  if (review.phase === 'verified' || review.phase === 'waived' || review.phase === 'escalated') {
    return `Review ${review.ref} for task ${taskId} is already ${review.phase}. Read it with review_get({ ref: "${review.ref}" }) or the review-recap prompt; do not re-hunt until a new round is started with review_start.`
  }
  if (review.phase === 'refuting') {
    return `Review ${review.ref} is in the refutation phase. Do not add more candidates now: run the review-refute prompt for every finding with status candidate, then resolve the survivors.`
  }
  if (review.phase === 'fixing') {
    return `Review ${review.ref} is in the fixing phase. Run the review-triage prompt, fix or close every confirmed/plausible finding, then start the next round with review_start to verify the delta.`
  }
  const lensFocus = lens
    ? `\nFocus this pass on the "${lens}" lens only; other lenses are covered by parallel reviewers.`
    : ''
  return `You are a fresh-context code reviewer. You did not write this code and you have no conversation history. The task spec, this review record and the repository are your only inputs. Do not propose fixes and do not trust the author.

Task ${task.id} — ${task.title} (${task.status})
Review ${review.ref}, round ${review.round}, risk ${review.risk}
Changed paths: ${review.changedPaths.length === 0 ? '(none recorded — derive the diff yourself from base/head)' : review.changedPaths.join(', ')}
Base: ${review.baseRef ?? review.baseSha ?? '(unrecorded)'}  Head: ${review.headSha ?? '(unrecorded)'}
Required coverage for this risk tier: ${requiredLenses(review.risk).join(', ')}

Oracle — the invariants the code must satisfy, quoted before reading the code:
${review.oracle}

Protocol:
1. Before opening the diff, restate the oracle in your own words. Read the code only after that.
2. Read every changed file and enough surrounding code to know the callers, guards, tests and data constraints.
3. Hunt each required lens. Recall first: every suspicion is a candidate, even if you are unsure.
   - correctness: boundaries (>, >=, zero, empty, max), null vs absent vs zero, enum exhaustion, async ordering, read-modify-write races.
   - security: injection/authorization/secret handling, user-controlled paths, trust boundaries.
   - data: constraints, migrations, backfills, transactionality, soft-delete filters, cross-client writes.
   - tests: new branches untested, boundary values, behavior vs implementation assertions, fixtures that dodge realistic state.
   - conventions: project rules, duplicated domain logic, choke-point bypasses, feature-flag states.
   - blast-radius: callers a symbol grep misses, cache/queue/API compatibility, rollback.
   - over-engineering: code the diff could delete without losing behavior.
   - spec: a requirement the change misses or resolves differently than the oracle says.
4. For every candidate, record file:line, a one-sentence claim, a concrete failure mode (state + input → wrong outcome) and quoted evidence. If you cannot state the triggering input, record a lead, not a finding.
5. Do not assign final severity, do not edit code, do not filter for plausibility — a separate skeptic does that.

Record candidates with review_record_findings({ ref: "${review.ref}", findings: [...] }).${lensFocus}

A clean lens is only credible with review_coverage: record the files you actually examined for each lens, then stop.`
}

function refuteText(store: HarnessStore, reviewRef: string, rawFindingId: string): string {
  const findingId = Number(rawFindingId)
  if (!Number.isSafeInteger(findingId) || findingId < 1) {
    return `"${rawFindingId}" is not a valid numeric finding id. Use review_get({ ref: "${reviewRef}" }) to list ids.`
  }
  let detail: ReviewDetail
  try {
    detail = store.reviews.detail(reviewRef)
  } catch {
    return `Review "${reviewRef}" does not exist.`
  }
  const finding = detail.findings.find((entry) => entry.id === findingId)
  if (finding === undefined) {
    return `Finding ${findingId} is not in ${reviewRef}. Use review_get({ ref: "${reviewRef}" }) to list ids.`
  }
  return `You are the skeptic. You did not write this code and you are not here to agree with the finder. The claim and its cited facts are below; the finder’s reasoning is intentionally absent.

${finding.ref} — ${finding.title}
Lens: ${finding.lens}; severity hint: ${finding.severity}; status: ${finding.status}
File: ${finding.file}:${finding.line}
Claim: ${finding.claim}
Failure mode: ${finding.failureMode}
Evidence: ${finding.evidence}
${finding.classKey === null ? '' : `Bug class: ${finding.classKey}\n`}
Your job is to kill it. Try, in this order:
1. Upstream guard — is the bad state made impossible before this line?
2. Unreachable path — is there a caller, flag or type constraint that prevents the input?
3. Existing test — does a test already pin the behavior, and does it pass?
4. Misread line — is the quoted code actually the code that runs (shadowing, generated code, stale branch)?
5. Author’s best rebuttal — state the strongest case that this is intentional or harmless, then check it.
If the claim depends on framework/ORM/SQL behavior, run code or a query; do not settle it by reading the library docs alone.
Do not propose fixes. Do not accept the claim because it sounds plausible.

Record exactly one verdict with review_refute({ ref: "${reviewRef}", verdicts: [{ findingId: ${finding.id}, refuter, verdict: "confirmed" | "refuted" | "plausible", reasoning, killStrategy, evidence, severity, oneFactThatWouldOverturn, repro }] }).

Refuted means you found a concrete reason it cannot happen. Confirmed means you traced or reproduced the failure. Plausible means one named assumption remains unverified; say what it is. Blocker/major need a second confirming refuter before they become confirmed.`
}

function triageText(store: HarnessStore, reviewRef: string): string {
  let detail: ReviewDetail
  try {
    detail = store.reviews.detail(reviewRef)
  } catch {
    return `Review "${reviewRef}" does not exist.`
  }
  const open = detail.findings.filter((finding) =>
    ['confirmed', 'plausible'].includes(finding.status),
  )
  const fixed = detail.findings.filter((finding) => finding.status === 'fixed')
  const lines =
    open.length === 0 ? 'No surviving findings are open.' : open.map(formatFinding).join('\n\n')
  return `Triage ${reviewRef} (${detail.review.phase}, round ${detail.review.round}, risk ${detail.review.risk}).

Surviving findings:
${lines}

${fixed.length === 0 ? '' : `Already fixed this round: ${fixed.map((finding) => finding.ref).join(', ')}. They still need a later re-review round before close.\n`}
Protocol:
1. For each confirmed or plausible finding, either fix it or close it with a recorded reason. A waiver is a decision: decision_append it first, then review_resolve with status "waived" and the D-number. A rejected finding needs concrete evidence, and blocker/major rejections also need a decision.
2. Fix the class, not the line. For blocker/major fixes, pass classScan describing how every other instance of the bug class was found or cleared.
3. Run the project gates and record them with review_check (exact command + exit code). Red runs are allowed; a later green run of the same name supersedes them.
4. Record the coverage you actually performed with review_coverage for each required lens: ${requiredLenses(detail.review.risk).join(', ')}.
5. When the survivors are closed, call review_start for the next round (max 3). Re-review only the delta plus the fixed areas; fingerprints prevent repeating old findings.
6. Close with review_close and the final headSha, then task_update({ id: "${detail.review.taskId}", status: "done", headSha }).

Never close a finding as fixed without a later re-review round. Never let a plausible blocker disappear without a decision.`
}

function recapText(store: HarnessStore, reviewRef: string): string {
  let detail: ReviewDetail
  try {
    detail = store.reviews.detail(reviewRef)
  } catch {
    return `Review "${reviewRef}" does not exist.`
  }
  const { review } = detail
  const findings =
    detail.findings.length === 0
      ? '- none recorded'
      : detail.findings
          .map(
            (finding) =>
              `- ${finding.ref} [${finding.severity}/${finding.status}] ${finding.title} — ${finding.file}:${finding.line}`,
          )
          .join('\n')
  const checks =
    detail.checks.length === 0
      ? '- none recorded'
      : detail.checks
          .map(
            (check) =>
              `- round ${check.round}: ${check.name} — exit ${check.exitCode} — \`${check.command}\``,
          )
          .join('\n')
  const coverage =
    detail.coverage.length === 0
      ? '- none recorded'
      : detail.coverage
          .map((row) => `- round ${row.round}: ${row.lens} — ${row.result} — ${row.filesExamined}`)
          .join('\n')
  const blockers =
    detail.gate.blockers.length === 0
      ? '- none: the gate allows task completion at the reviewed head'
      : detail.gate.blockers.map((blocker) => `- ${blocker.code}: ${blocker.message}`).join('\n')
  return `# Review ${review.ref} — ${review.verdict ?? review.phase}

- Task: ${review.taskId}
- Round: ${review.round} / 3
- Risk: ${review.risk}
- Phase: ${review.phase}
- Reviewer: ${review.reviewer ?? '(unrecorded)'} (fresh context: ${review.freshContext ? 'yes' : 'no'})
- Head: ${review.headSha ?? '(unrecorded)'}
- Diff: ${review.diffHash ?? '(unrecorded)'}
- Oracle: ${review.oracle}

## Findings
${findings}

## Checks
${checks}

## Coverage
${coverage}

## Gate
${blockers}

## Summary
${review.summary ?? '(none)'}`
}

function taskCompletionText(store: HarnessStore, taskId: string): string {
  let task: ReturnType<HarnessStore['tasks']['get']>
  try {
    task = store.tasks.get(taskId)
  } catch {
    return `Task "${taskId}" does not exist.`
  }
  const review = store.reviews.summaryForTask(taskId)
  const reviewLine =
    review === null
      ? 'No review exists yet. Call review_start after the implementation and project checks are ready.'
      : `Review ${review.ref}, round ${review.round}, phase ${review.phase}, ${review.openFindings} open finding(s), canComplete=${review.canComplete}.`
  return `Complete task ${taskId} — ${task.title} through the adversarial review gate.

${reviewLine}

1. Run the project gates (lint, typecheck, tests, build, security where the repo has it). Capture the exact command and exit code.
2. If the review is not started, call review_start({ taskId: "${taskId}", headSha: <git rev-parse HEAD>, diffHash, changedPaths, oracle, reviewer, freshContext: true }). The oracle is the task’s acceptance criteria, quoted before reading the code.
3. Spawn a fresh-context finder (or one per lens) with the code-review prompt. It records candidates only — no fixes, no final severity.
4. For every candidate, spawn a skeptic with the review-refute prompt. It sees the claim and evidence, not the finder’s reasoning. Blockers/majors need a second confirming refuter.
5. Run the review-triage prompt. Fix every confirmed or plausible finding; fix the class, not the line. Record waivers only with a decision_append decision.
6. Record checks with review_check and coverage with review_coverage for the required lenses.
7. Start the next round with review_start and re-review the delta. Fixes must be verified by a later round; the close will refuse otherwise.
8. Call review_close with the final headSha. Then task_update({ id: "${taskId}", status: "done", headSha: <same SHA> }).
9. Record the outcome in session_log_add and refresh handoff_set before ending.

If the gate blocks, read the exact code in the error: review-required, review-open, review-stale, review-checks, review-lens-missing, review-round-cap. Fix the named gap; do not mark the task done around the gate.`
}

function formatFinding(finding: ReviewFindingDetail): string {
  return `${finding.ref} — ${finding.title} [${finding.severity}, ${finding.status}]
- Lens: ${finding.lens}; file: ${finding.file}:${finding.line}
- Claim: ${finding.claim}
- Failure mode: ${finding.failureMode}
- Evidence: ${finding.evidence}
- Votes: ${finding.votesFor} confirmed / ${finding.votesAgainst} refuted
${finding.rebuttal === null ? '' : `- Last refutation: ${finding.rebuttal}\n`}${finding.oneFactThatWouldOverturn === null ? '' : `- One fact that would overturn: ${finding.oneFactThatWouldOverturn}\n`}`
}
