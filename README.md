# mcp-project-memory

Universal **AI task and plan execution harness**: a dockerized MCP server that stores the cross-session state of an AI-built project in SQLite and serves it as MCP tools — tasks with dependencies, an append-only decisions log (stable doc-style numbers), an append-only session log, a structured handoff block, a sectioned plan, a **knowledge base** (append-only facts with full-text search, linked into a project graph), a mandatory **pre-work readiness drill** (restate → quote the AC → cite refs → freeze scope → name proving commands), and a mandatory **adversarial code-review gate** (hunt → refute → fix → re-review → verify) that refuses to mark a task done without a verified review. Everything the `AGENTS.md` → `PLAN.md` / `PROGRESS.md` / `TASKS.md` workbook does for humans, in a form AI sessions cannot corrupt: no giant markdown rewrites, no broken tables, no rewritten log history — every update is one small validated tool call.

The kit also carries the **work-planning skill** (`skill/work-planning/SKILL.md`) — the methodology distilled from a real kickoff: research → verified plan → session-ready tasks → living tracker → reiteration passes. The skill is the _method_, the MCP server is the _state_; together they make any repo AI-session-ready.

## Why

Markdown trackers fail with AI sessions in predictable ways:

| Failure mode                                                                         | Harness answer                                                                                                                                                                             |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Session rewrites a 100+ line PROGRESS page, loses formatting, breaks tables          | Status flips are one-line updates against SQLite; `overview` builds the dashboard                                                                                                          |
| "Append-only log sections" get trimmed or renumbered anyway                          | `session_log_add` / `decision_append` have no update or delete path at all; refs are server-allocated (`D1`) and immutable                                                                 |
| Session cannot tell which task is next; re-reads TASKS.md end-to-end                 | `task_next` resolves the dependency graph: first `todo` task whose deps are all done/cancelled, plus why the next one is blocked                                                           |
| Handoff block rewritten beautifully but inconsistently every time                    | `handoff_set` upserts named sections (`last-completed`, `next-up`, `blockers`, `follow-ups`) atomically                                                                                    |
| Long PLAN.md edits — whole-file rewrite to change one section                        | `plan_put` replaces exactly one section by id; `plan_export` renders the whole document when needed                                                                                        |
| Frequently wrong status values (`completed`, `done:`, `in_progress`)                 | Statuses are an enum: `todo / in-progress / blocked / done / cancelled`; `blocked` demands a reason                                                                                        |
| Task reports done after tests pass; nobody reads the diff                            | `review_*` + the `task_update` gate: `done` is refused until a review is verified at the same head, survivors are fixed or waived, fixes are re-reviewed, and checks/coverage are recorded |
| Agent starts work without being able to restate the task, or AC was only paraphrased | `readiness_*` + the `task_update` gate: entering `in-progress` requires a drill whose `acceptance` quotes the task spec verbatim; an edited spec makes the drill stale                     |

## Run

```bash
pnpm install
pnpm build
DATA_DIR=./data pnpm start
```

Production runs in Docker (stdio transport, `node:sqlite` built into Node 22 — zero native deps):

```bash
docker build -t mcp-project-memory .
docker run -i --rm -v mcp-harness-data:/data mcp-project-memory
```

Register in any MCP client (`command: docker, args: [run, -i, --rm, -v, mcp-harness-data:/data, mcp-project-memory]`). Example for the Kilo CLI config:

```json
{
  "mcpServers": {
    "project-memory": {
      "command": "docker",
      "args": ["run", "-i", "--rm", "-v", "mcp-harness-data:/data", "mcp-project-memory"]
    }
  }
}
```

The named volume persists state between sessions; point it at a host directory instead (`-v %CD%/harness-data:/data`) to keep the data next to the repo. Set `DATA_DIR` to relocate the SQLite file inside the container.

`HARNESS_REVIEW_GATE` controls the task completion gate: `enforce` (default) refuses `done` without a verified review, `warn` allows it but flags the task in `review_health`/`overview`, and `off` disables the gate for a legacy store.

`HARNESS_READINESS_GATE` controls the task start gate: `warn` (default) allows `in-progress` but counts missing/stale drills in `overview`, `enforce` refuses the transition until `readiness_set` records a drill that matches the current spec, and `off` disables the check.

## Tools

