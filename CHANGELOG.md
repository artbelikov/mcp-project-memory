# Changelog

All notable changes to this project are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
