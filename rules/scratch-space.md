# Scratch space — temp folder + project-memory MCP, never the workspace

- Durable artifacts (plans, tasks, decisions, probe findings, handoff, session notes) go into the project-memory MCP store (`plan_*`, `task_*`, `decision_append`, `fact_add`, `handoff_set`, `session_log_add`) — never into ad-hoc files in the repo.
- Executable scratch (probe scripts, drill .env files, captured outputs, screenshots) goes only under `C:\Users\abeli\AppData\Local\Temp\kilo\<short-name>\`. Never create scratch folders (`kilo/`, `tmp/`, `probe/`, `tNNN/`, ...) inside the workspace.
- The temp folder is pre-approved: do not ask the user for permission or confirmation for routine scratch work there — just do it.
- Record what a probe proved as a linked `fact_add` immediately; the raw output file is disposable. Delete your scratch subfolder when the work is done unless the user asked to keep it.
