---
name: work-planning
description: >
  End-to-end methodology for kicking off a workstream: harvest initial requirements from
  whatever the user provides (chat threads, briefs, tickets, emails, TXT/MD/PDF/DOCX files,
  URLs, screenshots, prior sessions), verify them with research and live ground-truth
  probes, produce a plan and a session-ready task breakdown with dependencies, and keep
  cross-session progress tracking. Everything persists through the project-memory MCP
  server (plan sections, task board with dependency graph, decisions log, handoff block,
  session log) — the skill is the method, the MCP server is the state; together they make
  any repo AI-session-ready. Use when starting a new project/feature, when the user asks
  for a plan, roadmap, or decomposition into AI sessions, when requirements need a
  validation or reiteration pass, or when tracking work across sessions.
---

# Work planning & task management

Method for turning a raw task dump into a verified, executable, trackable project. Follow
the phases in order; every phase ends with an artifact written into the **project-memory
MCP store** (via its tools: `plan_*`, `task_*`, `decision_append`, `handoff_set`,
`session_log_add`, `overview`, `search`) — not into chat. Principles: **evidence over
assumptions** (probe live systems, don't trust docs blindly), **artifacts over
conversation** (future sessions read the store, not this chat), **scope discipline**
(tiers, freezes, one task per session). If the MCP server is unavailable, fall back to
file artifacts (PLAN.md / TASKS.md / PROGRESS.md) and say so explicitly.

## Phase 0 — Harvest initial requirements (format-agnostic; never skip)

1. **Inventory the sources.** List every artifact that carries task intent, whatever its
   form: chat threads, briefs, a requirement doc, tickets, emails, plain-text/MD/PDF/DOCX
   files, URLs, screenshots, prior session transcripts, anything the user waved at. State
   the inventory up front so nothing is consumed silently.
2. **Ingest each source.** Read it end-to-end before planning. If tooling can't read an
   artifact (locked/scan-only PDF, image-only, paywall, login wall), say so and ask the
   user to paste the relevant text — never plan around a document you could not read.
3. **Extract requirements verbatim.** Quote every explicit requirement word-for-word and
   tag its source (file/URL/chat + where). Number them (R1, R2, …) so later phases and
   validation passes reference a stable ID instead of a paraphrase.
4. **Separate requirements from preferences.** Stack, tooling, deploy target, quality bar,
   style choices are not requirements but are binding too — keep them in the mapping table
   with type "preference".
5. **Resolve unknowns in order: evidence first, user second.** Check the live system or
   repo before asking; record either outcome. Ambiguity resolved by guessing is a bug.
6. **Persist immediately.** `plan_put` a `requirements` section: source inventory + the
   mapping table (ID → verbatim requirement → type → implementation → evidence → verdict).
   Record binding non-obvious preferences as decisions (`decision_append`) with owner
   "user".

## Phase 1 — Research with local caching

1. Fetch authoritative sources for every external system (official docs, API references).
   Save bulky full captures to `docs/resources/<system>/*.md` with a header: source URL +
   capture date; link the file from a `resources` plan section so sessions can find it
   without re-researching.
2. **Ground-truth probe the live system** where safe: read-only endpoints, health checks,
   response-shape sampling, CORS/headers, auth flows. Write a `verified-facts` plan
   section (fact → how verified → date). When a live probe contradicts the docs, the
   probe wins — write the conflict down explicitly.
3. If the deliverable is a UI clone of a reference product: obtain real screenshots,
   write a `visual-spec.md` (layout zones, color tokens, component anatomy, explicit
   "do NOT copy" anti-list), and reference it from the plan. Never spec a UI from prose
   descriptions alone.
4. Verify tooling versions live (`npm view <pkg> version` etc.) before pinning them; log
   the numbers in `verified-facts`. Check breaking changes for anything ≤1 year old.

## Phase 2 — The plan (lives in the harness plan store)

Build the plan as ordered plan sections (`plan_put`; use the `after` anchor to keep this
order): `requirements` (from Phase 0), `verified-facts`, `scope`, `architecture`,
`ui-spec`, `testing-strategy`, `tooling`, `schedule`, `deployment`, `risks`,
`definition-of-done`. Content per section:

1. **requirements** — the Phase 0 mapping table; nothing invented, nothing missing.
2. **verified-facts** — the authoritative environment contract from Phase 1.
3. **scope** — tiered: **MVP-1** (maps 1:1 to the required demo flow), **MVP-2**
   (credibility additions), **Tier-3** (optional stretch), **Out of scope** (explicit
   list). Write the demo flow as user-visible steps.
4. **architecture** — diagram plus numbered decisions, each with rationale and the
   alternative rejected; full rationale goes to `decision_append`. One line each in the
   section, no essays.
5. **ui-spec** — reference the visual spec file; screens, states, behavior.
6. **testing-strategy** — pyramid table: level / tools / target counts / what it covers.
   E2E runs against a mock layer, never a live account.
7. **tooling** — package manager, lint/format, hooks, CI order.
8. **schedule** — day-by-day or sequence table mapped to task IDs.
9. **deployment** — concrete target config (Dockerfile/nginx/env/healthz), not vibes.
10. **risks** — risk → mitigation; include schedule risk and data-privacy risk.
11. **definition-of-done** — observable demo script + delivery checklist.

Rules: scope grows → record as a decision, don't silently absorb; budget from the
deadline backwards; every quality practice must name the phase that pays for it.

## Phase 3 — Task decomposition (lives in the harness task board)

- One task = one AI session. `task_create` per task: one-line title; the spec carries
  **Goal**, **Scope** (files), **AC** (acceptance criteria — concrete, testable,
  behavior-first for anything clickable).
- Record the global rules once as decisions: stack pins, per-task gates ("lint /
  typecheck / test / build green + docs updated before ending"), secrets never committed,
  centralized strings, no stray comments.
- Wire the sequence with `task_set_deps`. Sessions run strictly sequentially by default
  (one writer of the store); mark genuinely parallelizable pairs only if coordination is
  defined.
- Schedule pressure → cut ceremony (hooks/commitlint/dead-code sweeps become a hardening
  task), never cut the demo path or the test pyramid's core.
- Include explicit **quality iterations** (hardening, polish) as first-class tasks.

## Phase 4 — Cross-session tracking (the store IS the tracker)

1. **Start of every session**: `overview` (dashboard) + `handoff_get` + `task_next` —
   read before writing any code. `task_next` names the work or tells you it's blocked
   and waiting on what.
2. **During**: flip task status at every state change (`task_update`); record durable
   facts as they are discovered (`decision_append`); keep the plan true (`plan_put`).
3. **End**: `session_log_add` (one condensed line), refresh `handoff_set` sections
   (`last-completed`, `next-up`, and `blockers`/`follow-ups` when relevant), flip the
   task status. The delta is recorded even if the session dies right after.
4. The logs are append-only by API — never rewrite history anywhere else either.
5. If the repo also wants a human-readable pointer, keep a minimal `AGENTS.md` that says
   only: read `overview`/`handoff`/`task_next` before starting; update them before
   ending. A `SESSION-PROMPT.md` is optional; if kept, it must be **self-locating**
   (never names the current task; points at the store; stops-and-reports when nothing is
   `todo`; scope growth → decision; re-run variant line for resuming a failed session).

## Phase 5 — Reiteration passes (run after the plan exists)

1. **Emergent-point pass**: list everything that came into existence after the plan was
   written (files, decisions, probe outputs, the store itself) and check the plan
   accounts for each. Typical finds: secrets/PII from probes, git-init ordering vs
   ignored private files, single-writer conflicts, runtime quirks.
2. **Requirements-validation pass**: walk every R-id end-to-end through tasks →
   evidence → verdict. Fix acceptance criteria where live behavior differs from
   assumptions — edits land via `plan_put` / `task_update` / `decision_append`, and are
   logged, never done in chat only.
3. **Privacy/PII pass**: redact real identifiers (phones, ids, tokens) from all
   repo-bound docs and fixtures; ensure private files are gitignored **before**
   `git init`, verified with `git status` before the first commit.
4. **Tech-lead self-review**: critique the plan as the receiving senior —
   over-engineering vs deadline, state-layer weight, scope cuts, demo hygiene. Apply
   accepted critiques as edits and log as a decision.

## Per-task UI acceptance (for any session that ships visible UI)

Real-world audit that found this: an app passed lint/typecheck/unit/e2e/axe yet the first
human walkthrough found dead nav buttons, an off-center icon, and an alarm-happy status
banner. None of the automated gates can see those. Run this pass inside every UI task —
it is part of the definition of done, not an afterthought.

1. **Interactive-element inventory.** List every clickable/focusable/label-looking
   element the task ships. Each one must either (a) have its behavior wired at this task,
   or (b) be rendered non-interactively (no `<button>` for decoration), with the reason
   recorded as a decision. A control that looks like a button but does nothing is a
   defect — "it's just a label placeholder" is not an acceptable state.
2. **Behavior over presence in AC.** "The button exists in the document" is not an
   acceptance criterion. ACs must assert click-through behavior ("click opens X, X does
   Y") and visible outcome, or they will pass while the feature is broken.
3. **Debounce transient infrastructure failures before user-facing status UI.** Poll
   loops/retries back off by design; mapping the _first_ failure to "connection lost" /
   "reconnecting" turns every blip into an alarm. Escalate only after N consecutive
   failures (or a sustained window), reset on recovery. Silent retry is the default UX;
   alarm states are reserved for sustained outages.
4. **Real-browser visual walkthrough before merge.** jsdom cannot see centering, optical
   alignment, overflow, or spacing; axe sees semantics, not aesthetics. Before a UI task
   reports done: open the built app, click every control, compare against the visual
   spec side by side, fix what a human would notice in five seconds. AI-captured
   screenshots reviewed by the same AI do not count — the reviewer is the human who
   looks at the deploy.
5. **The walkthrough costs nothing to schedule:** fold it into the last task that ships
   UI (a "human checklist" block in the handoff via `handoff_set`). The user should
   never be the first integration test.

## Anti-patterns (refuse these)

- Planning from an artifact you never actually read (PDF, link, ticket), or from docs
  alone without a live probe.
- Harvesting requirements only from the format you expected, silently skipping sources
  you couldn't read.
- A plan section that names a technology but not the decision and its alternative.
- Acceptance criteria like "works correctly" — must be observable or testable.
- Acceptance criteria that assert element presence ("button renders") instead of
  behavior ("clicking opens the contacts modal and lists instance contacts").
- Shipping interactive-looking controls without behavior, or "decorative" controls
  without a recorded decision saying so.
- Escalating a single transient network failure straight into a user-facing status UI.
- Hooks/commitlint/dead-code tooling on Day 1 of a tight deadline.
- Writing plan/task/tracking state into chat or one-off files when the harness store is
  connected — sessions after you won't find it.
- "Minimal UI" that grows features because they were easy — scope freeze means freeze.

## Pairing note

The skill and the **project-memory MCP server** ship together: this document is the
_process_, the server is the _single source of truth_ for tasks, plan, decisions,
handoff, and session log, so no session can corrupt them through big rewrites. When a
D-number, R-id, or task ID is referenced in any session, the store is the lookup, not
the chat transcript.
