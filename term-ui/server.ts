// term-ui: browser page with live agent terminals (xterm.js) backed by PTYs.
// The server owns every agent process. Sessions are folders in the workspace (`.orch/session.json`);
// `reconcile` keeps the running world and the folders in agreement.
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { recipeDefaults } from "./catalog";
import {
  IO, PORT, broadcast, clearIssue, ctx, heartbeatCheck, hooks, newSession, notifyParent, onHello, resolveIssue, restartSession, saveRecipe, sendTask, startSession, stopSession, type Session, type State,
} from "./core";
import { assertPtySupported, terminateTree } from "./pty";
import { orphans, reconcile, refreshCatalog } from "./reconcile";
import { NAME_RE, newRecipe, orchDir, peerOf, scanWorkspace, writeRecipe, type Recipe } from "./workspace";

assertPtySupported();
mkdirSync(orchDir(ctx.ws), { recursive: true });
hooks.reconcile = () => void reconcile();
try {
  ctx.sdkVersion = (JSON.parse(readFileSync(join(import.meta.dir, "node_modules", "@oh-my-pi", "pi-coding-agent", "package.json"), "utf8")) as { version: string }).version;
} catch {}

const RECIPE_KEYS = ["model", "thinking", "roles", "compactPercent", "mcp", "skills", "tools"] as const;
const json = (v: unknown, status = 200) => Response.json(v, { status });
const bad = (text: string, status = 400) => new Response(text, { status });

const view = (s: Session) => ({
  route: s.route, name: s.name, peer: peerOf(s.route), kind: s.kind, parent: s.parent, depth: s.depth, folder: s.folder,
  ...(s.recipe ?? {}),
  desired: s.recipe?.desired ?? "stopped",
  running: !!s.proc, state: s.state, hung: !!s.hung, exit: s.exit, pid: s.pid, realModel: s.realModel, lastActivity: s.lastActivity, workingSince: s.workingSince,
  issues: [...s.issues.values()], recipeError: s.recipeError,
});
const views = () => [...ctx.sessions.values()].map(view);
const globalIssues = () => [...ctx.globalIssues.values()];

// ---------- SSE ----------
const listeners = new Set<ReadableStreamDefaultController<string>>();
let lastSnapshot = "";
const push = (data: string) => {
  for (const c of listeners) {
    try {
      c.enqueue(data);
    } catch {
      listeners.delete(c);
    }
  }
};
setInterval(() => {
  const snap = JSON.stringify(views());
  if (snap !== lastSnapshot) push(`data: ${(lastSnapshot = snap)}\n\n`);
}, 300);
setInterval(() => push("event: ping\ndata: 1\n\n"), 10_000);
setInterval(heartbeatCheck, 10_000);
setInterval(() => void reconcile(), 5_000);

// ---------- models cache ----------
async function cli(args: string[]): Promise<string> {
  const p = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
  const out = await new Response(p.stdout).text();
  await p.exited;
  return out;
}

// ---------- creation ----------
function templateFor(kind: "root" | "child"): string | undefined {
  for (const f of [join(orchDir(ctx.ws), "templates", kind, "AGENTS.md"), join(IO, "templates", kind, "AGENTS.md")]) if (existsSync(f)) return readFileSync(f, "utf8");
  return undefined;
}

function validModel(m: string | undefined): boolean {
  const models = ctx.catalog?.models;
  return !m || !models || models.includes(m.split(":")[0]);
}