| Group     | Tool                                                  | Purpose                                                                                                                                                                   |
| --------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tasks     | `task_next`                                           | The protocol pointer: `next`, `ready`, and `blockedOn` (the waiting task + its unmet deps with statuses)                                                                  |
|           | `task_list(status?)`                                  | Board rows, naturally sorted (T2 < T10)                                                                                                                                   |
|           | `task_get(id)`                                        | Full record: spec (long-form goal/scope/AC) + `dependsOn` / `dependents`                                                                                                  |
|           | `task_create`                                         | Append a task; T-numbers auto-allocated unless `id` given; `blocked` requires `blockedReason`                                                                             |
|           | `task_update`                                         | Partial update; free transitions incl. reopen; blocked reason cleared on resume                                                                                           |
|           | `task_delete`                                         | Refuses while depended on unless `force` (document with a decision)                                                                                                       |
|           | `task_set_deps`                                       | Replace the whole dep set; unknown/self/cycle rejected with the cycle path                                                                                                |
| Readiness | `readiness_set`                                       | Pre-work drill: restated goal, `acceptance` quoted verbatim from the spec, existing R/D/F/T refs, explicit out-of-scope, exact proving commands; append-only revisions    |
|           | `readiness_get`                                       | Latest drill + start gate: `readiness-required` when missing, `readiness-stale` when the spec changed, `canStart`                                                         |
| Progress  | `session_log_add`                                     | ONE condensed line, append-only, dated (UTC day by default)                                                                                                               |
|           | `session_log_list`                                    | Chronological tail, filters by session/task                                                                                                                               |
|           | `decision_append`                                     | Append-only D-numbered rules/gotchas; optional `category` (`api-facts`, `process`, `architecture`, `testing`), `taskId`, `supersedes`                                     |
|           | `decision_list` / `decision_get`                      | Newest first; multi-term filter; exact ref                                                                                                                                |
| Reviews   | `review_start`                                        | Open the gate for a task or advance it to a new round (max 3); oracle, reviewer, risk tier, base/head/diff fingerprint                                                    |
|           | `review_record_findings`                              | Hunter candidates only: lens, file:line, claim, concrete failure mode, evidence; fingerprints dedupe across rounds                                                        |
|           | `review_refute`                                       | Skeptic verdicts per candidate (`confirmed/refuted/plausible`); blocker/major need two confirmations; all-clears need evidence too                                        |
|           | `review_resolve`                                      | Close survivors as `fixed` (with class scan), `waived` (decision required), `rejected`, `duplicate`, or `pre-existing`                                                    |
|           | `review_check` / `review_coverage`                    | Executable evidence (command + exit code) and per-lens coverage (files examined, clean/findings)                                                                          |
|           | `review_close`                                        | Verify: every candidate answered, fixes re-reviewed, current-round checks green, required lenses covered, head matches; or close `exempt`/`escalated`                     |
|           | `review_get` / `review_list`                          | Full review (findings, refutations, checks, coverage, gate) or the newest reviews                                                                                         |
|           | `review_health`                                       | Gate hygiene: open/stale reviews, unrefuted findings, waivers without decisions, done-without-review, coverage gaps                                                       |
| Handoff   | `handoff_get` / `handoff_set`                         | Named sections of the Current-handoff block; whole-body upsert, empty body deletes                                                                                        |
| Plan      | `plan_list` / `plan_get` / `plan_put` / `plan_delete` | Sectioned plan; `plan_put` inserts behind an `after` anchor on create                                                                                                     |
|           | `plan_export`                                         | Full markdown rendering of the plan                                                                                                                                       |
| Meta      | `overview`                                            | The one-call dashboard (counts, sets, next resolution, handoff, latest decisions/log, plan size, knowledge size by kind + health counts)                                  |
|           | `search`                                              | Substring search across tasks/decisions/plan **plus ranked FTS5 search over facts**, with snippets                                                                        |
| Knowledge | `fact_add`                                            | Append-only F-numbered `gotcha`/`api-fact`/`insight`/`note`; `origin` (user/agent), `confidence`, validity window, `supersedes`, inline `links`; warns on near-duplicates |
|           | `fact_get(ref)`                                       | One fact + every typed link touching it + full confirmation history (`lastConfirmedAt`)                                                                                   |
|           | `fact_confirm(ref, note?)`                            | Re-stamp a fact as still true when re-observed — appends a confirmation, never edits content                                                                              |
|           | `fact_search`                                         | Ranked FTS5/bm25 (porter-stemmed, paraphrase-tolerant), provenance-weighted; filters kind/origin/task/entity; `limit`+`offset` paging; hides superseded+expired           |
|           | `fact_link` / `fact_unlink`                           | Typed relations between `fact`/`decision`/`task`/`plan`/`entity` nodes; entities auto-created; idempotent                                                                 |
|           | `fact_neighbourhood`                                  | Walk the knowledge graph from a node (depth 1–5, both/out/in) for impact questions                                                                                        |
|           | `fact_health`                                         | Hygiene report: orphan facts, duplicate-title pairs, unused entities, facts stale for 90+ days (counts also in `overview`)                                                |
|           | `entity_merge(from, to)`                              | Fold an alias entity into another: every link moves atomically, duplicates collapse, the source is deleted                                                                |
| Porting   | `harness_export`                                      | Read-only full-store dump (format tag, schemaVersion, every raw row) for backups and cross-project moves                                                                  |
|           | `harness_import(data, mode)`                          | Restore a dump: `replace` (wipe first) or `merge` (skip conflicts); schema-version-checked and applied in one transaction                                                 |

