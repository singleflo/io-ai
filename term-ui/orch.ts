#!/usr/bin/env bun
// orch: CLI over the term-ui API. Prints JSON.
import { basename } from "node:path";
import { readToken } from "./token";
import { workspaceRoot } from "./workspace";
const BASE = process.env.ORCH_URL ?? "http://127.0.0.1:8787";
const token = () => process.env.ORCH_TOKEN ?? readToken(workspaceRoot()) ?? "";
const [command, ...args] = process.argv.slice(2);

const USAGE = `usage: orch <command>
  url   # login URL of the term-ui (open it once in the browser)
  list
  spawn --name N --purpose T [--parent R] [--model M --thinking L --task M --smol M --compact N --mcp a,b|all|manual --skills a,b|all] [--folder /abs/path [--session id|latest|new | --resume]] [--start]
  start R
  stop R
  restart R [--model M --thinking L --task M --smol M --compact N --mcp a,b|all|manual --skills a,b|all]
  send R text...
  move R --to R2
  edit R [--name N --purpose T --model M --thinking L --task M --smol M --compact N --mcp a,b|all|manual --skills a,b|all] [--restart]
  archive R [--force]
  archive-list
  restore <archive id>
  folder <absolute folder>   # project skills, project MCP and omp conversations of a folder
  attach <absolute folder> [--parent R] [--name N] [--session id|latest|new | --resume] [--start]   # without --session: list conversations; with it: link the folder as a child; --resume links the folder's existing recipe (orphan session)
  adopt <absolute folder> [--session id]
  resolve R <code> <action>
  models [filter]
  defaults [root|child]   # the user's default model, thinking and task/smol models for new sessions of that kind (default child)
  usage
  catalog [--refresh]
  schedule add R "<cron>" "<text>" | schedule list R | schedule rm R <id>
  trigger add R <name> "<template with {{body}}>" | trigger list R | trigger rm R <id>   # add prints the webhook URL
  secret set <NAME> (value on stdin) | secret rm <NAME>
  relocate R <absolute folder> | relocate R --workspace [--new-conversation]   # change a session's folder; --workspace moves a linked session into the workspace
  spawn ... [--preset coding|sales|support]   # role preset fills purpose, MCP, tools, env, approvals and schedules
  restart/edit/spawn accept --tools a,b|all (allowed built-in tools) and --approve a,b|none`;

type SessionView = {
  route: string;
  kind: "root" | "child";
  state: string;
  peer: string;
  running: boolean;
  desired: string;
  model: string;
  issues: { code: string }[];
};

type Catalog = { models: string[] | null };

const flags: Record<string, string | boolean> = {};
const pos: string[] = [];
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (!arg.startsWith("--")) {
    pos.push(arg);
    continue;
  }
  const key = arg.slice(2);
  if (key === "start" || key === "refresh" || key === "restart" || key === "force" || key === "workspace" || key === "new-conversation" || key === "resume") {
    flags[key] = true;
    continue;
  }
  const value = args[++i];
  if (!value || value.startsWith("--")) {
    console.error(USAGE);
    process.exit(1);
  }
  flags[key] = value;
}

function flag(key: string): string | undefined {
  const value = flags[key];
  return typeof value === "string" ? value : undefined;
}

function required(value: string | undefined): string {
  if (value) return value;
  throw new Error(USAGE);
}

function recipeFlags(): Record<string, unknown> {
  const recipe: Record<string, unknown> = {};
  for (const key of ["model", "thinking"]) {
    const value = flag(key);
    if (value !== undefined) recipe[key] = value;
  }
  const roles: Record<string, string> = {};
  for (const key of ["task", "smol"]) {
    const value = flag(key);
    if (value !== undefined) roles[key] = value;
  }
  if (Object.keys(roles).length) recipe.roles = roles;
  const compact = flag("compact");
  if (compact !== undefined) {
    const percent = Number(compact);
    if (!Number.isFinite(percent)) throw new Error(USAGE);
    recipe.compactPercent = percent;
  }
  const mcp = flag("mcp");
  if (mcp !== undefined) recipe.mcp = mcp === "all" || mcp === "manual" ? mcp : mcp.split(",");
  const skills = flag("skills");
  if (skills !== undefined) recipe.skills = skills === "all" ? null : skills.split(",");
  const approve = flag("approve");
  if (approve !== undefined) recipe.approve = approve === "none" ? [] : approve.split(",");
  const tools = flag("tools");
  if (tools !== undefined) recipe.tools = tools === "all" ? null : tools.split(",");
  return recipe;
}