async function createSession(b: Partial<Recipe> & { parent?: string | null; name?: string; start?: boolean }): Promise<Response> {
  if (!b.name || !NAME_RE.test(b.name)) return bad("invalid name (a-z, 0-9, -; 2-32 chars)");
  let parentFolder = ctx.ws;
  if (b.parent) {
    const p = ctx.sessions.get(b.parent);
    if (!p) return bad("unknown parent");
    parentFolder = p.folder;
  }
  const folder = join(parentFolder, b.name);
  if (existsSync(folder)) return bad("folder already exists");
  if (!validModel(b.model)) return bad("unknown model");
  const kind = b.parent ? "child" : "root";
  const defaults = ctx.catalog ? recipeDefaults(ctx.catalog, kind) : {};
  const recipe = newRecipe({
    ...defaults,
    ...Object.fromEntries(RECIPE_KEYS.filter(k => b[k] !== undefined).map(k => [k, b[k]])),
    purpose: b.purpose,
    createdBy: b.createdBy ?? "cli",
    desired: b.start ? "running" : "stopped",
  });
  mkdirSync(folder, { recursive: true });
  writeRecipe(folder, recipe);
  const tpl = templateFor(kind);
  if (tpl && !existsSync(join(folder, "AGENTS.md"))) writeFileSync(join(folder, "AGENTS.md"), tpl.replaceAll("{{name}}", b.name).replaceAll("{{purpose}}", b.purpose ?? ""));
  await reconcile();
  const s = [...ctx.sessions.values()].find(x => x.folder === folder);
  return s ? json(view(s)) : bad("session not found after creation", 500);
}

function adopt(folder: string, sessionId: string | undefined): Response {
  if (!isAbsolute(folder) || !existsSync(folder) || !statSync(folder).isDirectory()) return bad("folder must be an existing absolute path");
  const rel = relative(resolve(ctx.ws), resolve(folder));
  if (rel.startsWith("..") || isAbsolute(rel) || rel === "") return bad("folder must be inside the workspace");
  if (existsSync(join(folder, ".orch", "session.json"))) return bad("folder is already a session");
  const parentKind = scanWorkspace(ctx.ws).some(f => resolve(folder).startsWith(`${resolve(f.folder)}/`)) ? "child" : "root";
  const defaults = ctx.catalog ? recipeDefaults(ctx.catalog, parentKind) : {};
  writeRecipe(folder, newRecipe({ ...defaults, sessionId: sessionId ?? null, desired: "stopped", createdBy: "adopt" }));
  return json({ ok: true });
}

const subtreeOf = (s: Session) => [...ctx.sessions.values()].filter(x => x.route === s.route || x.route.startsWith(`${s.route}/`));

// Stops every running session of a subtree as an intended stop (no crash notice) and waits for the exits.
// Returns the previous `desired` of each session so a move can restore it.
async function parkSubtree(subtree: Session[]): Promise<Map<Session, Recipe["desired"]>> {
  const prev = new Map<Session, Recipe["desired"]>();
  const exits: Promise<unknown>[] = [];
  for (const x of subtree) {
    if (!x.recipe) continue;
    prev.set(x, x.recipe.desired);
    x.recipe.desired = "stopped"; // in memory: the exit handler reports a requested stop
    x.restarting = false;
    if (x.proc) {
      exits.push(x.proc.exited);
      void terminateTree(x.proc.pid, 3000);
    }
  }
  await Promise.race([Promise.all(exits), Bun.sleep(8000)]);
  for (const x of subtree) x.crashed = false;
  return prev;
}

async function moveSubtree(s: Session, to: string): Promise<Response> {
  const subtree = subtreeOf(s);
  if (subtree.some(x => x.state === "working" && x.proc)) return bad("busy: a session in the subtree is working", 409);
  const target = join(ctx.ws, to);
  if (existsSync(target) || !existsSync(dirname(target))) return bad("target exists or its parent folder is missing");
  const prev = await parkSubtree(subtree);
  renameSync(s.folder, target);
  for (const [x, desired] of prev) x.recipe!.desired = desired;
  for (const [x] of prev) saveRecipe({ ...x, folder: join(target, relative(s.folder, x.folder)) });
  await reconcile();
  return json({ ok: true });
}