Resources: `harness://overview`, `harness://tasks`, `harness://tasks/{id}`, `harness://handoff`, `harness://decisions`, `harness://facts`, `harness://facts/{ref}`, `harness://reviews`, `harness://reviews/{ref}`, `harness://session-log`, `harness://plan` (markdown).

Prompts: `session-start` (the read-before-write ritual: `overview` → `handoff_get` → `task_next` → `fact_search`, with an optional focus area and the review-gate reminder), `readiness-brief` (the four-question pre-work drill with the task spec, requirements and decision refs rendered for `readiness_set`), `plan-from-requirements` (harvest → probe → plan → tasks → tracker, per the skill), `plan-review` (the **goldfish** input: the plan document alone, framed for a reviewer spawned without the conversation that wrote it), `drift-report` (stale facts + the re-verify/supersede protocol against live code), `code-review` (the hunter brief), `review-refute` (one candidate, claim + evidence only), `review-triage` (fix survivors, class scan, re-review), `review-recap` (human-readable review report), and `task-completion` (the mandatory end-of-task ritual).

## Field limits

Every write tool validates its inputs and rejects over-long values with an `invalid: … must not exceed N characters` error. The same limits are declared in each tool's MCP input schema (per-field `description`) and tool description, so agents can see them before calling instead of discovering them by error. Limits are measured on the trimmed value.

| Tool / field                              | Limit                                        |
| ----------------------------------------- | -------------------------------------------- |
| `task_create` / `task_update` `title`     | ≤ 200 chars, non-empty                       |
| `task_create` / `task_update` `spec`      | ≤ 20000 chars                                |
| `task_update` `headSha` / `diffHash`      | ≤ 200 chars                                  |
| task `id`                                 | T-number or lowercase slug, ≤ 48 chars       |
| `session_log_add` `session`               | ≤ 80 chars, non-empty                        |
| `session_log_add` `outcome`               | ≤ 300 chars, non-empty (one line)            |
| `decision_append` `title`                 | ≤ 160 chars, non-empty                       |
| `decision_append` `body`                  | ≤ 8000 chars, non-empty                      |
| `decision_append` `category`              | ≤ 40 chars                                   |
| `handoff_set` `name`                      | ≤ 48 chars (letters/digits/space/`./-`)      |
| `handoff_set` `body`                      | ≤ 4000 chars (empty deletes)                 |
| `plan_put` `id`                           | lowercase slug, ≤ 64 chars                   |
| `plan_put` `title`                        | ≤ 120 chars, non-empty                       |
| `plan_put` `content`                      | ≤ 50000 chars                                |
| `fact_add` `title`                        | ≤ 160 chars, non-empty                       |
| `fact_add` `body`                         | ≤ 8000 chars, non-empty                      |
| `fact_confirm` `note`                     | ≤ 200 chars                                  |
| `fact_link` / `fact_unlink` `rel`         | lowercase-hyphen slug, ≤ 40 chars            |
| entity name (`entity:…`)                  | ≤ 120 chars                                  |
| `search` / `fact_search` `query`          | ≤ 120 chars                                  |
| review `ref`                              | `CR` + number (e.g. `CR12`)                  |
| `review_start` `oracle`                   | ≤ 20000 chars, non-empty for non-exempt      |
| `review_start` `changedPaths`             | ≤ 500 paths, each ≤ 500 chars                |
| `review_close` `summary`                  | ≤ 4000 chars (required for exempt/escalated) |
| finding `title`                           | ≤ 200 chars, non-empty                       |
| finding `claim`                           | ≤ 1000 chars, non-empty                      |
| finding `failureMode`                     | ≤ 2000 chars, non-empty                      |
| finding `evidence`                        | ≤ 4000 chars, non-empty                      |
| finding `classKey` / `classScan`          | ≤ 80 / 2000 chars                            |
| refutation `reasoning` / `killStrategy`   | ≤ 4000 / 500 chars                           |
| `review_check` `name` / `command`         | ≤ 80 / 1000 chars                            |
| `review_check` `outputExcerpt`            | ≤ 4000 chars                                 |
| `review_coverage` `filesExamined`         | ≤ 2000 chars                                 |
| `readiness_set` `goal`                    | ≤ 500 chars, non-empty                       |
| `readiness_set` `acceptance`              | ≤ 4000 chars; must quote the task spec       |
| `readiness_set` `serves`                  | ≤ 20 refs, each ≤ 120 chars                  |
| `readiness_set` `outOfScope` / `commands` | ≤ 20 entries each, ≤ 500 chars per entry     |

