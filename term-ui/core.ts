// Core: shared state, issues, start pipeline, session-file observer, hello handling, issue resolution.
import { createHash } from "node:crypto";
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { ServerWebSocket } from "bun";
import type { Catalog } from "./catalog";
import { spawnPty, terminateTree, type PtyProc } from "./pty";
import { type Found, type Kind, type Known, type Recipe, orchDir, peerOf, samePath, sessionFile, toRoute, workspaceRoot, writeRecipe } from "./workspace";
import { awaitingRoutes, inboxAdd, inboxDecide, inboxOpenFor, logEvent, onInboxChange } from "./store";
import { loadScrollback, saveScrollback } from "./scrollback";
import { ensureToken } from "./token";
import { baseEnv } from "./secrets";

export type Level = "ask" | "flag" | "info";
export type Issue = { code: string; level: Level; text: string; actions: string[] };
export type State = "starting" | "ready" | "working" | "idle" | "stopped";
export type Parts = Record<"recipe" | "config" | "mcp" | "agents" | "skills", string>;
export type Session = Found & {
  proc?: PtyProc;
  starting?: boolean;
  restarting?: boolean;
  crashed?: boolean; // exited unexpectedly: not restarted automatically, the root or the user decides
  state: State;
  pid?: number;
  scrollback: string;
  clients: Set<ServerWebSocket<{ route: string }>>;
  realModel?: string;
  lastActivity?: string;
  exit?: string;
  lastBeat?: number;
  workingSince?: number;
  hung?: boolean;
  notices: string[];
  issues: Map<string, Issue>;
  spawnParts?: Parts;
  spawnRecipe?: Record<string, string>; // JSON per tracked recipe field at spawn, for field-level `restart-needed`
  spawnKind?: Kind;
  spawnedAt?: number;
  spawnedWithId?: string | null;
  helloSeen?: boolean;
  armPending?: boolean;
  obs?: { file: string; offset: number; armed: boolean };
  fallback?: boolean;
  prev?: { model?: string; thinking?: string };
  forkedId?: string;
  pendingId?: string; // id reported by hello, persisted once omp has written the session file
  latestUnmanaged?: string;
  mcpFailed?: Map<string, string>; // MCP servers reported failed by the extension: server -> error
  scrollbackDirty?: boolean; // changed since the last write to `.orch/scrollback`
  scrollbackRestored?: boolean; // loaded from disk and not yet continued by a new process
};

export const PORT = Number(process.env.PORT ?? 8787);
export const IO = resolve(import.meta.dir, "..");
export const ctx = {
  ws: workspaceRoot(),
  catalog: null as Catalog | null,
  sdkVersion: null as string | null,
  sessions: new Map<string, Session>(),
  globalIssues: new Map<string, Issue>(),
  known: {} as Known,
};
export const hooks = { reconcile: () => {} };

const SCROLLBACK_MAX = 256 * 1024;
const BEAT_TIMEOUT_MS = 60_000;
export const BLOCKING = new Set(["session-lost", "relocation-failed", "relocation-blocked", "mcp-profile-invalid", "recipe-invalid", "duplicate-id", "unexpected-fork", "link-broken"]);
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const base = (m?: string | null) => (m ?? "").split(":")[0];

// ---------- issues & notices ----------
export function notifyParent(s: Session, text: string) {
  const root = s.parent ? ctx.sessions.get(s.parent) : undefined;
  if (root) root.notices.push(`[orch] ${new Date().toISOString().slice(11, 19)} child ${s.route}: ${text}`);
}
export function setIssue(s: Session, code: string, level: Level, text: string, actions: string[] = []) {
  const had = s.issues.get(code);
  s.issues.set(code, { code, level, text, actions });
  if (!had) {
    logEvent(s.route, "issue-set", { code, level, text });
    if (level !== "info") notifyParent(s, `${code} — ${text}`);
    // An `ask` issue needs the user: one open inbox item per route+code (the item may survive a server restart).
    if (level === "ask" && !inboxOpenFor(s.route, "issue").some(i => i.data.code === code)) inboxAdd(s.route, "issue", code, text, { route: s.route, code });
  }
}
export function clearIssue(s: Session, ...codes: string[]) {
  for (const code of codes) {
    if (!s.issues.delete(code)) continue;
    logEvent(s.route, "issue-clear", { code });
    for (const item of inboxOpenFor(s.route, "issue")) if (item.data.code === code) inboxDecide(item.id, "dismissed");
    if (code === "mcp-failed") {
      s.mcpFailed = undefined;
      for (const item of inboxOpenFor(s.route, "mcp")) inboxDecide(item.id, "dismissed");
    }
  }
}