// Stop a whole subtree: children first (deepest first) so parents see their children leave, then the root.
// graceful = SIGTERM to every process tree, then up to 20 s for omp to flush and exit; kill = SIGKILL right away.
async function stopSubtree(s: Session, mode: "graceful" | "kill"): Promise<Response> {
  const subtree = subtreeOf(s).sort((a, b) => b.depth - a.depth);
  const wasRunning = subtree.filter(x => x.proc);
  for (const x of subtree) {
    if (!x.recipe) continue;
    x.recipe.desired = "stopped";
    x.restarting = false;
    saveRecipe(x);
    if (x.proc) void terminateTree(x.proc.pid, mode === "kill" ? 0 : 30000);
  }
  if (mode === "graceful") {
    const exits = wasRunning.map(x => x.proc!.exited);
    await Promise.race([Promise.all(exits), Bun.sleep(20_000)]);
  }
  for (const x of subtree) x.crashed = false;
  await reconcile();
  return json({ ok: true, stopped: wasRunning.length });
}

// Archive = stop the subtree and move it under `<ws>/_archive/` (ignored by the scan). Nothing is deleted:
// moving the folder back restores the sessions with their conversations.
async function archiveSubtree(s: Session, force: boolean): Promise<Response> {
  const subtree = subtreeOf(s);
  if (!force && subtree.some(x => x.state === "working" && x.proc)) return bad("busy: a session in the subtree is working", 409);
  await parkSubtree(subtree);
  for (const x of subtree) if (x.recipe) saveRecipe(x);
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
  const target = join(ctx.ws, "_archive", `${s.route.replaceAll("/", "__")}-${stamp}`);
  mkdirSync(dirname(target), { recursive: true });
  renameSync(s.folder, target);
  for (const x of subtree) if (x.recipe?.sessionId) delete ctx.known[x.recipe.sessionId]; // archived, not orphaned
  writeFileSync(join(orchDir(ctx.ws), "known.json"), `${JSON.stringify(ctx.known, null, 2)}\n`);
  await reconcile();
  return json({ ok: true, archivedTo: target });
}

