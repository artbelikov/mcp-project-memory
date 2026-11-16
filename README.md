# mcp-project-memory

Universal **AI task and plan execution harness**: a dockerized MCP server that stores the cross-session state of an AI-built project in SQLite and serves it as MCP tools — tasks with dependencies, an append-only decisions log (stable doc-style numbers), an append-only session log, a structured handoff block, a sectioned plan, and a **knowledge base** (append-only facts with full-text search, linked into a project graph). Everything the `AGENTS.md` → `PLAN.md` / `PROGRESS.md` / `TASKS.md` workbook does for humans, in a form AI sessions cannot corrupt: no giant markdown rewrites, no broken tables, no rewritten log history — every update is one small validated tool call.

The kit also carries the **work-planning skill** (`skill/work-planning/SKILL.md`) — the methodology distilled from a real kickoff: research → verified plan → session-ready tasks → living tracker → reiteration passes. The skill is the _method_, the MCP server is the _state_; together they make any repo AI-session-ready.

## Why

Markdown trackers fail with AI sessions in predictable ways:

| Failure mode                                                                | Harness answer                                                                                                                   |
| --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Session rewrites a 100+ line PROGRESS page, loses formatting, breaks tables | Status flips are one-line updates against SQLite; `overview` builds the dashboard                                                |
| "Append-only log sections" get trimmed or renumbered anyway                 | `session_log_add` / `decision_append` have no update or delete path at all; refs are server-allocated (`D1`) and immutable       |
| Session cannot tell which task is next; re-reads TASKS.md end-to-end        | `task_next` resolves the dependency graph: first `todo` task whose deps are all done/cancelled, plus why the next one is blocked |
| Handoff block rewritten beautifully but inconsistently every time           | `handoff_set` upserts named sections (`last-completed`, `next-up`, `blockers`, `follow-ups`) atomically                          |
| Long PLAN.md edits — whole-file rewrite to change one section               | `plan_put` replaces exactly one section by id; `plan_export` renders the whole document when needed                              |
| Frequently wrong status values (`completed`, `done:`, `in_progress`)        | Statuses are an enum: `todo / in-progress / blocked / done / cancelled`; `blocked` demands a reason                              |

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
| Progress  | `session_log_add`                                     | ONE condensed line, append-only, dated (UTC day by default)                                                                                                               |
|           | `session_log_list`                                    | Chronological tail, filters by session/task                                                                                                                               |
|           | `decision_append`                                     | Append-only D-numbered rules/gotchas; optional `category` (`api-facts`, `process`, `architecture`, `testing`), `taskId`, `supersedes`                                     |
|           | `decision_list` / `decision_get`                      | Newest first; multi-term filter; exact ref                                                                                                                                |
| Handoff   | `handoff_get` / `handoff_set`                         | Named sections of the Current-handoff block; whole-body upsert, empty body deletes                                                                                        |
| Plan      | `plan_list` / `plan_get` / `plan_put` / `plan_delete` | Sectioned plan; `plan_put` inserts behind an `after` anchor on create                                                                                                     |
|           | `plan_export`                                         | Full markdown rendering of the plan                                                                                                                                       |
| Meta      | `overview`                                            | The one-call dashboard (counts, sets, next resolution, handoff, latest decisions/log, plan size, knowledge-base size by kind)                                             |
|           | `search`                                              | Substring search across tasks/decisions/plan **plus ranked FTS5 search over facts**, with snippets                                                                        |
| Knowledge | `fact_add`                                            | Append-only F-numbered `gotcha`/`api-fact`/`insight`/`note`; `origin` (user/agent), `confidence`, validity window, `supersedes`, inline `links`; warns on near-duplicates |
|           | `fact_get(ref)`                                       | One fact + every typed link touching it                                                                                                                                   |
|           | `fact_search`                                         | Ranked FTS5/bm25 (porter-stemmed, paraphrase-tolerant), provenance-weighted; filters kind/origin/task/entity; hides superseded+expired                                    |
|           | `fact_link` / `fact_unlink`                           | Typed relations between `fact`/`decision`/`task`/`plan`/`entity` nodes; entities auto-created; idempotent                                                                 |
|           | `fact_neighbourhood`                                  | Walk the knowledge graph from a node (depth 1–5, both/out/in) for impact questions                                                                                        |