// Routes with an open approval or `waiting` item; refreshed whenever the inbox changes.
let awaiting = awaitingRoutes();
onInboxChange(() => void (awaiting = awaitingRoutes()));
export const isAwaiting = (route: string) => awaiting.has(route);
export const isBlocked = (s: Session) => [...s.issues.keys()].some(c => BLOCKING.has(c));

// ---------- session files ----------
const sessionsDir = () => join(ctx.catalog?.agentDir ?? join(homedir(), ".omp", "agent"), "sessions");
const fileCache = new Map<string, string>();

export function findSessionFile(id: string): string | undefined {
  const cached = fileCache.get(id);
  if (cached && existsSync(cached)) return cached;
  const root = sessionsDir();
  if (!existsSync(root)) return undefined;
  for (const dir of readdirSync(root)) {
    try {
      const hit = readdirSync(join(root, dir)).find(f => f.endsWith(`_${id}.jsonl`));
      if (hit) {
        fileCache.set(id, join(root, dir, hit));
        return join(root, dir, hit);
      }
    } catch {}
  }
  fileCache.delete(id);
  return undefined;
}

function readHead(file: string, bytes = 8192): string {
  const fd = openSync(file, "r");
  try {
    const buf = Buffer.alloc(bytes);
    return buf.toString("utf8", 0, readSync(fd, buf, 0, bytes, 0));
  } finally {
    closeSync(fd);
  }
}
export function headerCwd(file: string): string | undefined {
  for (const line of readHead(file).split("\n")) {
    try {
      const e = JSON.parse(line) as { type?: string; cwd?: string };
      if (e.type === "session") return e.cwd;
    } catch {}
  }
  return undefined;
}

// The omp SDK needs a newer Bun (Bun.JSONL) than the one running the server; the helper uses the pinned local one.
export const SDK_BUN = existsSync(join(import.meta.dir, "node_modules", ".bin", "bun")) ? join(import.meta.dir, "node_modules", ".bin", "bun") : process.execPath;

async function sdk(args: string[]): Promise<{ code: number; json: Record<string, unknown> }> {
  const p = Bun.spawn([SDK_BUN, join(import.meta.dir, "omp-sdk.ts"), ...args], { stdout: "pipe", stderr: "pipe" });
  const text = await new Response(p.stdout).text();
  const code = await p.exited;
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(text.trim().split("\n").pop() ?? "{}") as Record<string, unknown>;
  } catch {}
  return { code, json };
}

// Session files omp keeps for a folder (its bucket), newest first.
export async function bucketSessions(folder: string): Promise<{ id: string; path: string; birthMs: number }[]> {
  const dir = (await sdk(["bucket", folder])).json.dir as string | undefined;
  if (!dir || !existsSync(dir)) return [];
  return readdirSync(dir)
    .filter(f => f.endsWith(".jsonl"))
    .map(f => ({ id: f.slice(f.indexOf("_") + 1, -".jsonl".length), path: join(dir, f), birthMs: statSync(join(dir, f)).birthtimeMs }))
    .sort((a, b) => b.birthMs - a.birthMs);
}

// One helper call for many conversations: true = held by another omp process.
export async function heldLeases(ids: string[]): Promise<Record<string, boolean>> {
  return (await sdk(["leases", ...ids])).json as Record<string, boolean>;
}

// ---------- recipe persistence ----------
export const saveRecipe = (s: Session) => s.recipe && writeRecipe(s.dir, s.recipe);

// Routes of the OTHER sessions attached to the same folder (`[]` when this one runs in its own dir).
export const sharedWith = (s: Session): string[] =>
  s.linked ? [...ctx.sessions.values()].filter(x => x !== s && x.linked && samePath(x.folder, s.folder)).map(x => x.route) : [];

// ---------- AGENTS.md / skills / fingerprint ----------
function skillDirs(s: Session): string[] {
  const dirs = [join(s.folder, ".omp", "skills"), join(s.folder, ".agents", "skills"), join(IO, "skills", "common"), join(orchDir(ctx.ws), "skills", "common")];
  if (s.kind === "root") dirs.push(join(IO, "skills", "root"), join(orchDir(ctx.ws), "skills", "root"));
  return dirs.filter(d => existsSync(d));
}

function agentsContent(folder: string): string {
  const home = homedir();
  let out = "";
  for (let d = folder; d !== home && d !== dirname(d); d = dirname(d)) {
    const f = join(d, "AGENTS.md");
    if (existsSync(f)) out += `${f}\n${readFileSync(f, "utf8")}\n`;
  }
  return out;
}

