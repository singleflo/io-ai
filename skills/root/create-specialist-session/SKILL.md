---
name: create-specialist-session
description: Use when asked to create a long-lived specialist child session (e.g. mail manager) with its own repo, AGENTS.md, MCP profile and model recipe.
---

# Create a specialist session

`ORCH="bun /Users/crotti/VSC/TEMP/io-ai/term-ui/orch.ts"`

1. Fix in 3 lines: mission, boundaries (what it NEVER does), MCP servers needed.
2. Run `$ORCH defaults child` and `$ORCH models`; keep the defaults unless the specialist needs a specific `model`, `thinking`, `task` or `smol`.
3. Run `$ORCH spawn --name <name> --purpose "..." --mcp <a,b> --compact 55 --model ... --thinking ... --task ... --smol ...` without `--start`. Its JSON output gives `folder`, `route`, and `peer`.
4. Initialize `<folder>` as its own git repository and edit `<folder>/AGENTS.md`, created from the child template: fill Mission, Boundaries (NEVER), and Domain rules; keep `## Learned rules` and `## Commands`. Put helper scripts in `<folder>/bin/`, write them in TypeScript, and run them with `bun` (NEVER bash or Python scripts).
5. Run `$ORCH start <route>`; poll `$ORCH list` until the child's state is `ready` (max 60 s).
6. Send `REQ-001 · bootstrap` via `peer_request` to the child's `peer`: explore the domain, write `RUNBOOK.md`, PROPOSE (do not run) up to 3 `bin/` scripts for repeated operations, and reply in the PEER-PROTOCOL 4-line format.
7. Refinement loop: repeated error → rule in `## Learned rules`; repeated or long operation → TypeScript script in `bin/`; the child makes each change and commits in its own repo after the root's OK; permissions or risks → ask the user.