Numeric ranges (`limit`, `offset`, `depth`, `confidence`) are enforced in the schema itself (`min`/`max`). The canonical numbers live in `src/util.ts` (`MAX_*` constants).

## Knowledge base (facts + graph)

The knowledge base is a property graph **inside the same SQLite file** — no vector DB, no graph DB, no new dependencies (FTS5 and recursive CTEs are built into `node:sqlite`).

- **Facts vs decisions**: `decision_append` records _binding rules/choices_ (rationale + rejected alternative). `fact_add` records _observations_ — gotchas, measured API behavior, insights, notes — and links them to the things they are about. Don't duplicate a decision as a fact; link them (`fact:F1 —recorded-as→ decision:D5`).
- **Provenance + staleness**: every fact carries `origin` (user-stated ranks above agent-inferred), `confidence` (0..1), an optional validity window, and `supersedes`. Search hides superseded and expired facts by default, so the base never confidently serves obsolete advice. Facts are append-only with immutable F-refs; retire by superseding, never by editing. When a fact is re-observed, `fact_confirm` re-stamps it instead — confirmation history feeds staleness detection.
- **Graph**: typed links (`affects`, `discovered-in`, `uses`, `about`, `implements`…) connect facts, decisions, tasks, plan sections, and entities (components/files/technologies, auto-created). `fact_neighbourhood` walks it — start at `entity:storage-layer` to see everything known about that component. Links to a task/plan section, and a fact's `taskId`, are cleaned up automatically when that record is deleted. When auto-creation splits an alias apart (`storage` vs `storage-layer`), `entity_merge` folds the nodes back together.
- **Retrieval**: `fact_search` uses FTS5 + bm25 with porter stemming, so "polling" matches "polls" and paraphrase recall works where substring search returns nothing. Consult it before touching a component or repeating an investigation.
- **Hygiene**: `fact_health` reports orphan facts, mutual duplicate-title candidates, unused entities and facts not re-confirmed for 90+ days; the counts ride along in every `overview`. The `drift-report` prompt renders the stale list with the re-verify protocol (confirm / supersede against live code). Clean as you go — supersede duplicates, link or merge orphans, re-confirm what you re-verified.
- **Portability**: `harness_export` dumps every row of the store (schema-versioned); `harness_import` restores it with `replace` or merges it with `merge`, all in one transaction. Use it for backups, for seeding a second project, or for diffing two harnesses.

## Readiness drill (entry gate)

A task is not ready to start because `task_next` named it; it is ready when the agent can restate it in falsifiable terms and show the evidence. The readiness drill is the entry-side sibling of the review gate: same evidence discipline, applied before the first line of code.

The drill answers four questions, each with a stored field:

| Question                    | Field                  | Evidence rule                                                                                                                                                        |
| --------------------------- | ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| What are we doing?          | `goal`                 | One line, in the agent's own words, phrased so it could be proven wrong                                                                                              |
| Is that ok?                 | `acceptance`           | A **verbatim quote from the task spec** (whitespace-insensitive, ≥ 8 chars). A paraphrased or empty AC cannot pass, so the spec must contain testable criteria first |
| Is that what we have to do? | `serves`, `outOfScope` | R/D/F/T refs that must exist in the store, plus explicit non-goals for this task                                                                                     |
| Is this the way we do it?   | `commands`             | The exact checks that will prove the work — the same names the review will record                                                                                    |