export function fingerprint(s: Session): Parts {
  const r = s.recipe!;
  const mcpFile = join(s.folder, ".omp", "mcp.json");
  const skills = skillDirs(s)
    .flatMap(d => readdirSync(d).map(n => join(d, n, "SKILL.md")))
    .filter(f => existsSync(f))
    .sort()
    .map(f => `${f}:${statSync(f).mtimeMs}`)
    .join("\n");
  return {
    recipe: recipePart(s),
    config: sha(ctx.catalog?.hashes.config ?? ""),
    mcp: sha((ctx.catalog?.hashes.mcp ?? "") + (existsSync(mcpFile) ? readFileSync(mcpFile, "utf8") : "")),
    agents: sha(agentsContent(s.folder) + (s.linked && existsSync(join(s.dir, "AGENTS.md")) ? readFileSync(join(s.dir, "AGENTS.md"), "utf8") : "")),
    skills: sha(skills),
  };
}
export const recipePart = (s: Session) => {
  const r = s.recipe!;
  return sha(JSON.stringify({ kind: s.kind, model: r.model, thinking: r.thinking, roles: r.roles, compactPercent: r.compactPercent, mcp: r.mcp, skills: r.skills, tools: r.tools, env: r.env }));
};

// Recipe fields whose change needs a restart, one JSON string each (`restart-needed` names the fields that differ).
export function trackedFields(r: Recipe, kind: Kind): Record<string, string> {
  const roles = r.roles && Object.keys(r.roles).length ? r.roles : null;
  const fields = { model: r.model, thinking: r.thinking, roles, compactPercent: r.compactPercent, mcp: r.mcp, skills: r.skills, tools: r.tools, env: r.env, kind };
  return Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, JSON.stringify(v ?? null)]));
}

// ---------- MCP profile ----------
type McpFile = { mcpServers?: Record<string, Record<string, unknown>> } & Record<string, unknown>;
const mcpFileOf = (folder: string) => join(folder, ".omp", "mcp.json");

// Parses `<folder>/.omp/mcp.json`: undefined = missing file, null = unreadable or wrong shape.
function readMcpFile(file: string): McpFile | null | undefined {
  if (!existsSync(file)) return undefined;
  try {
    const v = JSON.parse(readFileSync(file, "utf8")) as McpFile | null;
    if (!v || typeof v !== "object" || Array.isArray(v)) return null;
    if (v.mcpServers !== undefined && (!v.mcpServers || typeof v.mcpServers !== "object" || Array.isArray(v.mcpServers))) return null;
    return v;
  } catch {
    return null;
  }
}

// Adopts the entries an older orch wrote: the disabled user-level servers found in the file.
function adoptOwnedMcp(s: Session) {
  const r = s.recipe;
  if (!r || r.mcpOwned !== undefined || !ctx.catalog) return;
  const servers = ctx.catalog.mcpServers;
  const cur = readMcpFile(mcpFileOf(s.folder));
  r.mcpOwned = Object.entries(cur?.mcpServers ?? {}).filter(([name, d]) => servers?.[name] && d.enabled === false).map(([name]) => name);
  delete (r as Record<string, unknown>).mcpProfileHash;
  saveRecipe(s);
}