// ---------- HTTP ----------
Bun.serve<{ route: string }, {}>({
  idleTimeout: 0, // SSE and PTY sockets stay open indefinitely
  port: PORT,
  hostname: "127.0.0.1",
  async fetch(req, server) {
    const url = new URL(req.url);
    const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    if (parts[0] === "pty" && parts[1]) return server.upgrade(req, { data: { route: parts[1] } }) ? undefined : bad("upgrade failed");
    if (parts[0] === "api") {
      switch (parts[1]) {
        case "events": {
          let ctl: ReadableStreamDefaultController<string>;
          const stream = new ReadableStream<string>({
            start(c) {
              ctl = c;
              listeners.add(c);
              c.enqueue(`data: ${JSON.stringify(views())}\n\n`);
            },
            cancel() {
              listeners.delete(ctl);
            },
          });
          return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } });
        }
        case "catalog":
          if (parts[2] === "refresh" && req.method === "POST") {
            await refreshCatalog();
            await reconcile();
          }
          return json(ctx.catalog);
        case "global-issues":
          return json(globalIssues());
        case "recipe-defaults":
          return ctx.catalog ? json(recipeDefaults(ctx.catalog, url.searchParams.get("kind") === "child" ? "child" : "root")) : bad("catalog not ready", 503);
        case "usage":
          return new Response(await cli(["omp", "usage", "--json"]), { headers: { "content-type": "application/json" } });
        case "orphans": {
          if (!parts[2]) return json(orphans());
          const id = parts[2];
          if (parts[3] === "forget") {
            delete ctx.known[id];
            writeFileSync(join(orchDir(ctx.ws), "known.json"), `${JSON.stringify(ctx.known, null, 2)}\n`);
            return json({ ok: true });
          }
          if (parts[3] === "relink") {
            const body = (await req.json().catch(() => ({}))) as { folder?: string };
            const res = adopt(String(body.folder ?? ""), id);
            if (res.ok) {
              delete ctx.known[id];
              await reconcile();
            }
            return res;
          }
          return bad("unknown action", 404);
        }
        case "adopt": {
          const body = (await req.json().catch(() => ({}))) as { folder?: string; sessionId?: string };
          const res = adopt(String(body.folder ?? ""), body.sessionId);
          if (res.ok) await reconcile();
          return res;
        }
        case "sessions":
          break;
        default:
          return bad("unknown endpoint", 404);
      }
      if (req.method === "GET" && !parts[2]) return json(views());
      if (req.method === "POST" && !parts[2]) return createSession((await req.json().catch(() => ({}))) as Parameters<typeof createSession>[0]);
      // /api/sessions/<route...>/<action>: route may contain "/" (encoded as %2F is also accepted)
      const action = parts[parts.length - 1];
      const route = parts.slice(2, -1).join("/");
      const s = ctx.sessions.get(route);
      if (!s) return bad("unknown session", 404);
      const body = req.method === "POST" ? ((await req.json().catch(() => ({}))) as Record<string, unknown>) : {};
      const r = s.recipe;
      switch (action) {
        case "restart":
          if (r) for (const k of RECIPE_KEYS) if (k in body) (r as Record<string, unknown>)[k] = body[k] || undefined;
          if (r && !validModel(r.model)) return bad("unknown model");
          restartSession(s);
          return json(view(s));
        case "start":
          if (r) {
            r.desired = "running";
            saveRecipe(s);
          }
          s.crashed = false;
          if (!s.proc) await startSession(s);
          return json(view(s));
        case "stop":
          stopSession(s);
          return json(view(s));
        case "send":
          try {
            sendTask(s, String(body.text ?? ""));
          } catch (e) {
            return bad((e as Error).message, 409);
          }
          return json({ ok: true });
        case "hello":
          onHello(s, body);
          return json(view(s));
        case "beat":
          s.lastBeat = Date.now();
          if (s.hung) {
            s.hung = false;
            notifyParent(s, "heartbeat resumed");
          }
          return json({ ok: true });
        case "notices":
          return json(s.notices.splice(0));
        case "state": {
          const next = body.state as State;
          if (next === "working" && s.state !== "working") s.workingSince = Date.now();
          if (next !== "working") s.workingSince = undefined;
          s.state = next;
          return json(view(s));
        }
        case "resolve": {
          const err = await resolveIssue(s, String(body.code), String(body.action));
          return err ? bad(err) : json(view(s));
        }
        case "move":
          return moveSubtree(s, String(body.to ?? ""));
        case "edit": {
          if (!r) return bad("recipe invalid");
          for (const k of RECIPE_KEYS) if (k in body) (r as Record<string, unknown>)[k] = body[k] ?? undefined;
          if (typeof body.purpose === "string") r.purpose = body.purpose;
          if (!validModel(r.model)) return bad("unknown model");
          saveRecipe(s);
          if (body.restart === true && s.proc) restartSession(s);
          // otherwise a running session gets `restart-needed` from reconcile (recipe fingerprint changed)
          await reconcile();
          return json(view(s));
        }
        case "archive":
          return archiveSubtree(s, body.force === true);
        case "stop-subtree":
          return stopSubtree(s, "graceful");
        case "kill-subtree":
          return stopSubtree(s, "kill");
      }
      return bad("unknown action", 404);
    }
    const path = url.pathname === "/" ? "index.html" : url.pathname;
    const file = Bun.file(join(import.meta.dir, "public", path));
    if (!(await file.exists())) return bad("not found", 404);
    return new Response(file, { headers: path.endsWith(".html") ? { "cache-control": "no-store" } : {} });
  },
  websocket: {
    open(ws) {
      const s = ctx.sessions.get(ws.data.route);
      if (!s) return ws.close();
      s.clients.add(ws);
      if (s.scrollback) ws.send(s.scrollback);
    },
    message(ws, raw) {
      const proc = ctx.sessions.get(ws.data.route)?.proc;
      if (!proc) return;
      const msg = JSON.parse(String(raw)) as { t: "in"; d: string } | { t: "resize"; cols: number; rows: number };
      if (msg.t === "in") proc.write(msg.d);
      else proc.resize(msg.cols, msg.rows);
    },
    close(ws) {
      ctx.sessions.get(ws.data.route)?.clients.delete(ws);
    },
  },
});

await reconcile();
void broadcast;
void clearIssue;
void newSession;
console.log(`term-ui listening on http://127.0.0.1:${PORT} (workspace ${ctx.ws})`);
