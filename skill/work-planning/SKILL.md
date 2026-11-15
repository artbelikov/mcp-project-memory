---
name: work-planning
description: >
  End-to-end methodology for kicking off a workstream: turn raw task inputs (notes, PDFs,
  links, chats) into a verified plan, a session-ready task breakdown, and cross-session
  progress tracking plus a universal task-agnostic session prompt. Use when starting a new
  project/feature, when the user asks for a plan, roadmap, decomposition into AI sessions,
  progress tracking between sessions, or a requirements-validation / plan-reiteration pass.
  Covers: input harvesting, web research with local caching, live ground-truth probing,
  requirement mapping, scope tiers, AGENTS.md session protocol, PROGRESS.md living tracker,
  plan reiteration for emergent points, tech-lead self-review, and a per-task UI acceptance
  pass (interactive-element inventory, behavior-first ACs, transient-failure debouncing,
  real-browser walkthrough).
---

# Work planning & task management

Distilled from a real kickoff (Green API messenger test task): research → verified plan →
session-ready tasks → living tracker → reiteration passes. Follow the phases in order; each
ends with a concrete artifact on disk. Principles: **evidence over assumptions** (probe live
systems, don't trust docs blindly), **artifacts over conversation** (everything lands in
files future sessions can read), **scope discipline** (tiers, freezes, one task per session).

## Phase 0 — Harvest inputs (never skip)

1. Collect every task source: chat notes, `followup.txt`-style files, PDFs (if unreadable by
   tooling, say so and ask the user to paste text — do not plan around a document you cannot
   read), URLs, prior conversations.
2. List explicit requirements verbatim, and separate them from user preferences (stack,
   tooling, deploy target, quality bar). Preferences are binding too — record them as
   decisions with owner "user".
3. State unknowns explicitly. If a requirement is ambiguous, resolve by evidence first,
   ask the user second.

## Phase 1 — Research with local caching

1. Fetch authoritative sources for every external system (official docs, API references).
   Save full captures into `<repo>/docs/resources/<system>/*.md` with a header: source URL +
   capture date. Build `docs/RESOURCES.md` — an index table (file → what it covers) plus
   external links and a credentials note.
2. **Ground-truth probe the live system** where safe: read-only endpoints, health checks,
   response-shape sampling, CORS/headers, auth flows. Record results in a "verified facts"
   table with dates. When a live probe contradicts the docs, the probe wins — write the
   conflict down explicitly.
3. If the deliverable is a UI clone of a reference product: obtain real screenshots (mine
   guide articles for image URLs; download them). Read the images yourself and write a
   `visual-spec.md` — layout zones, color tokens, component anatomy, and an explicit
   "do NOT copy" anti-list. Never spec a UI from prose descriptions alone.
4. Verify tooling versions live (`npm view <pkg> version` etc.) before pinning them in the
   plan; check breaking changes for anything ≤1 year old.

## Phase 2 — The plan (`docs/PLAN.md`)

Required sections, in this order:

1. **Requirement-mapping table** — every original requirement (quote it) → implementation →
   evidence it will work → verdict. Nothing invented, nothing missing.
2. **Verified facts** (from Phase 1) — the authoritative environment contract.
3. **Product scope** — tiered: **MVP-1** (maps 1:1 to required demo flow), **MVP-2**
   (credibility additions), **Tier-3** (optional stretch), **Out of scope** (explicit list).
   A demo flow is written as user-visible steps.
4. **Architecture** — diagram + numbered decisions (D1, D2, …) each with rationale and the
   alternative rejected. One paragraph per decision, no essays.
5. **UI/UX spec** — reference the visual spec file; describe screens, states, and behavior.
6. **Testing strategy** — pyramid table: level / tools / target counts / what it covers /
   coverage thresholds. E2E runs against a mock layer, never a live account.
