# Changelog

All notable changes to this project are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.0] - 2026-11-26

### Added

- **Adversarial code review gate**: `review_start`, `review_record_findings`, `review_refute`,
  `review_resolve`, `review_check`, `review_coverage`, `review_close`, `review_get`,
  `review_list`, and `review_health` — a per-task hunt → refute → fix → re-review → verify
  state machine capped at three rounds.
- `task_update(done)` now refuses completion without a verified review at the same `headSha`
  (and `diffHash` when recorded), or an explicit exempt/escalated review, and
  `task_create(status:"done")` is refused under the gate. Reopening a done task invalidates
  its review and forces a new round. `HARNESS_REVIEW_GATE=enforce|warn|off` (default
  `enforce`) controls the policy.
- Separate refutation phase: every candidate needs `file:line`, a claim, a concrete failure
  mode and evidence; skeptics see the claim/evidence only; blockers/majors need two
  confirmations; refuted candidates never consume fix effort.
- Convergence controls: fingerprints dedupe findings across rounds, fixes require a later
  re-review round, current-round checks and per-lens coverage are required before close, and
  round 4 is refused in favour of escalation.
- Risk tiers derived from `changedPaths`/`linesChanged` (low/medium/high/exempt) with
  required lens coverage; waiver/rejection requires a recorded decision where risk demands it.
- MCP prompts `code-review`, `review-refute`, `review-triage`, `review-recap`, and
  `task-completion`; `session-start` now includes the gate reminder.
- Resources `harness://reviews` and `harness://reviews/{ref}`; `overview` gained a `reviews`
  block and `review_health` reports open/stale reviews, unrefuted findings, waivers without
  decisions, done-without-review tasks and coverage gaps.
- Migration 4: `reviews`, `review_findings`, `review_refutations`, `review_checks`,
  `review_coverage`, plus the `tasks_ad_reviews` cleanup trigger.
- `harness_export` / `harness_import` carry the review tables; the dump schema version is 4.

### Changed

- `task_get` and `harness://tasks/{id}` include a compact `review` summary.
- Work-planning skill gained the **red-team gate** section and an updated definition of done.

## [0.2.0] - 2026-11-16

### Added

- **Knowledge base**: append-only F-numbered facts (`fact_add`, `fact_get`, `fact_search`,
  `fact_link`, `fact_unlink`, `fact_neighbourhood`) with FTS5 full-text search, provenance
  (origin/confidence/validity/supersedes), and a typed entity graph — in the same SQLite file.
- `fact_confirm` re-stamps a fact as still true when re-observed; confirmation history is served
  by `fact_get` and the `harness://facts/{ref}` resource and drives staleness detection.
- `fact_health` reports orphan facts, duplicate-title pairs, unused entities and stale facts
  (90+ days without confirmation); counts are surfaced in every `overview`.
- `entity_merge` folds an alias entity into another, rewiring all links atomically.
- `harness_export` / `harness_import`: schema-versioned full-store dump with transactional
  `replace` (restore) and `merge` (skip-conflicts) import modes.
- MCP prompts `session-start` (read-before-write ritual), `plan-from-requirements`
  (work-planning kickoff), `plan-review` (goldfish input: the plan document alone for a
  fresh reviewer with no conversation history), and `drift-report` (stale facts + the
  re-verify/supersede protocol against live code).
- Work-planning skill: the **goldfish gate** (fresh-context plan review before any
  implementation session, findings triaged into the store) and the **spec bridge**
  (design docs are inputs; approval and ingestion land via `plan_put` / `decision_append`).
- Resource template `harness://facts/{ref}` for reading a single fact; `fact_search` pagination
  via `limit` + `offset`.
- Migration 3: `fact_confirmations` table and a schema-level constraint that rejects malformed
  `facts.supersedes` refs.
- Test coverage for protocol contracts (`test/contracts` snapshot), migration upgrades from a
  populated v1 fixture, FTS index integrity, and fast-check property tests (ref allocation,
  search fuzzing, graph BFS).

### Changed

- Ref allocation (facts and decisions) now runs inside the write transaction with a
  unique-violation retry, closing the multi-process ref collision race.
- `overview` gained `facts.health` counts.
- `fact_get` now returns `confirmations` and `lastConfirmedAt` alongside the fact and links.

## [0.1.0] - 2026-11-15

### Added

- Initial release: SQLite-backed harness served as MCP tools and resources — tasks with
  dependencies, append-only decisions log and session log, handoff block, sectioned plan,
  overview/search meta tools — plus the work-planning skill and a Docker image.
