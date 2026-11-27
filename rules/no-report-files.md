# No ad-hoc report files — the store is the report

- Never create per-task or per-session delivery reports, acceptance reports, summaries, or tracking files as session output. This covers `docs/reports/`, `REPORT.md`, `SUMMARY.md`, `PROGRESS.md`, `PLAN.md`, `TASKS.md`, and similar names.
- When the project-memory MCP is connected, record the same content there instead: `session_log_add` for the one-line outcome, `fact_add` linked to the task for the full evidence, `handoff_set` for next-session state, `decision_append` for binding rules.
- Create a markdown file only when the user explicitly asks for that file, or a task acceptance criterion names the exact path and a project script generates it. Machine-generated artifacts are allowed; hand-written ones are not.
- When planning, do not write "report committed" as an acceptance criterion for a hand-written file; require store evidence instead.