7. **Tooling & quality gates** — package manager, lint/format, hooks, CI pipeline order.
8. **Schedule** — day-by-day or phase-by-phase table mapped to task IDs.
9. **Deployment** — concrete target config (Dockerfile/nginx/env/healthz), not vibes.
10. **Risks table** — risk → mitigation. Include schedule risk and data-privacy risk.
11. **Definition of done** — the observable demo script + submission/delivery checklist.

Rules: scope grows → record as a decision, don't silently absorb; budget from the deadline
backwards; every quality practice must name the phase that pays for it.

## Phase 3 — Task decomposition (`docs/TASKS.md`)

- One task = one AI session. Format per task: `### T<N>. <title>` → **Goal**, **Scope**
  (files), **AC** (acceptance criteria, concrete and testable).
- Global rules block at top: stack pins, protocol pointer, "every task ends with lint /
  typecheck / test / build green + docs updated", secrets rule.
- Dependency graph at the bottom; sessions run strictly sequentially by default (one writer
  of the tracker); mark genuinely parallelizable pairs only if coordination is defined.
- Schedule pressure → cut ceremony (defer hooks/commitlint/dead-code sweeps to a hardening
  task), never cut the demo path or the test pyramid's core.
- Include explicit **quality iterations** (hardening, polish) as first-class tasks.

## Phase 4 — Cross-session tracking

1. **`AGENTS.md`** (repo root) — the binding session contract: _read before starting_
   (AGENTS → PROGRESS → PLAN → current task), _update before ending_ (PROGRESS: task status,
   handoff block, append-only session log + decisions; README if claims changed), hard rules
   (package manager, architecture direction, no comments, strings centralization, secrets
   never committed), workflow (one task per session, branch naming, definition of done).
2. **`docs/PROGRESS.md`** — the living tracker: task board table (task/day/status/branch/
   notes; statuses `todo`/`in-progress`/`blocked:reason`/`done`), **Current handoff** block
   (last completed / next up / blockers / live-system state), append-only **Session log**
   (date, session, worked-on, outcome), append-only **Decisions & gotchas** (numbered, dated,
   one line of rationale). Append-only means: never rewrite history entries.
3. Single-writer rule: the active session owns the tracker until its merge.
4. Update the README whenever setup/scripts/architecture/deployment claims change.
5. **`docs/SESSION-PROMPT.md`** — a universal, task-agnostic session prompt the user pastes
   into every new AI session. Create it in Phase 4 (not per task), commit it, and keep it
   updated only when the protocol itself changes. Requirements for the prompt text:
   - **Self-locating**: it never names the current task. It orders the session to read the
     tracker (`AGENTS.md` → `docs/PROGRESS.md` → `docs/PLAN.md` + the task's section in
     `docs/TASKS.md`), take the task named in the handoff or the first `todo` board row, and
     stop-and-report if everything is done (never invent work).
   - **Resource routing**: point to saved API contracts / visual specs for API and UI tasks.
   - **Scope discipline block**: implement only the assigned task; scope growth → record a
     decision and finish the task as specified; blocked → set `blocked:reason` and end,
     never silently switch tasks.
   - **Definition of done** (lint/typecheck/test/build green, README claims updated, commit
     workflow) and a **before-ending block** (tracker update is part of the task: flip
     status, rewrite handoff, append session log + decisions).
   - **Hard constraints repeated for safety** (package manager, no comments, strings
     centralization, secrets/private files) plus **fresh-clone routing** (no src/ → start
     from the first scaffold task as written).
   - Include a documented **re-run variant**: one extra line for resuming a failed session
     (`The previous session attempted task T<N> but did not finish — check the handoff…`).

## Phase 5 — Reiteration passes (run after the plan exists)

1. **Emergent-point pass**: list everything that came into existence _after_ the plan was
   written (new files, new decisions, probe outputs, tracker files themselves) and check
   whether the plan accounts for each. Typical finds: secrets/PII leaked into docs from
   probes, git-init ordering vs ignored private files, single-writer conflicts on the
   tracker, runtime quirks (background jobs, double-mount, propagation delays).