- **Append-only revisions.** Every `readiness_set` adds a revision; `readiness_get` returns the latest plus the gate. A task spec edited after the drill is `readiness-stale` (the spec hash no longer matches), so a changed task must be re-briefed.
- **The quote is a structural check, not a vibe.** `acceptance` must appear in the spec after whitespace normalization. That single rule makes "the button exists" and "works correctly" fail before code is written.
- **Policy is explicit.** `HARNESS_READINESS_GATE=warn` (default) allows the transition but counts `missing`/`stale` drills in `overview`; `enforce` refuses `task_update(status:"in-progress")` (including re-asserting it) and `task_create(status:"in-progress")` with `readiness-required`/`readiness-stale`. A spec edit is allowed but marks the drill stale, so the next in-progress write is refused until it is re-recorded; `off` disables the check.
- **Fresh context reads it.** The author writes the drill; the exit-gate reviewer compares it with the actual diff — a drill that claims one thing while the diff does another is a review finding. The `readiness-brief` prompt renders the task spec, the plan requirements and the recent D-refs so the brief is built from store state, not memory.

This is why it is not a self-administered quiz: the value is the durable, machine-checkable artifact plus an independent reader, not the act of asking "did I understand?".

## Adversarial code review gate (red-team gate)

A prompt that says "review the diff" fails in both directions: it misses bugs (one soft pass, no spec) and invents them (plausible findings nobody refuted). The gate separates those jobs and makes the result a state transition the task cannot skip.

```
in-progress
   ↓
review_start        oracle + scope + risk tier (task must be in-progress)
   ↓
HUNTING             fresh finders append candidates; no severity, no fixes
   ↓
REFUTING            skeptics try to kill each candidate; confirmed/refuted/plausible
   ↓
FIXING              only survivors; fix the class, not the line
   ↓
RE-REVIEW           new round, delta scope; fingerprints prevent repeats
   ↓
VERIFIED            review_close + task_update(done, headSha)
```

**Rules the server enforces**

- **One review per task, max 3 rounds.** A new round is refused while candidates are unrefuted or findings are unresolved; round 4 requires escalation, not another automatic pass.
- **Candidates are not findings.** Every candidate needs `file:line`, a claim, a concrete failure mode (state + input → wrong outcome) and quoted evidence. Style/cleanup without a failure mode is rejected.
- **Refutation is a separate phase.** The skeptic sees the claim and evidence, not the finder's reasoning. Blockers/majors need two confirming refuters; a single confirmation leaves the finding `plausible`, so the safe fix can still proceed. Framework/ORM claims must be settled by running code.
- **Fixes need a later round.** A finding marked `fixed` in round N cannot be verified by closing round N; `review_close` refuses until a later round re-reviews the delta. Waivers and rejections are closed with a recorded reason; waivers require a `decision_append` D-ref.
- **Clean is evidence, not silence.** `review_coverage` records the files each lens examined. `review_close` requires correctness for low risk, correctness + tests for medium, and correctness + tests + security for high.
- **The reviewed head is the completed head.** `task_update(done)` requires the same `headSha` that `review_close` verified — and the same `diffHash` when the review recorded one. A new commit (or a changed worktree, when the diff hash is used) is `review-stale` until the delta is reviewed.
- **No silent completion.** `task_create(status:"done")` is refused under `enforce`; the only escapes are a verified review or an explicit `exempt` review with a summary (plus a decision when the risk is medium/high or the review was escalated).

**Risk tiers** — derived from `changedPaths`/`linesChanged` when not passed, not from the author:

| Tier     | Typical change                                                  | Required lenses              | Rigor                                                               |
| -------- | --------------------------------------------------------------- | ---------------------------- | ------------------------------------------------------------------- |
| `low`    | docs, copy, additive behind a flag                              | correctness                  | one finder, one refuter                                             |
| `medium` | ordinary product code                                           | correctness, tests           | fresh context                                                       |
| `high`   | auth, billing, migrations, CI, infra, public schema, >800 lines | correctness, tests, security | fresh context + 2-of-3 on blockers/majors + human/decision sign-off |

**Trust boundary**: the server cannot spawn reviewers or read the diff. It enforces that a structurally complete review artifact exists, matches the declared head, covers the required lenses, and has no unresolved survivors — a commitment and audit gate, not a security boundary. Fabricating one should cost more than reviewing. The prompts (`code-review`, `review-refute`, `review-triage`, `review-recap`, `task-completion`) carry the reviewer discipline; `review_health` makes skipped or stale reviews visible.