type AutomationItem = { id: string; enabled: boolean } & Record<string, unknown>;

// Reads the schedules/triggers of a session, optionally rewrites them through `/edit`; the server assigns ids to rows sent with id "".
async function sessionList(route: string, key: "schedules" | "triggers", change?: (list: AutomationItem[]) => AutomationItem[]): Promise<{ before: AutomationItem[]; after: AutomationItem[] }> {
  const view = (JSON.parse(await call("/api/sessions")) as (SessionView & Partial<Record<typeof key, AutomationItem[]>>)[]).find(x => x.route === route);
  if (!view) throw new Error("error 404: unknown session");
  const before = view[key] ?? [];
  if (!change) return { before, after: before };
  const edited = JSON.parse(await call(sessionPath(route, "edit"), { [key]: change(before) })) as Partial<Record<typeof key, AutomationItem[]>>;
  return { before, after: edited[key] ?? [] };
}

async function call(path: string, body?: unknown, method?: "PUT" | "DELETE"): Promise<string> {
  const headers: Record<string, string> = { authorization: `Bearer ${token()}` };
  if (body !== undefined) headers["content-type"] = "application/json";
  const verb = method ?? (body === undefined ? "GET" : "POST");
  const response = await fetch(`${BASE}${path}`, { method: verb, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await response.text();
  if (!response.ok) throw new Error(`error ${response.status}: ${text}`);
  return text;
}

function sessionPath(route: string, operation: string): string {
  return `/api/sessions/${encodeURIComponent(route)}/${operation}`;
}

async function main(): Promise<void> {
  switch (command) {
    case "url":
      console.log(`${BASE}/login?t=${token()}`);
      break;
    case "list": {
      const sessions = JSON.parse(await call("/api/sessions")) as SessionView[];
      console.log(JSON.stringify(sessions.map(({ route, kind, state, peer, running, desired, model, issues }) => ({
        route, kind, state, peer, running, desired, model, issues: issues.map(issue => issue.code),
      }))));
      break;
    }
    case "spawn": {
      if (pos.length) throw new Error(USAGE);
      const folder = flag("folder");
      const session = flag("session");
      if (session && !folder) throw new Error("--session needs --folder");
      console.log(await call("/api/sessions", {
        parent: flag("parent") ?? process.env.ORCH_ROUTE ?? null,
        name: required(flag("name")),
        purpose: flag("preset") || flags.resume === true ? flag("purpose") : required(flag("purpose")),
        start: flags.start === true,
        ...(flag("preset") ? { preset: flag("preset") } : {}),
        folder,
        ...(flags.resume === true ? { resume: true } : {}),
        ...(session ? { sessionId: session === "new" ? null : session } : {}),
        ...recipeFlags(),
      }));
      break;
    }
    case "start":
    case "stop":
    case "restart": {
      if (pos.length !== 1) throw new Error(USAGE);
      console.log(await call(sessionPath(pos[0], command), command === "restart" ? recipeFlags() : {}));
      break;
    }
    case "send": {
      if (pos.length < 2) throw new Error(USAGE);
      console.log(await call(sessionPath(pos[0], "send"), { text: pos.slice(1).join(" ") }));
      break;
    }
    case "edit": {
      if (pos.length !== 1) throw new Error(USAGE);
      let route = pos[0];
      const name = flag("name");
      if (name && name !== route.split("/").pop()) {
        const to = [...route.split("/").slice(0, -1), name].join("/");
        await call(sessionPath(route, "move"), { to });
        route = to;
      }
      const body: Record<string, unknown> = { ...recipeFlags(), restart: flags.restart === true };
      const purpose = flag("purpose");
      if (purpose) body.purpose = purpose;
      console.log(await call(sessionPath(route, "edit"), body));
      break;
    }
    case "archive": {
      if (pos.length !== 1) throw new Error(USAGE);
      console.log(await call(sessionPath(pos[0], "archive"), { force: flags.force === true }));
      break;
    }
    case "move": {
      if (pos.length !== 1) throw new Error(USAGE);
      console.log(await call(sessionPath(pos[0], "move"), { to: required(flag("to")) }));
      break;
    }
    case "adopt": {
      if (pos.length !== 1) throw new Error(USAGE);
      console.log(await call("/api/adopt", { folder: pos[0], ...(flag("session") ? { sessionId: flag("session") } : {}) }));
      break;
    }
    case "attach": {
      const folder = pos[0];
      if (!folder || pos.length !== 1) throw new Error(USAGE);
      const session = flag("session");
      const resume = flags.resume === true;
      if (!session && !resume) {
        const info = JSON.parse(await call(`/api/folder-info?folder=${encodeURIComponent(folder)}`)) as { conversations: unknown[] };
        console.log(JSON.stringify(info.conversations.length ? { conversations: info.conversations } : { conversations: [], hint: "no omp conversation in that folder yet: attach again with --session new" }));
        break;
      }
      console.log(await call("/api/sessions", {
        parent: flag("parent") ?? process.env.ORCH_ROUTE ?? null,
        name: flag("name") ?? basename(folder),
        folder,
        ...(session ? { sessionId: session === "new" ? null : session } : {}),
        ...(resume ? { resume: true } : {}),
        start: flags.start === true,
      }));
      break;
    }
    case "archive-list":
      if (pos.length) throw new Error(USAGE);
      console.log(await call("/api/archive"));
      break;
    case "restore":
      if (pos.length !== 1) throw new Error(USAGE);
      console.log(await call(`/api/archive/${encodeURIComponent(pos[0])}/restore`, {}));
      break;
    case "folder":
      if (pos.length !== 1) throw new Error(USAGE);
      console.log(await call(`/api/folder-info?folder=${encodeURIComponent(pos[0])}`));
      break;
    case "resolve": {
      if (pos.length !== 3) throw new Error(USAGE);
      console.log(await call(sessionPath(pos[0], "resolve"), { code: pos[1], action: pos[2] }));
      break;
    }
    case "models": {
      if (pos.length > 1) throw new Error(USAGE);
      const catalog = JSON.parse(await call("/api/catalog")) as Catalog;
      console.log(JSON.stringify((catalog.models ?? []).filter(model => !pos[0] || model.includes(pos[0]))));
      break;
    }
    case "defaults": {
      const kind = pos[0] ?? "child";
      if (pos.length > 1 || (kind !== "root" && kind !== "child")) throw new Error(USAGE);
      console.log(await call(`/api/recipe-defaults?kind=${kind}`));
      break;
    }
    case "usage":
      console.log(await call("/api/usage"));
      break;
    case "catalog":
      if (pos.length) throw new Error(USAGE);
      if (flags.refresh === true) await call("/api/catalog/refresh", {});
      console.log(await call("/api/catalog"));
      break;
    case "schedule":
    case "trigger": {
      const key = command === "schedule" ? "schedules" : "triggers";
      const [sub, route, ...rest] = pos;
      if (!route) throw new Error(USAGE);
      const show = (list: AutomationItem[]) => list.map(item => (key === "triggers" ? { ...item, url: `${BASE}/hook/${item.id}` } : item));
      if (sub === "list" && !rest.length) {
        console.log(JSON.stringify(show((await sessionList(route, key)).before)));
        break;
      }
      if (sub === "add" && rest.length === 2) {
        const item: AutomationItem = key === "schedules" ? { id: "", cron: rest[0], text: rest[1], enabled: true } : { id: "", name: rest[0], template: rest[1], enabled: true };
        const { before, after } = await sessionList(route, key, list => [...list, item]);
        console.log(JSON.stringify(show(after.filter(a => !before.some(b => b.id === a.id)))[0]));
        break;
      }
      if (sub === "rm" && rest.length === 1) {
        const { before } = await sessionList(route, key, list => list.filter(x => x.id !== rest[0]));
        if (!before.some(x => x.id === rest[0])) throw new Error(`unknown ${command} id`);
        console.log(JSON.stringify({ ok: true }));
        break;
      }
      throw new Error(USAGE);
    }
    case "secret": {
      const [sub, name] = pos;
      if (!name || pos.length !== 2) throw new Error(USAGE);
      const path = `/api/secrets/${encodeURIComponent(name)}`;
      if (sub === "set") console.log(await call(path, { value: (await Bun.stdin.text()).replace(/\r?\n$/, "") }, "PUT"));
      else if (sub === "rm") console.log(await call(path, undefined, "DELETE"));
      else throw new Error(USAGE);
      break;
    }
    case "relocate": {
      const toWorkspace = flags.workspace === true;
      if (pos.length !== (toWorkspace ? 1 : 2)) throw new Error(USAGE);
      console.log(await call(sessionPath(pos[0], "relocate"), { folder: toWorkspace ? null : pos[1], conversation: flags["new-conversation"] === true ? "new" : "keep" }));
      break;
    }
    default:
      throw new Error(USAGE);
  }
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
