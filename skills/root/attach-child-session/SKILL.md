---
name: attach-child-session
description: Use when asked to link an existing folder (and an already-started omp conversation in it) to this root as a child session, instead of creating a new specialist.
---

# Attach an existing folder as a child

`ORCH="bun /Users/crotti/VSC/TEMP/io-ai/term-ui/orch.ts"`

1. Ask the user for the absolute folder path when not given (e.g. `/Users/crotti/VSC/ODOO18`).
2. `$ORCH attach <folder> --parent <your route>` lists the omp conversations already in that folder (id · title · modified). Never attach a conversation another live process is using: check the peers list first.
3. Choose with the user:
   - `--session <id>` resumes that exact conversation (it keeps its history);
   - `--session latest` takes the newest;
   - `--session new` starts a fresh conversation in that folder;
   - `--name <n>` when the folder basename is not a valid session name (a-z, 0-9, -).
4. `$ORCH start <route>` (the output JSON of attach contains `route`). If it reports `open-elsewhere`, the conversation is live somewhere else: do NOT force it, tell the user.
5. Introduce yourself once with `peer_request` (REQ with its "How to reply" block, see ROOT-PROTOCOL) and record the child's `peer` name from `orch list`.

The workspace holds the child's recipe, its own `AGENTS.md` (mission, boundaries) and its outbox in its session folder (`dir` in `orch list`); the attached folder only gets disabled MCP entries in its `.omp/mcp.json`. Several children may attach the same folder (e.g. a developer and a reviewer of /Users/crotti/VSC/ODOO18): write each one's mission in its own `<dir>/AGENTS.md`, never in the attached folder's `AGENTS.md`.
