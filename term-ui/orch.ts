#!/usr/bin/env bun
// orch: CLI over the term-ui API. Prints JSON.
const BASE = process.env.ORCH_URL ?? "http://127.0.0.1:8787";
const [command, ...args] = process.argv.slice(2);

const USAGE = `usage: orch <command>
  list
  spawn --name N --purpose T [--parent R] [--model M --thinking L --task M --smol M --compact N --mcp a,b|all|manual] [--start]
  start R
  stop R
  restart R [--model M --thinking L --task M --smol M --compact N --mcp a,b|all|manual]
  send R text...
  move R --to R2
  edit R [--purpose T --model M --thinking L --task M --smol M --compact N --mcp a,b|all|manual] [--restart]
  archive R [--force]
  adopt <absolute folder> [--session id]
  resolve R <code> <action>
  models [filter]
  usage
  catalog [--refresh]`;

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
  if (key === "start" || key === "refresh" || key === "restart" || key === "force") {
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
  return recipe;
}

async function call(path: string, body?: unknown): Promise<string> {
  const response = await fetch(`${BASE}${path}`, body === undefined
    ? undefined
    : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const text = await response.text();
  if (!response.ok) throw new Error(`error ${response.status}: ${text}`);
  return text;
}

function sessionPath(route: string, operation: string): string {
  return `/api/sessions/${encodeURIComponent(route)}/${operation}`;
}

async function main(): Promise<void> {
  switch (command) {
    case "list": {
      const sessions = JSON.parse(await call("/api/sessions")) as SessionView[];
      console.log(JSON.stringify(sessions.map(({ route, kind, state, peer, running, desired, model, issues }) => ({
        route, kind, state, peer, running, desired, model, issues: issues.map(issue => issue.code),
      }))));
      break;
    }
    case "spawn": {
      if (pos.length) throw new Error(USAGE);
      console.log(await call("/api/sessions", {
        parent: flag("parent") ?? process.env.ORCH_ROUTE ?? null,
        name: required(flag("name")),
        purpose: required(flag("purpose")),
        start: flags.start === true,
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
      const body: Record<string, unknown> = { ...recipeFlags(), restart: flags.restart === true };
      const purpose = flag("purpose");
      if (purpose) body.purpose = purpose;
      console.log(await call(sessionPath(pos[0], "edit"), body));
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
    case "usage":
      console.log(await call("/api/usage"));
      break;
    case "catalog":
      if (pos.length) throw new Error(USAGE);
      if (flags.refresh === true) await call("/api/catalog/refresh", {});
      console.log(await call("/api/catalog"));
      break;
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
