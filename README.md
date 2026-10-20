# io-ai — an orchestrator of live omp agent sessions

io-ai runs a **workspace of long-lived [omp](https://omp.sh) (Oh My Pi) coding-agent sessions** in your browser: one **root** orchestrator session, its **child** specialist sessions, each in its own terminal, each with its own model, thinking level, MCP servers and skills.

It does not read the screen and it does not guess. The server owns every agent process (PTY), every session's recipe, and reconciles the two: move a session folder with the Finder and the orchestrator follows, `/model` inside a session updates the recipe, a crashed child wakes its root.

```mermaid
flowchart LR
  subgraph browser["Browser (xterm.js)"]
    ui["term-ui page\nroots · child cards · wizard · issues"]
  end
  subgraph server["Bun server (:8787)"]
    pty["PTY spawner"]
    rec["reconcile\ncatalog · drift · orphans"]
    reg["recipes (.orch/session.json)"]
  end
  omp["omp root session"] --- c1["child: mail"] & c2["child: odoo"]
  ui <-- "WebSocket / SSE / REST" --> server
  server --> pty --> omp
  omp <-. "peer_request / peer_send\n(omp-peers plugin)" .-> c1 & c2
```

## What you get

- **A session is a folder.** Anything under the workspace that contains `.orch/session.json` is a session; subfolders are its children (Next.js-style routing). The route is the path (`root-test/mail`), and the peer name follows (`root-test.mail`).
- **Recipes, not flags to remember.** Model, thinking, model roles, compaction, MCP servers, skills: stored per session, applied with `omp -r <id>` at every start. Conversations survive every restart.
- **Root/specialist split.** A root session gets the `ROOT-PROTOCOL` (it may spawn children only through `orch`, respecting quota) and root-only skills like `create-specialist-session`. Children answer with a strict 4-line REQ format.
- **Deterministic drift handling.** `reconcile` runs every few seconds and converges: in-session `/model` and `/thinking` are adopted (with revert), global omp config changes flag `restart-needed`, never auto-restart, hand-moved folders are followed via omp's own `SessionManager.moveTo`, copies lose the session id, deleted folders become orphans you can forget or relink.
- **Health without screen-scraping.** An omp extension reports hello/state/heartbeat; the server sees process exits. Crashes reach the root as `[orch]` notices with a bounded auto-restart policy; stuck sessions are detected by heartbeat.
- **Operate-grade UI.** Live terminals with per-session model selector, working elapsed timers, issue cards with one-click actions, a two-step new-root wizard (mission, model, MCP servers, skills), graceful or forced stop of a whole subtree, archive instead of delete.
- **Cross-platform by design.** Relative paths everywhere, no git dependency, process-tree termination per OS. Terminals are POSIX today; Windows needs a ConPTY backend behind the existing `Pty` interface.

## Prerequisites

| Requirement | Notes |
|---|---|
| **omp** 18.12+ | `brew install can1357/tap/omp` (or npm). Log in to at least one provider (`omp` on first run). |
| **Bun** 1.3.5+ | Runs the server. The omp SDK helper needs 1.4.3+, pulled automatically as a local dependency. |
| **[omp-peers](https://github.com/nikkoxgonzales/omp-peers)** | Cross-session messaging: roots talk to children by peer name. |

Install the peers plugin (then restart any running omp):

```sh
omp plugin marketplace add nikkoxgonzales/omp-peers
omp plugin install omp-peers@omp-peers
```

Verify with `/peers` inside any omp session.

Optional: MCP servers you already have in `~/.omp/agent/mcp.json` (ms365, chrome-devtools, …) are picked up automatically by the catalog and offered per session.

## Quickstart

```sh
git clone https://github.com/singleflo/io-ai.git && cd io-ai
cd term-ui && bun install && cd ..
bun term-ui/server.ts          # default workspace ~/orch, port 8787
open http://127.0.0.1:8787
```

1. **New root** (sidebar) — a two-step wizard: name, mission, model, thinking; then MCP servers and skills (everything on by default; unchecking excludes a skill from that session only).
2. Talk to your root in its terminal. Ask it to create a specialist — it uses the `create-specialist-session` skill, scaffolds the child folder, starts it and sends `REQ-001 · bootstrap`.
3. Children appear as cards on the right: open one, watch its state and working timer, restart it with another model, or stop the whole subtree gracefully.

Environment: `ORCH_HOME` (workspace root, default `~/orch`), `PORT` (default 8787), `--workspace <path>`.

## Workspace layout

```
~/orch/                        the workspace (no git needed)
  .orch/
    catalog.json               snapshot of omp: models, quota, MCP, skills
    known.json                 session ids seen (orphans list)
    skills/{common,root}/      your own skills, injected per role
    templates/{root,child}/    AGENTS.md templates (optional overrides)
  root-test/                   a root session   → route "root-test"
    .orch/session.json         the recipe (id, model, mcp, skills, desired)
    AGENTS.md                  domain rules; inherited by children
    mail/                      a child session  → route "root-test/mail"
  _archive/                    archived subtrees (nothing is ever deleted)
```

`AGENTS.md` files are inherited walking up (like layouts); the root *role* stays in `protocols/ROOT-PROTOCOL.md`, injected with `--append-system-prompt`, so children never see the orchestrator rules.

## The `orch` CLI

Roots (and you) manage sessions only through it:

```sh
bun term-ui/orch.ts list                                   # route · kind · state · peer · issues
bun term-ui/orch.ts spawn --name mail --parent ops --purpose "Mail triage" \
  --model zai/glm-5.3 --mcp ms365 --compact 55 --start
bun term-ui/orch.ts start|stop|restart <route> [--model M --thinking L …]
bun term-ui/orch.ts edit <route> --purpose "…" [--restart]
bun term-ui/orch.ts move <route> --to ops/mail2
bun term-ui/orch.ts archive <route> [--force]             # stop + move under _archive
bun term-ui/orch.ts send <route> "text"
bun term-ui/orch.ts resolve <route> <issue> <action>
bun term-ui/orch.ts models [filter] · usage · catalog [--refresh]
```

Inside a root session the path is already known (`ORCH_ROUTE`), so `--parent` defaults to the root itself.

## Drift policy (what reconcile does)

| Change made outside | Behaviour |
|---|---|
| `/model`, `/thinking` in a session | adopted into the recipe, revert offered |
| omp retry fallback | ignored, shown as `in-fallback` |
| global config / `mcp.json` edit | MCP profiles regenerated, `restart-needed` flagged (never auto-restart) |
| hand-edited `.omp/mcp.json` | asks: keep yours (session becomes `manual`) or overwrite |
| folder moved/renamed by hand | followed: omp file relocated with `moveTo`, same session id |
| `/move` inside a session | the session folder follows the conversation |
| folder copied | the copy loses the id and starts a new conversation |
| folder deleted | orphan listed: forget, or relink to a folder |
| session opened elsewhere (`omp -r` in a terminal) | start refused (`open-elsewhere`), auto-starts when freed |
| omp upgraded | catalog rebuilt; SDK version checked and flagged |

## Development

```sh
cd term-ui
bun install
bun test            # (tests welcome — none yet)
bun run ..          # see package.json scripts
```

Layout: `server.ts` (HTTP/WS/SSE + creation) · `core.ts` (start pipeline, observer, issues) · `reconcile.ts` (convergence loop) · `catalog.ts` (omp snapshot) · `workspace.ts` (folder model) · `pty.ts` (terminals, tree termination) · `omp-sdk.ts` (lease/`moveTo` helper process) · `orch-ext.ts` (extension loaded into every session). UI strings live in `term-ui/public/i18n/*.json`; code, commits and docs are English-only (see `AGENTS.md`).

Verified behaviours live in the session history of this repo's development: resume-by-id with recipe flags, hand-move while running, lease refusal, duplicate ids, global MCP changes, in-session `/move`, subtree graceful stop.

## Credits

- [omp / Oh My Pi](https://github.com/can1357/oh-my-pi) — the agent, its SDK and `SessionManager.moveTo` do the heavy lifting.
- [omp-peers](https://github.com/nikkoxgonzales/omp-peers) — named peer messaging between sessions.
