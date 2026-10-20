// Core: shared state, issues, start pipeline, session-file observer, hello handling, issue resolution.
import { createHash } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { ServerWebSocket } from "bun";
import type { Catalog } from "./catalog";
import { spawnPty, terminateTree, type PtyProc } from "./pty";
import { type Found, type Kind, type Known, type Recipe, orchDir, peerOf, samePath, sessionFile, toRoute, workspaceRoot, writeRecipe } from "./workspace";

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
export const BLOCKING = new Set(["session-lost", "relocation-failed", "relocation-blocked", "mcp-profile-edited", "recipe-invalid", "duplicate-id", "unexpected-fork"]);
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
  if (!had && level !== "info") notifyParent(s, `${code} — ${text}`);
}
export const clearIssue = (s: Session, ...codes: string[]) => codes.forEach(c => s.issues.delete(c));
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
const SDK_BUN = existsSync(join(import.meta.dir, "node_modules", ".bin", "bun")) ? join(import.meta.dir, "node_modules", ".bin", "bun") : process.execPath;

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

// ---------- recipe persistence ----------
export const saveRecipe = (s: Session) => s.recipe && writeRecipe(s.folder, s.recipe);

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
    agents: sha(agentsContent(s.folder)),
    skills: sha(skills),
  };
}
export const recipePart = (s: Session) => {
  const r = s.recipe!;
  return sha(JSON.stringify({ kind: s.kind, model: r.model, thinking: r.thinking, roles: r.roles, compactPercent: r.compactPercent, mcp: r.mcp, skills: r.skills, tools: r.tools }));
};

// ---------- MCP profile ----------
function mcpContent(s: Session): string | null {
  const mcp = s.recipe?.mcp ?? "all";
  const servers = ctx.catalog?.mcpServers;
  if (mcp === "manual" || !servers) return null;
  const out: Record<string, Record<string, unknown>> = {};
  if (mcp !== "all") for (const [name, d] of Object.entries(servers)) if (!mcp.includes(name)) out[name] = { type: d.type, command: d.command, args: d.args, url: d.url, enabled: false };
  return `${JSON.stringify({ mcpServers: out }, null, 2)}\n`;
}

// Writes `<folder>/.omp/mcp.json` disabling every user-level MCP server not listed in the recipe.
// Never overwrites a file orch did not write (hash guard) unless force.
export function applyMcpProfile(s: Session, force = false): boolean {
  const r = s.recipe!;
  const content = mcpContent(s);
  if (content === null) return true;
  const file = join(s.folder, ".omp", "mcp.json");
  const exists = existsSync(file);
  if (!exists && r.mcp === "all") return true; // nothing to disable
  const cur = exists ? sha(readFileSync(file, "utf8")) : null;
  const next = sha(content);
  if (cur !== next) {
    if (exists && !force && cur !== r.mcpProfileHash) {
      setIssue(s, "mcp-profile-edited", "ask", "`.omp/mcp.json` was edited by hand", ["keep-mine", "overwrite"]);
      return false;
    }
    mkdirSync(join(s.folder, ".omp"), { recursive: true });
    writeFileSync(file, content);
  }
  if (r.mcpProfileHash !== next) {
    r.mcpProfileHash = next;
    saveRecipe(s);
  }
  clearIssue(s, "mcp-profile-edited");
  return true;
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
  mkdirSync(orchDir(s.folder), { recursive: true });
  const file = join(orchDir(s.folder), "config.yml");
  writeFileSync(file, `${lines.join("\n")}\n`);
  return file;
}

// ---------- terminal plumbing ----------
export function broadcast(s: Session, data: string) {
  s.scrollback += data;
  if (s.scrollback.length > SCROLLBACK_MAX) {
    // Cut at a line boundary: slicing mid-sequence garbles the repaint on reattach.
    const from = s.scrollback.length - SCROLLBACK_MAX;
    const nl = s.scrollback.indexOf("\n", from);
    s.scrollback = nl >= 0 ? s.scrollback.slice(nl + 1) : s.scrollback.slice(from);
  }
  for (const ws of s.clients) ws.send(data);
}

