# io-ai — orchestrator workspace

**Scope:** this file governs development of io-ai itself (`term-ui/`, `protocols/`, `presets/`). If your working directory is inside `sandbox/` you are a managed session: ignore this file and follow your protocol and your own `AGENTS.md`.

## Language
- English always for code, identifiers, comments, commit messages, file names, CLI output, API errors, protocols and skills.
- Talk to the user in the user's language (Italian for crotti).
- User-facing UI text never lives in code: add a key to `term-ui/public/i18n/en.json` (source of truth) and the same key to every other locale (`it.json`). Read it with `t("key", { vars })`; static markup uses `data-i18n`, `data-i18n-ph`, `data-i18n-title`, `data-i18n-aria`.
- Key names: `area.thing` in camelCase (`kids.closeAll`, `ov.bad.title`). Do not reuse a key for a different meaning.

## Instructing agents
Applies to every text an agent reads: protocols, skills, sandbox `AGENTS.md`, `--append-system-prompt`, server notices, REQs, peer messages.
- English only. Italian user requests are translated; user-supplied data (names, mail subjects, quotes) stays verbatim in quotes.
- Write for a reader with no conversation: absolute paths, ids, exact commands, the reason for a non-obvious rule.
- Hard rules as `NEVER` / `ONLY` / `MUST` in short bullets; one rule per bullet; no hedging ("maybe", "if possible").
- State scope (act vs propose), boundaries, and a verifiable "Done when".
- REQs follow the template in `protocols/ROOT-PROTOCOL.md` ("Writing instructions").
- Keep it short: an agent re-reads these files every turn, so every line costs tokens in every session.

## Layout
- `term-ui/server.ts` — Bun server: owns every agent PTY, registry, REST + SSE + WebSocket. Single source of session state.
- `term-ui/registry/<name>.json` — one recipe per session (generated `<name>.config.yml` next to it). Edit through the API, not by hand while the server runs.
- `term-ui/orch.ts` — CLI over the API; the only way roots create or manage sessions.
- `term-ui/orch-ext.ts` — omp extension loaded into every session: hello, state, heartbeat, root notices, usage/REQ/MCP-health reports, the `approve` tool gate, `orch_ask_user` (roots).
- `term-ui/store.ts` — SQLite store `<ws>/.orch/orch.db` (events/audit, REQ register, inbox, usage, runs, search index); the only place with SQL.
- `term-ui/core-api.ts` — HTTP handlers of the work layer (inbox, approvals, REQs, usage, activity, search, digest, extension `report-*`).
- `term-ui/token.ts` — server access token `<ws>/.orch/token`. Every request needs it except `GET /login` and `POST /hook/<id>`; `orch url` prints the login URL.
- `term-ui/scrollback.ts` — terminal scrollback persisted in `<ws>/.orch/scrollback/<peer>.log`.
- `term-ui/public/` — single-page UI (`index.html`, `i18n/*.json`), no build step.
- `protocols/` — `ROOT-PROTOCOL.md` / `PEER-PROTOCOL.md`, passed with `--append-system-prompt` at every start.
- `sandbox/` — test roots and children, each its own git repo.

## Rules
- Sessions always resume with `omp -r <sessionId>`; never `-c`.
- Never read the screen to infer agent state: state comes from `orch-ext.ts` events and process exit.
- Never touch sessions outside the registry (e.g. ODOO18, saas-whatsapp).
- TypeScript: no `any`; `Record` for static lookups, `Map`/`Set` for dynamic ones; background work in extensions only via `ctx.setInterval`/`ctx.setTimeout`.
- UI: Operate mode (impeccable skill in `.agents/skills/impeccable`). Colors only from the CSS custom properties in `:root`; status uses the shared `data-h` vocabulary (`ok`, `work`, `warn`, `bad`, `off`); icons are Lucide stroke SVGs, never emoji.
- After a UI change run `.agents/skills/impeccable/scripts/impeccable detect --json term-ui/public/index.html` and look at the rendered page.

## Run
- `bun term-ui/server.ts` (port 8787, `PORT` to override). Stopping the server stops every child; restarting resumes `desired: running` sessions.
- `bun term-ui/orch.ts list` to inspect state.