Resources: `harness://overview`, `harness://tasks`, `harness://tasks/{id}`, `harness://handoff`, `harness://decisions`, `harness://facts`, `harness://session-log`, `harness://plan` (markdown).

## Knowledge base (facts + graph)

The knowledge base is a property graph **inside the same SQLite file** — no vector DB, no graph DB, no new dependencies (FTS5 and recursive CTEs are built into `node:sqlite`).

- **Facts vs decisions**: `decision_append` records _binding rules/choices_ (rationale + rejected alternative). `fact_add` records _observations_ — gotchas, measured API behavior, insights, notes — and links them to the things they are about. Don't duplicate a decision as a fact; link them (`fact:F1 —recorded-as→ decision:D5`).
- **Provenance + staleness**: every fact carries `origin` (user-stated ranks above agent-inferred), `confidence` (0..1), an optional validity window, and `supersedes`. Search hides superseded and expired facts by default, so the base never confidently serves obsolete advice. Facts are append-only with immutable F-refs; retire by superseding, never by editing.
- **Graph**: typed links (`affects`, `discovered-in`, `uses`, `about`, `implements`…) connect facts, decisions, tasks, plan sections, and entities (components/files/technologies, auto-created). `fact_neighbourhood` walks it — start at `entity:storage-layer` to see everything known about that component. Links to a task/plan section, and a fact's `taskId`, are cleaned up automatically when that record is deleted.
- **Retrieval**: `fact_search` uses FTS5 + bm25 with porter stemming, so "polling" matches "polls" and paraphrase recall works where substring search returns nothing. Consult it before touching a component or repeating an investigation.

## The session protocol this implements

1. **Start**: `overview` (dashboard) + `handoff_get` + `task_next` — read before writing any code; `fact_search` what is already known about the area you are about to touch.
2. **During**: flip task status at every state change; record binding rules with `decision_append` and observations/gotchas with `fact_add` (linked to the relevant task/entity) the moment they are discovered; keep the plan true with `plan_put`.
3. **End**: `session_log_add` (one line), refresh `handoff_set` sections, flip the task status — the delta is recorded even if the session dies right after.

## The skill

The methodology lives in `skill/work-planning/SKILL.md`. Edit it here and install into the global skills directory with:

```bash
pnpm skill:install          # copies every skill/ subfolder into ~/.kilocode/skills
pnpm skill:check            # verifies sync without writing (exit 1 = out of sync)
```

Target directory can be overridden with `--dest <dir>` or `KILO_SKILLS_DIR`. Checks and installs are content-verified (byte compare + stale-file detection): a successful install guarantees the destination equals this folder.

## Moving this folder out

The package is standalone: its own `package.json` (private, pnpm lockfile), tsconfig (strict, NodeNext, `noEmit` typecheck + build config), Biome config, vitest suite, Dockerfile. It has **no imports from the surrounding repo** — move the folder anywhere and the gates still run:

```bash
pnpm install && pnpm lint && pnpm typecheck && pnpm test && pnpm build
```

One deviation from the parent repo's style: `exactOptionalPropertyTypes` stays off here — the MCP SDK's zod-derived handler args are typed `T | undefined` per optional key, and mirroring that inside every repository input type adds ceremony with no behavior change. Everything else (`strict`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`) is untouched.

Design notes: append-only invariants live in the API surface (no mutation tools for logs, immutable D-refs and F-refs); statuses and fact kinds/origins are CHECK-constrained in SQLite; the plan/handoff use fractional/ordering columns so insertions between sections stay O(1); facts are indexed by an FTS5 external-content table (porter tokenizer) kept in sync by triggers, and the knowledge graph is traversed with recursive CTEs — all inside the one SQLite file, zero native deps; entities are never garbage-collected (unlinking removes the edge, not the node); the dev workflow runs the exact same server through `tsx` (`pnpm dev` → stdio watch mode) with `DATA_DIR` pointing wherever the consuming repo wants.