// Rewrites `<folder>/.omp/mcp.json` for every session using that folder: a user-level server gets a disabled entry only when
// no sharer selects it (omp has no per-session switch). Only entries orch owns are rewritten or removed: a project definition
// with the same name wins. Without sharers every orch-written entry is removed. Returns false when the file is not valid JSON.
export function syncFolderMcp(folder: string): boolean {
  const servers = ctx.catalog?.mcpServers;
  if (!servers || !existsSync(folder)) return true;
  const sharers = [...ctx.sessions.values()].filter(x => x.recipe && samePath(x.folder, folder));
  for (const x of sharers) adoptOwnedMcp(x);
  const active = sharers.filter(x => x.recipe!.mcp !== "manual");
  if (sharers.length && !active.length) return true;
  const file = mcpFileOf(folder);
  const cur = readMcpFile(file);
  if (cur === null) return false;
  const entryOf = (name: string) => {
    const d = servers[name];
    return { type: d.type, command: d.command, args: d.args, url: d.url, enabled: false };
  };
  // disabled set: user-level servers that no active sharer selects (no sharers: none, so every owned entry goes)
  let wanted = active.length ? Object.keys(servers) : [];
  for (const x of active) {
    const mcp = x.recipe!.mcp ?? "all";
    wanted = mcp === "all" || mcp === "manual" ? [] : wanted.filter(name => !mcp.includes(name));
  }
  const owned = new Set(sharers.flatMap(x => x.recipe!.mcpOwned ?? []));
  if (!sharers.length) {
    // nobody left to remember what orch wrote: an entry identical to what orch writes for a catalog server is ours
    for (const [name, d] of Object.entries(cur?.mcpServers ?? {})) if (servers[name] && JSON.stringify(d) === JSON.stringify(entryOf(name))) owned.add(name);
  }
  const next: McpFile = structuredClone(cur ?? {});
  const before = JSON.stringify(cur ?? {});
  for (const name of owned) if (!wanted.includes(name) && next.mcpServers) delete next.mcpServers[name];
  for (const name of wanted) {
    const present = next.mcpServers ? name in next.mcpServers : false;
    if (present && !owned.has(name)) continue; // project definition wins
    (next.mcpServers ??= {})[name] = entryOf(name);
    owned.add(name);
  }
  const ownedNow = [...owned].filter(name => wanted.includes(name));
  if (JSON.stringify(next) !== before) {
    if (next.mcpServers && !Object.keys(next.mcpServers).length && Object.keys(next).length === 1) {
      if (cur) unlinkSync(file);
    } else {
      mkdirSync(join(folder, ".omp"), { recursive: true });
      writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`);
    }
  }
  for (const x of sharers) {
    const r = x.recipe!;
    if ([...(r.mcpOwned ?? [])].sort().join("\n") === [...ownedNow].sort().join("\n")) continue;
    r.mcpOwned = ownedNow;
    saveRecipe(x);
  }
  return true;
}

export function applyMcpProfile(s: Session): boolean {
  adoptOwnedMcp(s);
  const ok = syncFolderMcp(s.folder);
  if (ok) clearIssue(s, "mcp-profile-invalid");
  else setIssue(s, "mcp-profile-invalid", "flag", "`.omp/mcp.json` is not valid JSON", []);
  return ok;
}

// A linked session lives in a user's repository: keep orch's files out of `git status` through `.git/info/exclude`
// (never `.gitignore`). A worktree (`.git` is a file) is skipped.
function gitExclude(s: Session, lines: string[]) {
  const gitDir = join(s.folder, ".git");
  try {
    if (!s.linked || !statSync(gitDir).isDirectory()) return;
    const file = join(gitDir, "info", "exclude");
    const have = existsSync(file) ? readFileSync(file, "utf8") : "";
    const missing = lines.filter(l => !have.split("\n").includes(l));
    if (!missing.length) return;
    mkdirSync(join(gitDir, "info"), { recursive: true });
    appendFileSync(file, `${have && !have.endsWith("\n") ? "\n" : ""}${missing.join("\n")}\n`);
  } catch {}
}

// True when `.omp/mcp.json` holds nothing but servers orch wrote.
function mcpFileIsOwned(s: Session): boolean {
  const cur = readMcpFile(mcpFileOf(s.folder));
  const owned = s.recipe?.mcpOwned ?? [];
  return !!cur?.mcpServers && owned.length > 0 && Object.keys(cur).length === 1 && Object.keys(cur.mcpServers).every(k => owned.includes(k));
}

// ---------- overlay config ----------
function writeOverlay(s: Session): string {
  const r = s.recipe!;
  const lines: string[] = [];
  const roles = Object.entries(r.roles ?? {});
  if (roles.length) lines.push("modelRoles:", ...roles.map(([k, v]) => `  ${k}: ${JSON.stringify(v)}`));
  if (r.compactPercent != null) lines.push("compaction:", `  thresholdPercent: ${r.compactPercent}`);
  lines.push("skills:", "  enablePiProject: false", "  enableAgentsProject: false");
  // Selected skills only: the built-in subagents must stay reachable through includeSkills.
  if (r.skills) lines.push(`  includeSkills: ${JSON.stringify([...r.skills, "task/*", "scout/*", "reviewer/*", "security-reviewer/*", "sonic/*", "seance/*"])}`);
  lines.push(`  customDirectories: ${JSON.stringify(skillDirs(s))}`);
  mkdirSync(orchDir(s.dir), { recursive: true });
  const file = join(orchDir(s.dir), "config.yml");
  writeFileSync(file, `${lines.join("\n")}\n`);
  return file;
}

// One `--append-system-prompt` only: the protocol, where this session keeps its own files, and (linked sessions) its own AGENTS.md,
// which omp does not load because the cwd is the attached folder.
function writePrompt(s: Session): string {
  const protocol = readFileSync(join(IO, "protocols", s.kind === "root" ? "ROOT-PROTOCOL.md" : "PEER-PROTOCOL.md"), "utf8");
  const others = sharedWith(s);
  let text = `${protocol}\n\n## This session\n- Route: ${s.route}\n- Peer name: ${peerOf(s.route)}\n- Session folder (your own files): ${s.dir}\n- Outbox for deliverables: ${join(s.dir, "outbox")}\n`;
  if (s.linked) text += `- Working folder: ${s.folder}\n`;
  if (others.length) text += `- Other sessions in the working folder when you started: ${others.map(r => `${r} (peer ${peerOf(r)})`).join(", ")}. \`orch list\` shows the current list (\`sharedWith\`).\n`;
  const agents = join(s.dir, "AGENTS.md");
  if (s.linked && existsSync(agents)) text += `\n## Session instructions\n\n${readFileSync(agents, "utf8")}`;
  mkdirSync(orchDir(s.dir), { recursive: true });
  const file = join(orchDir(s.dir), "prompt.md");
  writeFileSync(file, text);
  return file;
}

// ---------- terminal plumbing ----------
export function broadcast(s: Session, data: string) {
  s.scrollback += data;
  s.scrollbackDirty = true;
  if (s.scrollback.length > SCROLLBACK_MAX) {
    // Cut at a line boundary: slicing mid-sequence garbles the repaint on reattach.
    const from = s.scrollback.length - SCROLLBACK_MAX;
    const nl = s.scrollback.indexOf("\n", from);
    s.scrollback = nl >= 0 ? s.scrollback.slice(nl + 1) : s.scrollback.slice(from);
  }
  for (const ws of s.clients) ws.send(data);
}

// Writes the scrollback to `.orch/scrollback` when it changed since the last write.
export function flushScrollback(s: Session) {
  if (!s.scrollbackDirty) return;
  s.scrollbackDirty = false;
  try {
    saveScrollback(ctx.ws, s.route, s.scrollback);
  } catch {}
}

export function sendTask(s: Session, text: string) {
  if (!s.proc) throw new Error("session not running");
  s.proc.write(`\x1b[200~${text}\x1b[201~`); // bracketed paste: multi-line text stays one prompt
  setTimeout(() => s.proc?.write("\r"), 600); // omp treats an Enter arriving right after a paste as part of it
}

function childEnv(s: Session): Record<string, string> {
  const { env, missing } = baseEnv(s.recipe?.env, process.env);
  if (missing.length) setIssue(s, "secret-missing", "flag", missing.join(", "), []);
  else clearIssue(s, "secret-missing");
  delete env.OMPCODE; // otherwise the child omp believes it is nested inside another omp
  env.TERM = "xterm-256color";
  env.COLORTERM = "truecolor";
  env.ORCH_URL = `http://127.0.0.1:${PORT}`;
  env.ORCH_ROUTE = s.route;
  env.ORCH_PEER = peerOf(s.route);
  env.ORCH_TOKEN = ensureToken(ctx.ws);
  env.ORCH_KIND = s.kind;
  const allowed = s.recipe?.tools;
  const builtin = ctx.catalog?.builtinTools;
  if (allowed && builtin) env.ORCH_TOOLS_DENY = builtin.filter(n => !allowed.includes(n)).join(",");
  else delete env.ORCH_TOOLS_DENY;
  return env;
}

// ---------- start pipeline ----------
export async function startSession(s: Session): Promise<boolean> {
  const r = s.recipe;
  if (s.proc || s.starting || !r) return false;
  s.starting = true;
  try {
    clearIssue(s, "open-elsewhere", "session-lost", "relocation-failed", "relocation-blocked");
    // Not blocking: reconcile retries on its own and the issue clears once the catalog has the built-in list.
    if (r.tools && !ctx.catalog?.builtinTools.length) {
      setIssue(s, "tools-unavailable", "flag", "the built-in tool list is not available, so the tools allowlist cannot be enforced; refresh the catalog", []);
      return false;
    }
    clearIssue(s, "tools-unavailable");
    // the session's files all live in its workspace dir: nothing of orch is written into an attached folder besides `.omp/mcp.json`
    const mismatch = ctx.globalIssues.has("sdk-mismatch");
    let file: string | undefined;
    if (r.sessionId) {
      file = findSessionFile(r.sessionId);
      if (!file) {
        setIssue(s, "session-lost", "ask", `session ${r.sessionId} has no file`, ["start-new"]);
        return false;
      }
      if (!mismatch && (await sdk(["lease", r.sessionId])).code === 3) {
        setIssue(s, "open-elsewhere", "flag", "another omp process is writing this session", []);
        return false;
      }
      const cwd = headerCwd(file);
      if (cwd && !samePath(cwd, s.folder)) {
        if (mismatch) {
          setIssue(s, "relocation-blocked", "flag", "SDK version differs from omp: cannot relocate the session", []);
          return false;
        }
        const res = await sdk(["relocate", file, cwd, s.folder]);
        if (res.code === 3) {
          setIssue(s, "open-elsewhere", "flag", "another omp process is writing this session", []);
          return false;
        }
        if (res.code !== 0) {
          setIssue(s, "relocation-failed", "flag", String(res.json.error ?? "relocation failed"), []);
          return false;
        }
        fileCache.delete(r.sessionId);
      }
    }
    if (!applyMcpProfile(s)) return false;
    if (mcpFileIsOwned(s)) gitExclude(s, [".omp/mcp.json"]);
    const overlay = writeOverlay(s);
    const args = ["omp"];
    if (r.sessionId) args.push("-r", r.sessionId);
    if (r.model) args.push("--model", r.model);
    if (r.thinking) args.push("--thinking", r.thinking);
    args.push("--config", overlay, "--append-system-prompt", writePrompt(s));
    args.push("-e", join(IO, "term-ui", "orch-ext.ts"));

    const parts = fingerprint(s);
    if (s.scrollbackRestored) s.scrollbackRestored = false; // first start after a server restart continues the saved history
    else {
      s.scrollback = "";
      for (const ws of s.clients) ws.send("\x1bc"); // full reset: the new process repaints from scratch
    }
    broadcast(s, `\r\n\x1b[2m[term-ui] ${args.join(" ")}\x1b[0m\r\n`);
    const proc = spawnPty(args, { cwd: s.folder, env: childEnv(s), cols: 120, rows: 32, onData: d => broadcast(s, d) });
    Object.assign(s, {
      proc,
      pid: proc.pid,
      state: "starting" as State,
      hung: false,
      crashed: false,
      exit: undefined,
      lastBeat: Date.now(),
      spawnedAt: Date.now(),
      spawnKind: s.kind,
      spawnParts: parts,
      spawnRecipe: trackedFields(r, s.kind),
      spawnedWithId: r.sessionId,
      helloSeen: false,
      armPending: false,
      obs: undefined,
      fallback: false,
    });
    clearIssue(s, "restart-needed", "role-changed", "hello-missing"); // `mcp-failed` stays until the server connects again or the user dismisses it
    logEvent(s.route, "spawn", { pid: proc.pid, sessionId: r.sessionId });
    proc.exited.then(({ code, signal }) => {
      if (s.proc !== proc) return;
      s.proc = undefined;
      s.pid = undefined;
      s.state = "stopped";
      s.hung = false;
      s.obs = undefined;
      s.exit = signal ?? `exit ${code}`;
      logEvent(s.route, "exit", { exit: s.exit });
      for (const kind of ["approval", "question", "waiting"] as const) for (const item of inboxOpenFor(s.route, kind)) if (!item.data.child) inboxDecide(item.id, "dismissed"); // the waiting tool died with the process
      flushScrollback(s);
      if (s.restarting) {
        s.restarting = false;
        void startSession(s);
        return;
      }
      broadcast(s, `\r\n\x1b[2m[term-ui] process exited (${s.exit})\x1b[0m\r\n`);
      const stopped = s.recipe?.desired === "stopped";
      s.crashed = !stopped;
      notifyParent(s, stopped ? "stopped on request (UI or orch stop)" : `exited unexpectedly (${s.exit}), desired=running`);
    });
    if (!r.sessionId) setTimeout(() => void helloMissing(s, proc), 30_000);
    return true;
  } finally {
    s.starting = false;
  }
}

// A fresh session whose hello never arrived: adopt the single session omp created for this folder after the spawn.
async function helloMissing(s: Session, proc: PtyProc) {
  if (s.proc !== proc || s.helloSeen || !s.recipe || s.recipe.sessionId) return;
  const owned = new Set<string>(); // conversations of the other sessions sharing this folder are never ours
  for (const o of ctx.sessions.values()) {
    if (o === s || !o.recipe) continue;
    if (o.recipe.sessionId) owned.add(o.recipe.sessionId);
    for (const id of o.recipe.previousSessionIds) owned.add(id);
  }
  const fresh = (await bucketSessions(s.folder)).filter(f => f.birthMs >= (s.spawnedAt ?? 0) - 2000 && !owned.has(f.id));
  if (fresh.length === 1) {
    s.recipe.sessionId = fresh[0].id;
    saveRecipe(s);
    s.helloSeen = true;
    s.armPending = true;
  } else setIssue(s, "hello-missing", "flag", "the session never reported its id", []);
}

export function restartSession(s: Session) {
  if (!s.recipe) return;
  s.recipe.desired = "running";
  saveRecipe(s);
  s.crashed = false;
  if (s.proc) {
    s.restarting = true;
    void terminateTree(s.proc.pid);
  } else void startSession(s);
}

export function stopSession(s: Session) {
  if (!s.recipe) return;
  s.recipe.desired = "stopped";
  saveRecipe(s);
  s.crashed = false;
  logEvent(s.route, "stop", {});
  if (s.proc) void terminateTree(s.proc.pid);
}

// ---------- hello ----------
export function onHello(s: Session, body: { sessionId?: unknown; pid?: unknown; reason?: unknown }) {
  s.state = "ready";
  s.lastBeat = Date.now();
  s.pid = Number(body.pid) || s.pid;
  const r = s.recipe;
  const id = typeof body.sessionId === "string" ? body.sessionId : undefined;
  if (!r || !id) return;
  const first = !s.helloSeen;
  s.helloSeen = true;
  clearIssue(s, "hello-missing");
  if (first && s.spawnedWithId && id !== s.spawnedWithId) {
    // omp forked instead of resuming (lease held elsewhere, or a copy marked moved): keep the original id and ask.
    s.forkedId = id;
    r.desired = "stopped";
    saveRecipe(s);
    setIssue(s, "unexpected-fork", "ask", `omp opened a new session ${id} instead of ${s.spawnedWithId}`, ["adopt-new", "discard"]);
    if (s.proc) void terminateTree(s.proc.pid);
    return;
  }
  // omp writes the session file only on the first message: an id without a file cannot be resumed,
  // so it is persisted by the observer once the file exists (until then a restart starts fresh).
  s.pendingId = id === r.sessionId ? undefined : id;
  s.armPending = true;
}

function persistPendingId(s: Session) {
  const r = s.recipe;
  if (!r || !s.pendingId || !findSessionFile(s.pendingId)) return;
  if (r.sessionId) r.previousSessionIds.push(r.sessionId);
  r.sessionId = s.pendingId;
  s.pendingId = undefined;
  saveRecipe(s);
}

// ---------- observer ----------
type Entry = { type?: string; timestamp?: string; model?: string; role?: string; resolvedModelIsFallback?: boolean; thinkingLevel?: string; configured?: string | null; message?: { role?: string; provider?: string; model?: string } };

function adopt(s: Session, field: "model" | "thinking", value: string) {
  const r = s.recipe!;
  const old = r[field];
  if (base(old) === base(value) && field === "model") return;
  if (field === "thinking" && old === value) return;
  s.prev = { model: r.model, thinking: r.thinking };
  r[field] = field === "model" ? base(value) : value;
  saveRecipe(s);
  if (s.spawnParts) s.spawnParts.recipe = recipePart(s);
  setIssue(s, `${field}-adopted`, "info", `${old ?? "default"} → ${value}`, ["revert", "dismiss"]);
}

function processEntries(s: Session, text: string, armed: boolean) {
  for (const line of text.split("\n")) {
    if (!line) continue;
    let e: Entry;
    try {
      e = JSON.parse(line) as Entry;
    } catch {
      continue;
    }
    if (e.type === "message" && e.message?.role === "assistant" && e.message.model) {
      s.realModel = `${e.message.provider}/${e.message.model}`;
      s.lastActivity = e.timestamp;
    }
    if (!armed) continue;
    if (e.type === "model_change" && e.model) {
      if (e.role === "fallback" || e.resolvedModelIsFallback) s.fallback = true;
      else if (!e.role || e.role === "default") {
        s.fallback = false;
        adopt(s, "model", e.model);
      }
    }
    if (e.type === "thinking_level_change") {
      const level = e.configured ?? e.thinkingLevel;
      if (level) adopt(s, "thinking", level);
    }
  }
  if (s.fallback) setIssue(s, "in-fallback", "info", `running on ${s.realModel ?? "a fallback model"}`, []);
  else clearIssue(s, "in-fallback");
}

export function observe(s: Session) {
  persistPendingId(s);
  const id = s.recipe?.sessionId;
  if (!id || !s.proc || s.restarting) return;
  const file = findSessionFile(id);
  if (!file) return;
  if (!s.obs || s.obs.file !== file) s.obs = { file, offset: 0, armed: false };
  const o = s.obs;
  const size = statSync(file).size;
  if (size < o.offset) o.offset = size; // rewritten in place: skip, drift is only read from appended entries
  if (size > o.offset) {
    const fd = openSync(file, "r");
    try {
      const buf = Buffer.alloc(size - o.offset);
      readSync(fd, buf, 0, buf.length, o.offset);
      const lastNl = buf.lastIndexOf(10);
      if (lastNl >= 0) {
        processEntries(s, buf.toString("utf8", 0, lastNl + 1), o.armed);
        o.offset += lastNl + 1;
      }
    } finally {
      closeSync(fd);
    }
  }
  if (s.armPending) {
    o.armed = true;
    s.armPending = false;
  }
  const cwd = headerCwd(file);
  if (cwd && !samePath(cwd, s.folder)) followCwd(s, cwd);
}

// `/move` inside the session: the session folder follows the conversation.
function followCwd(s: Session, newCwd: string) {
  const ws = resolve(ctx.ws);
  const inside = resolve(newCwd).startsWith(ws + "/") || resolve(newCwd).startsWith(ws + "\\");
  if (s.linked) {
    // The recipe lives in the session dir: the attached folder follows the conversation when the new cwd is outside the workspace.
    if (s.recipe && existsSync(newCwd) && !inside) {
      const old = s.folder;
      s.folder = resolve(newCwd);
      s.recipe.folder = s.folder;
      s.recipe.mcpOwned = []; // the entries belong to the old folder
      saveRecipe(s);
      syncFolderMcp(old);
      setIssue(s, "followed-move", "info", `${old} → ${newCwd}`, ["dismiss"]);
      hooks.reconcile();
    } else {
      setIssue(s, "cwd-moved-in-session", "ask", `the session moved to ${newCwd}, which a linked session cannot follow`, ["move-back"]);
    }
    return;
  }
  if (inside && existsSync(newCwd) && !existsSync(sessionFile(newCwd))) {
    const oldRoute = s.route;
    try {
      renameSync(orchDir(s.dir), orchDir(newCwd));
      const old = s.folder;
      s.folder = newCwd;
      s.dir = newCwd;
      if (s.recipe) {
        s.recipe.mcpOwned = [];
        writeRecipe(newCwd, s.recipe);
      }
      syncFolderMcp(old);
    } catch (e) {
      setIssue(s, "cwd-moved-in-session", "ask", `cannot follow the move: ${(e as Error).message}`, ["move-back"]);
      return;
    }
    setIssue(s, "followed-move", "info", `${oldRoute} → ${toRoute(ctx.ws, newCwd)}`, ["dismiss"]);
    hooks.reconcile();
  } else {
    setIssue(s, "cwd-moved-in-session", "ask", `the session moved to ${newCwd}, which is outside the workspace or already a session`, ["move-back"]);
  }
}

// ---------- heartbeat ----------
let lastTick = Date.now();
export function heartbeatCheck() {
  const now = Date.now();
  if (now - lastTick > 30_000) for (const s of ctx.sessions.values()) s.lastBeat = now; // the host slept: not a hang
  lastTick = now;
  for (const s of ctx.sessions.values()) {
    if (!s.proc || s.hung || !s.lastBeat || now - s.lastBeat < BEAT_TIMEOUT_MS) continue;
    s.hung = true;
    notifyParent(s, `no heartbeat for ${Math.round((now - s.lastBeat) / 1000)} s (process alive, state ${s.state}): possibly stuck`);
  }
}

// ---------- issue resolution ----------
export async function resolveIssue(s: Session, code: string, action: string): Promise<string | undefined> {
  const r = s.recipe;
  if (!r) return "recipe invalid";
  const issue = s.issues.get(code);
  if (!issue) return "unknown issue";
  if (action !== "dismiss" && !issue.actions.includes(action)) return "action not offered for this issue";
  switch (action) {
    case "dismiss":
      clearIssue(s, code);
      break;
    case "revert":
      if (s.prev) Object.assign(r, { model: s.prev.model, thinking: s.prev.thinking });
      clearIssue(s, "model-adopted", "thinking-adopted");
      restartSession(s);
      break;
    case "restart":
      clearIssue(s, code);
      restartSession(s);
      break;
    case "start-new":
      if (r.sessionId) r.previousSessionIds.push(r.sessionId);
      r.sessionId = null;
      clearIssue(s, code);
      restartSession(s);
      break;
    case "move-back":
      clearIssue(s, code);
      restartSession(s);
      break;
    case "keep-here":
      for (const o of ctx.sessions.values())
        if (o !== s && o.recipe && o.recipe.sessionId === r.sessionId) {
          o.recipe.sessionId = null;
          o.recipe.desired = "stopped";
          saveRecipe(o);
          clearIssue(o, "duplicate-id");
          setIssue(o, "copied-new-identity", "info", "this folder is a copy: it lost the session id", ["dismiss"]);
        }
      clearIssue(s, code);
      restartSession(s);
      break;
    case "adopt-latest":
      if (s.latestUnmanaged) {
        if (r.sessionId) r.previousSessionIds.push(r.sessionId);
        r.sessionId = s.latestUnmanaged;
      }
      clearIssue(s, code);
      restartSession(s);
      break;
    case "adopt-new":
      if (s.forkedId) {
        if (r.sessionId) r.previousSessionIds.push(r.sessionId);
        r.sessionId = s.forkedId;
      }
      clearIssue(s, code);
      restartSession(s);
      break;
    case "discard":
      clearIssue(s, code);
      saveRecipe(s);
      break;
    default:
      return "unknown action";
  }
  return undefined;
}

export function newSession(f: Found): Session {
  let scrollback = loadScrollback(ctx.ws, f.route);
  if (scrollback.length > SCROLLBACK_MAX) {
    const nl = scrollback.indexOf("\n", scrollback.length - SCROLLBACK_MAX);
    scrollback = nl >= 0 ? scrollback.slice(nl + 1) : scrollback.slice(-SCROLLBACK_MAX);
  }
  return { ...f, state: "stopped", scrollback, scrollbackRestored: scrollback.length > 0, clients: new Set(), notices: [], issues: new Map() };
}