export function sendTask(s: Session, text: string) {
  if (!s.proc) throw new Error("session not running");
  s.proc.write(`\x1b[200~${text}\x1b[201~`); // bracketed paste: multi-line text stays one prompt
  setTimeout(() => s.proc?.write("\r"), 600); // omp treats an Enter arriving right after a paste as part of it
}

function childEnv(s: Session): Record<string, string> {
  const env: Record<string, string> = { ...(process.env as Record<string, string>) };
  delete env.OMPCODE; // otherwise the child omp believes it is nested inside another omp
  env.TERM = "xterm-256color";
  env.COLORTERM = "truecolor";
  env.ORCH_URL = `http://127.0.0.1:${PORT}`;
  env.ORCH_ROUTE = s.route;
  env.ORCH_PEER = peerOf(s.route);
  return env;
}

// ---------- start pipeline ----------
export async function startSession(s: Session): Promise<boolean> {
  const r = s.recipe;
  if (s.proc || s.starting || !r) return false;
  s.starting = true;
  try {
    clearIssue(s, "open-elsewhere", "session-lost", "relocation-failed", "relocation-blocked");
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
    const overlay = writeOverlay(s);
    const args = ["omp"];
    if (r.sessionId) args.push("-r", r.sessionId);
    if (r.model) args.push("--model", r.model);
    if (r.thinking) args.push("--thinking", r.thinking);
    args.push("--config", overlay, "--append-system-prompt", join(IO, "protocols", s.kind === "root" ? "ROOT-PROTOCOL.md" : "PEER-PROTOCOL.md"));
    if (r.tools) args.push("--tools", r.tools.join(","));
    args.push("-e", join(IO, "term-ui", "orch-ext.ts"));

    const parts = fingerprint(s);
    s.scrollback = "";
    for (const ws of s.clients) ws.send("\x1bc"); // full reset: the new process repaints from scratch
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
      spawnedWithId: r.sessionId,
      helloSeen: false,
      armPending: false,
      obs: undefined,
      fallback: false,
    });
    clearIssue(s, "restart-needed", "role-changed", "hello-missing");
    proc.exited.then(({ code, signal }) => {
      if (s.proc !== proc) return;
      s.proc = undefined;
      s.pid = undefined;
      s.state = "stopped";
      s.hung = false;
      s.obs = undefined;
      s.exit = signal ?? `exit ${code}`;
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
  const fresh = (await bucketSessions(s.folder)).filter(f => f.birthMs >= (s.spawnedAt ?? 0) - 2000);
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
  if (s.linked) {
    // The recipe lives in the external folder: following would move it out of the link's target.
    setIssue(s, "cwd-moved-in-session", "ask", `the session moved to ${newCwd}, which a linked session cannot follow`, ["move-back"]);
    return;
  }
  const inside = resolve(newCwd).startsWith(resolve(ctx.ws) + "/") || resolve(newCwd).startsWith(resolve(ctx.ws) + "\\");
  if (inside && existsSync(newCwd) && !existsSync(sessionFile(newCwd))) {
    const oldRoute = s.route;
    const mcp = join(s.folder, ".omp", "mcp.json");
    try {
      renameSync(orchDir(s.folder), orchDir(newCwd));
      if (s.recipe?.mcpProfileHash && existsSync(mcp) && sha(readFileSync(mcp, "utf8")) === s.recipe.mcpProfileHash) unlinkSync(mcp);
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
    case "keep-mine":
      r.mcp = "manual";
      clearIssue(s, code);
      restartSession(s);
      break;
    case "overwrite":
      if (applyMcpProfile(s, true)) restartSession(s);
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

export const newSession = (f: Found): Session => ({ ...f, state: "stopped", scrollback: "", clients: new Set(), notices: [], issues: new Map() });