## The session protocol this implements

1. **Start**: `overview` (dashboard) + `handoff_get` + `task_next` — read before writing any code; `fact_search` what is already known about the area you are about to touch. Then run the readiness drill for the named task (`readiness_get` → `readiness_set`, or the `readiness-brief` prompt): restated goal, quoted AC, refs, out-of-scope, proving commands. The server ships this as the `session-start` MCP prompt, so clients that render prompts start on the ritual automatically.
2. **During**: flip task status at every state change; record binding rules with `decision_append` and observations/gotchas with `fact_add` (linked to the relevant task/entity) the moment they are discovered; re-confirm re-observed facts with `fact_confirm`; keep the plan true with `plan_put`.
3. **Before done**: run the project checks; `review_start` with the task AC as the oracle; hunt with fresh-context finders; refute every candidate with isolated skeptics; fix the survivors (or waive with a decision); record checks/coverage; re-review the delta; `review_close`; then `task_update(status:"done", headSha, diffHash)` — the gate refuses the transition otherwise.
4. **End**: `session_log_add` (one line, including the review ref and verdict), refresh `handoff_set` sections — the delta is recorded even if the session dies right after.

## The skill

The methodology lives in `skill/work-planning/SKILL.md`. Edit it here and install into the global skills directory with:

```bash
pnpm skill:install          # copies every skill/ subfolder into ~/.kilocode/skills
pnpm skill:check            # verifies sync without writing (exit 1 = out of sync)
```

Target directory can be overridden with `--dest <dir>` or `KILO_SKILLS_DIR`. Checks and installs are content-verified (byte compare + stale-file detection): a successful install guarantees the destination equals this folder.

## Releasing

Versions live in `package.json` and `src/config.ts` (`SERVER_VERSION`) — bump both. The changelog is `CHANGELOG.md` (Keep a Changelog format).

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm build
git tag v0.3.0 && git push origin main v0.3.0
docker build -t mcp-project-memory:0.3.0 -t mcp-project-memory:latest .
```

Never push a schema change without a migration entry: `test/migrations.test.ts` upgrades a populated v1 fixture, so an applied-but-untested migration fails the suite. Tool/resource/prompt contract changes show up as a failed `test/contracts` snapshot — review the diff and re-record it deliberately (`pnpm exec vitest run -u test/contracts.test.ts`), because consumers are AI agents that code against that surface.

## Moving this folder out

The package is standalone: its own `package.json` (private, pnpm lockfile), tsconfig (strict, NodeNext, `noEmit` typecheck + build config), Biome config, vitest suite, Dockerfile. It has **no imports from the surrounding repo** — move the folder anywhere and the gates still run:

```bash
pnpm install && pnpm lint && pnpm typecheck && pnpm test && pnpm build
```

One deviation from the parent repo's style: `exactOptionalPropertyTypes` stays off here — the MCP SDK's zod-derived handler args are typed `T | undefined` per optional key, and mirroring that inside every repository input type adds ceremony with no behavior change. Everything else (`strict`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`) is untouched.

Design notes: append-only invariants live in the API surface (no mutation tools for logs, immutable D-refs and F-refs); statuses and fact kinds/origins are CHECK-constrained in SQLite, and `facts.supersedes` format is enforced by a schema-level trigger (migration 3); the review gate is migration 4 (`reviews`, `review_findings`, `review_refutations`, `review_checks`, `review_coverage`), with phases and statuses CHECK-constrained, per-task rounds capped in the repository, and a `tasks_ad_reviews` trigger that abandons an open review when its task is deleted; the readiness drill is migration 5 (`readiness_checks`, append-only revisions with a spec hash, cascading on task delete); ref allocation runs inside `BEGIN IMMEDIATE` with a unique-violation retry, so two writers cannot mint the same ref; the plan/handoff use fractional/ordering columns so insertions between sections stay O(1); facts are indexed by an FTS5 external-content table (porter tokenizer) kept in sync by triggers, and the knowledge graph is traversed with recursive CTEs — all inside the one SQLite file, zero native deps; entities are never garbage-collected (unlinking removes the edge, not the node — `entity_merge` folds aliases); the dev workflow runs the exact same server through `tsx` (`pnpm dev` → stdio watch mode) with `DATA_DIR` pointing wherever the consuming repo wants.