2. **Requirements-validation pass**: walk each original requirement and each expected-result
   bullet end-to-end through tasks → evidence → verdict. Fix acceptance criteria where the
   live behavior differs from assumptions.
3. **Privacy/PII pass**: redact real identifiers (phones, ids, tokens, wids) from all
   repo-bound docs and fixtures; ensure private files are gitignored **before** `git init`,
   and verify with `git status` before the first commit.
4. **Tech-lead self-review**: critique the plan as the receiving senior — over-engineering
   vs deadline, state-layer weight, scope cuts, demo hygiene for an outside reviewer,
   questions the plan should preempt. Apply the accepted critiques as edits, log as a
   decision.

## Per-task UI acceptance (for any session that ships visible UI)

Real-world audit that surfaced this phase: an AI-built messenger passed lint/typecheck/303
unit tests/e2e/axe, yet the first human walkthrough of the deployed app immediately found
three dead nav buttons, an optically off-center icon, and a status banner that flashed on
every network blip. None of the gates could see those. Run this pass inside every UI task
— it is part of the definition of done, not an afterthought.

1. **Interactive-element inventory.** List every clickable/focusable/label-looking element
   the task ships. Each one must either (a) have its behavior wired at this task, or
   (b) be rendered non-interactively (no `<button>` for decoration), with the reason
   recorded as a decision in the tracker. A control that looks like a button but does
   nothing is a defect — "it's just a label placeholder" is not an acceptable state.
2. **Behavior over presence in AC.** "The button exists in the document" is not an
   acceptance criterion. ACs must assert click-through behavior ("click opens X, X does
   Y") and visible outcome, or they will pass while the feature is broken.
3. **Debounce transient infrastructure failures before user-facing status UI.** Poll
   loops/retries back off by design; mapping the _first_ failure to a user-visible
   "connection lost"/"reconnecting" state turns every blip into an alarm. Escalate only
   after N consecutive failures (or a sustained window), and reset on recovery. Silent
   retry is the default UX; alarm states are reserved for sustained outages.
4. **Real-browser visual walkthrough before merge.** jsdom cannot see centering, optical
   alignment, overflow, or spacing; axe sees semantics, not aesthetics. Before a UI task
   reports done: open the built app (dev or container), click every control, compare the
   screen against the visual spec/screenshot side by side, and fix what a human would
   notice in five seconds. AI-captured screenshots reviewed by the same AI do not count —
   the reviewer is the human who looks at the deploy.
5. **That walkthrough costs nothing to schedule:** fold it into the last task that ships
   UI (a "human checklist" block in the handoff: what to click, what to expect). The user
   should never be the first integration test.

## Anti-patterns (refuse these)

- Planning from a PDF/link without reading it, or from docs alone without a live probe.
- A plan section that names a technology but not the decision and its alternative.
- Acceptance criteria like "works correctly" — must be observable or testable.
- Acceptance criteria that assert element presence ("button renders") instead of behavior
  ("clicking opens the contacts modal and lists instance contacts").
- Shipping interactive-looking controls without behavior, or "decorative" controls without
  a recorded decision saying so.
- Escalating a single transient network failure straight into a user-facing status UI.
- Hooks/commitlint/dead-code tooling on Day 1 of a tight deadline.
- Rewriting tracker history instead of appending.
- Testing against a real user account instead of a mock layer.
- "Minimal UI" that grows features because they were easy — scope freeze means freeze.

## Provenance note

The per-task UI acceptance phase above is distilled from a real audit: an AI-built app
passed every automated gate yet a human walkthrough of the deploy found dead nav buttons,
an off-center icon, and an alarm-happy reconnect banner. Those three failures map 1:1 to
inventory/behavior-AC, visual walkthrough, and debounce rules.
