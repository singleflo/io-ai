// term-ui: browser page with live agent terminals (xterm.js) backed by PTYs.
// The server owns every agent process. Sessions are folders in the workspace (`.orch/session.json`);
// `reconcile` keeps the running world and the folders in agreement.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { recipeDefaults } from "./catalog";
import {
  IO, PORT, bucketSessions, broadcast, clearIssue, ctx, findSessionFile, flushScrollback, heartbeatCheck, heldLeases, hooks, isAwaiting, newSession, notifyParent, onHello, resolveIssue, restartSession, saveRecipe, sendTask, setIssue, sharedWith, startSession, stopSession, syncFolderMcp, type Session, type State,
} from "./core";
import { FolderError, folderInfo, listDirs, makeDir } from "./folder";
import { assertPtySupported, terminateTree } from "./pty";
import { orphans, reconcile, refreshCatalog } from "./reconcile";
import { ensureToken, cookieValue, tokenMatches } from "./token";
import { inboxCounts, inboxDecide, inboxList, inboxRenameRoutes, logEvent, onInboxChange, openStore, type InboxItem } from "./store";
import { loadSettings, saveSettings, validateSettings, visibleModels } from "./settings";
import { auditRequest, coreRoute, digestTick } from "./core-api";
import { renameScrollback } from "./scrollback";
import { NAME_RE, newRecipe, orchDir, peerOf, readRecipe, samePath, scanWorkspace, sessionFile, toRoute, writeRecipe, type Recipe } from "./workspace";
import { checkRecipeExtras, handleHook, normalizeRecipeExtras, startAutomation } from "./automation";
import { listPresets, loadPreset, presetFields } from "./presets";
import { relocate } from "./relocate";
import { listFiles, serveFile } from "./files";
import { handleSecrets } from "./secrets";

assertPtySupported();
mkdirSync(orchDir(ctx.ws), { recursive: true });
hooks.reconcile = () => void reconcile();
try {
  ctx.sdkVersion = (JSON.parse(readFileSync(join(import.meta.dir, "node_modules", "@oh-my-pi", "pi-coding-agent", "package.json"), "utf8")) as { version: string }).version;
} catch {}
openStore();
// The agent waiting for an open approval or `ask` died with the previous server run.
for (const item of inboxList("open", 10_000)) if (item.kind === "approval" || item.kind === "waiting" || (item.kind === "question" && !item.data.child)) inboxDecide(item.id, "dismissed");
const TOKEN = ensureToken(ctx.ws);

const RECIPE_KEYS = ["model", "thinking", "roles", "compactPercent", "mcp", "skills", "tools", "approve", "schedules", "triggers", "env"] as const;
const DUPLICATE_KEYS = RECIPE_KEYS.filter(k => k !== "schedules" && k !== "triggers"); // a trigger id is a webhook URL, a copied schedule would fire twice
const json = (v: unknown, status = 200) => Response.json(v, { status });
const bad = (text: string, status = 400) => new Response(text, { status });

const view = (s: Session) => ({
  route: s.route, name: s.name, peer: peerOf(s.route), kind: s.kind, parent: s.parent, depth: s.depth, folder: s.folder, dir: s.dir, linked: s.linked, sharedWith: sharedWith(s),
  ...(s.recipe ?? {}),
  desired: s.recipe?.desired ?? "stopped",
  running: !!s.proc, state: s.state, hung: !!s.hung, exit: s.exit, pid: s.pid, realModel: s.realModel, lastActivity: s.lastActivity, workingSince: s.workingSince,
  issues: [...s.issues.values()], recipeError: s.recipeError, awaiting: isAwaiting(s.route),
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
startAutomation();
setInterval(() => digestTick(), 30_000);
setInterval(() => ctx.sessions.forEach(flushScrollback), 10_000);
for (const sig of ["SIGINT", "SIGTERM"] as const)
  process.on(sig, () => {
    ctx.sessions.forEach(flushScrollback);
    process.exit(0);
  });

// Inbox changes: SSE `inbox` event for open pages, a macOS notification when no page is open.
const inboxPayload = () => JSON.stringify({ ...inboxCounts(), latest: inboxList("all", 1)[0] ?? null });
const MAC_KINDS = new Set<InboxItem["kind"]>(["approval", "question", "blocked", "mcp"]);
onInboxChange((item, change) => {
  push(`event: inbox\ndata: ${inboxPayload()}\n\n`);
  if (change !== "add" || process.platform !== "darwin" || listeners.size > 0 || !MAC_KINDS.has(item.kind)) return;
  const script = ["on run argv", 'display notification (item 1 of argv) with title "io-ai" subtitle (item 2 of argv)', "end run"];
  const mac = Bun.spawn(["osascript", ...script.flatMap(l => ["-e", l]), (item.body || item.title).slice(0, 200), item.route], { stdout: "ignore", stderr: "pipe" });
  void mac.exited.then(async code => {
    if (code !== 0) console.error(`osascript failed (${code}): ${await new Response(mac.stderr).text()}`);
  });
});

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

type CreateBody = Partial<Recipe> & { parent?: string | null; name?: string; start?: boolean; folder?: string; preset?: string; resume?: boolean };

async function createSession(b: CreateBody): Promise<Response> {
  if (!b.name || !NAME_RE.test(b.name)) return bad("invalid name (a-z, 0-9, -; 2-32 chars)");
  let parentDir = ctx.ws;
  if (b.parent) {
    const p = ctx.sessions.get(b.parent);
    if (!p) return bad("unknown parent");
    parentDir = p.dir;
  }
  const external = typeof b.folder === "string" && b.folder.trim() ? b.folder.trim() : undefined;
  if (external && (!isAbsolute(external) || !existsSync(external) || !statSync(external).isDirectory())) return bad("folder must be an existing absolute path");
  let resumed: Recipe | undefined;
  let pickId = Boolean(b.sessionId); // a conversation to start in: validated below, for new links and resumes alike
  if (external) {
    const rel = relative(resolve(ctx.ws), resolve(external));
    if (!(rel.startsWith("..") || isAbsolute(rel))) return bad("folder inside the workspace does not need a link");
    const hasRecipe = existsSync(sessionFile(external));
    if (!b.resume && hasRecipe) return bad("this folder holds a recipe from an older orch version: resume it");
    if (b.resume) {
      if (!hasRecipe) return bad("no session to resume in that folder");
      if (b.preset) return bad("resume cannot be combined with a preset");
      const read = readRecipe(external);
      if (!read.recipe) return bad(`unreadable recipe: ${read.error}`);
      resumed = read.recipe;
      if (b.sessionId === resumed.sessionId) pickId = false; // picking the recipe's own conversation = no pick
      if (!pickId) {
        if (resumed.sessionId && (await heldLeases([resumed.sessionId]))[resumed.sessionId]) return bad("conversation is open in another omp process", 409);
        if (resumed.sessionId && !findSessionFile(resumed.sessionId)) {
          // the conversation file is gone (the `conversation-missing` warning): start a new one instead of a session-lost stop
          resumed.previousSessionIds = [...resumed.previousSessionIds, resumed.sessionId];
          resumed.sessionId = null;
        }
      }
    }
  } else if (b.resume) return bad("resume needs a folder");
  // `sessionId`: a conversation of the linked folder ("latest" = newest free one); null/absent = a new conversation
  let sessionId: string | null = null;
  if (pickId && b.sessionId) {
    if (!external) return bad("sessionId needs a folder");
    const files = await bucketSessions(external);
    const held = files.length ? await heldLeases(files.map(f => f.id)) : {};
    const owned = (id: string) => [...ctx.sessions.values()].some(x => x.recipe?.sessionId === id);
    const id = b.sessionId === "latest" ? files.find(f => !owned(f.id) && !held[f.id])?.id : b.sessionId;
    if (!id && b.sessionId === "latest") return bad("no free conversation in that folder");
    if (!id || !files.some(f => f.id === id)) return bad("session id not found in that folder");
    if ((await heldLeases([id]))[id]) return bad("conversation is open in another omp process", 409);
    const owner = [...ctx.sessions.values()].find(x => x.recipe?.sessionId === id);
    if (owner) return bad(`conversation already belongs to ${owner.route}`, 409);
    sessionId = id;
    if (resumed && resumed.sessionId !== id) {
      // the picked conversation replaces the recipe's one, which stays in the history
      if (resumed.sessionId) resumed.previousSessionIds = [...resumed.previousSessionIds, resumed.sessionId];
      resumed.sessionId = id;
    }
  }
  const dir = join(parentDir, b.name);
  if (existsSync(dir)) return bad("folder already exists");
  const extrasError = checkRecipeExtras(b);
  if (extrasError) return bad(extrasError);
  const loaded = b.preset ? loadPreset(b.preset) : undefined;
  if (b.preset && !loaded) return bad("unknown preset");
  const filled = loaded ? presetFields(loaded.preset, ctx.catalog?.mcpServers ? Object.keys(ctx.catalog.mcpServers) : null) : undefined;
  const kind = b.parent ? "child" : "root";
  const defaults = ctx.catalog ? recipeDefaults(ctx.catalog, kind, loadSettings()) : {};
  const bodyFields = Object.fromEntries(RECIPE_KEYS.filter(k => b[k] !== undefined).map(k => [k, b[k]]));
  // resume: the legacy recipe stays; only fields present in the body overwrite it
  // otherwise precedence: catalog defaults < preset < what the body set
  const recipe: Recipe = resumed
    ? { ...resumed, ...bodyFields, ...(b.purpose !== undefined ? { purpose: b.purpose } : {}), desired: b.start ? "running" : "stopped" }
    : newRecipe({
        ...defaults,
        ...filled?.fields,
        ...bodyFields,
        purpose: b.purpose ?? filled?.fields.purpose,
        createdBy: b.createdBy ?? "cli",
        desired: b.start ? "running" : "stopped",
        sessionId,
      });
  if (!validModel(resumed ? b.model : recipe.model)) return bad("unknown model");
  normalizeRecipeExtras(recipe);
  if (external) recipe.folder = resolve(external);
  else delete recipe.folder; // a resumed recipe never carries one
  mkdirSync(dir, { recursive: true });
  writeRecipe(dir, recipe);
  if (resumed && external) {
    // the recipe moved into the session dir: the folder keeps nothing of the older orch layout
    rmSync(join(external, ".orch", "session.json"), { force: true });
    rmSync(join(external, ".orch", "config.yml"), { force: true });
    if (existsSync(join(external, ".orch")) && !readdirSync(join(external, ".orch")).length) rmSync(join(external, ".orch"), { recursive: true });
  }
  const tpl = loaded?.agents ?? templateFor(kind);
  if (tpl) writeFileSync(join(dir, "AGENTS.md"), tpl.replaceAll("{{name}}", b.name).replaceAll("{{purpose}}", recipe.purpose ?? ""));
  await reconcile();
  const s = ctx.sessions.get(toRoute(ctx.ws, dir));
  return s ? json({ ...view(s), ...(filled?.warnings.length ? { warnings: filled.warnings } : {}) }) : bad("session not found after creation", 500);
}

function adopt(folder: string, sessionId: string | undefined): Response {
  if (!isAbsolute(folder) || !existsSync(folder) || !statSync(folder).isDirectory()) return bad("folder must be an existing absolute path");
  const rel = relative(resolve(ctx.ws), resolve(folder));
  if (rel.startsWith("..") || isAbsolute(rel) || rel === "") return bad("folder must be inside the workspace");
  if (existsSync(join(folder, ".orch", "session.json"))) return bad("folder is already a session");
  const parentKind = scanWorkspace(ctx.ws).some(f => resolve(folder).startsWith(`${resolve(f.dir)}/`)) ? "child" : "root";
  const defaults = ctx.catalog ? recipeDefaults(ctx.catalog, parentKind, loadSettings()) : {};
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
  // a linked session moves its own directory, never the attached folder
  const segments = to.split("/");
  if (segments.some(seg => !seg || seg === "." || seg === "..") || !NAME_RE.test(segments[segments.length - 1])) return bad("invalid name (a-z, 0-9, -; 2-32 chars)");
  const subtree = subtreeOf(s);
  if (subtree.some(x => x.state === "working" && x.proc)) return bad("busy: a session in the subtree is working", 409);
  const target = join(ctx.ws, to);
  if (existsSync(target) || !existsSync(dirname(target))) return bad("target exists or its parent folder is missing");
  const prev = await parkSubtree(subtree);
  for (const x of subtree) {
    flushScrollback(x);
    renameScrollback(ctx.ws, x.route, to + x.route.slice(s.route.length));
  }
  inboxRenameRoutes(s.route, to);
  renameSync(s.dir, target);
  // desired states come back from the recipe files on rescan (parking only changed memory)
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
// moving the folder back restores the sessions with their conversations. The archive holds the whole session (recipe,
// overlay, AGENTS.md, outbox); attached folders keep only the MCP entries of the sessions still using them.
async function archiveSubtree(s: Session, force: boolean): Promise<Response> {
  const subtree = subtreeOf(s);
  if (!force && subtree.some(x => x.state === "working" && x.proc)) return bad("busy: a session in the subtree is working", 409);
  await parkSubtree(subtree);
  for (const x of subtree) if (x.recipe) saveRecipe(x);
  const folders = [...new Set(subtree.filter(x => x.linked).map(x => x.folder))];
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
  const target = join(ctx.ws, "_archive", `${s.route.replaceAll("/", "__")}-${stamp}`);
  mkdirSync(dirname(target), { recursive: true });
  renameSync(s.dir, target);
  for (const x of subtree) if (x.recipe?.sessionId) delete ctx.known[x.recipe.sessionId]; // archived, not orphaned
  writeFileSync(join(orchDir(ctx.ws), "known.json"), `${JSON.stringify(ctx.known, null, 2)}\n`);
  await reconcile();
  for (const f of folders) syncFolderMcp(f); // the archived sessions are gone: their MCP entries leave the folder
  return json({ ok: true, archivedTo: target });
}

// `<route with / as __>-YYYYMMDD-HHMMSS` (UTC stamp written by archiveSubtree)
const ARCHIVE_RE = /^(.+)-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})$/;

function listArchive(): { id: string; route: string; archivedAt: string }[] {
  const dir = join(ctx.ws, "_archive");
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter(e => e.isDirectory())
    .flatMap(e => {
      const m = ARCHIVE_RE.exec(e.name);
      return m ? [{ id: e.name, route: m[1].replaceAll("__", "/"), archivedAt: `${m[2]}-${m[3]}-${m[4]}T${m[5]}:${m[6]}:${m[7]}Z` }] : [];
    })
    .sort((a, b) => b.archivedAt.localeCompare(a.archivedAt));
}

// Moves an archived subtree back to its route. The sessions keep `desired: stopped`.
async function restoreArchive(id: string): Promise<Response> {
  const entry = listArchive().find(a => a.id === id);
  if (!entry) return bad("unknown archive entry", 404);
  const target = join(ctx.ws, entry.route);
  if (existsSync(target)) return bad("route already exists", 409);
  if (!existsSync(dirname(target))) return bad("parent missing");
  renameSync(join(ctx.ws, "_archive", id), target);
  await reconcile(); // a restored legacy layout is migrated by this scan
  return json({ ok: true, route: entry.route });
}

// Permanently removes an archived entry. The archive holds the whole session (recipe, overlay, AGENTS.md, outbox); attached folders keep nothing of orch.
function purgeArchive(id: string): Response {
  const entry = listArchive().find(a => a.id === id);
  if (!entry) return bad("unknown archive entry", 404);
  rmSync(join(ctx.ws, "_archive", entry.id), { recursive: true, force: true });
  return json({ ok: true });
}

// ---------- HTTP ----------
Bun.serve<{ route: string }, {}>({
  idleTimeout: 0, // SSE and PTY sockets stay open indefinitely
  port: PORT,
  hostname: "127.0.0.1",
  async fetch(req, server) {
    const url = new URL(req.url);
    const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    // Auth: every request needs the token except the login page and the webhooks (reachable only from this machine).
    if (req.method === "GET" && url.pathname === "/login") {
      if (!tokenMatches(url.searchParams.get("t"), TOKEN)) return bad("unauthorized", 401);
      return new Response(null, { status: 302, headers: { location: "/", "set-cookie": `orch_token=${TOKEN}; HttpOnly; SameSite=Strict; Path=/` } });
    }
    if (!(req.method === "POST" && parts[0] === "hook" && parts.length === 2)) {
      const bearer = /^Bearer\s+(.+)$/i.exec(req.headers.get("authorization") ?? "")?.[1];
      const queryToken = parts[0] === "pty" ? url.searchParams.get("t") : null;
      if (!tokenMatches(bearer ?? cookieValue(req.headers.get("cookie"), "orch_token") ?? queryToken, TOKEN)) return bad("unauthorized", 401);
      // SameSite=Strict ignores the port, so another local site could ride the cookie: a browser request
      // (it always sends Origin on POST and on WebSocket upgrades) must come from this server's own origin.
      const origin = req.headers.get("origin");
      if (!bearer && origin && URL.canParse(origin) !== true) return bad("cross-origin request refused", 403); // "null" origin
      if (!bearer && origin && URL.canParse(origin) && new URL(origin).host !== url.host) return bad("cross-origin request refused", 403);
    }
    if (parts[0] === "pty" && parts[1]) return server.upgrade(req, { data: { route: parts[1] } }) ? undefined : bad("upgrade failed");
    if (parts[0] === "hook" && parts.length === 2) return handleHook(req, parts[1]);
    if (parts[0] === "api") {
      void auditRequest(req.clone(), parts);
      const handled = await coreRoute(req, url, parts);
      if (handled) return handled;
      switch (parts[1]) {
        case "events": {
          let ctl: ReadableStreamDefaultController<string>;
          const stream = new ReadableStream<string>({
            start(c) {
              ctl = c;
              listeners.add(c);
              c.enqueue(`data: ${JSON.stringify(views())}\n\n`);
              c.enqueue(`event: inbox\ndata: ${inboxPayload()}\n\n`);
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
          return ctx.catalog ? json({ ...ctx.catalog, models: visibleModels(ctx.catalog.models, loadSettings()), allModels: ctx.catalog.models }) : json(ctx.catalog);
        case "global-issues":
          return json(globalIssues());
        case "recipe-defaults":
          return ctx.catalog ? json(recipeDefaults(ctx.catalog, url.searchParams.get("kind") === "child" ? "child" : "root", loadSettings())) : bad("catalog not ready", 503);
        case "settings": {
          if (req.method !== "POST") return json(loadSettings());
          const next = validateSettings(await req.json().catch(() => null), ctx.catalog?.models ?? null);
          if (typeof next === "string") return bad(next);
          saveSettings(next);
          logEvent("", "settings", {});
          return json(next);
        }
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
        case "fs":
          try {
            if (parts[2] === "mkdir" && req.method === "POST") {
              const mk = (await req.json().catch(() => ({}))) as { dir?: string; name?: string; hidden?: boolean };
              return json(makeDir(String(mk.dir ?? ""), String(mk.name ?? ""), mk.hidden === true));
            }
            return json(listDirs(url.searchParams.get("dir"), url.searchParams.get("hidden") === "1"));
          } catch (e) {
            return e instanceof FolderError ? bad(e.message, e.status) : bad((e as Error).message, 500);
          }
        case "secrets":
          return handleSecrets(req, parts.slice(2));
        case "presets":
          return json(listPresets());
        case "folder-info":
          try {
            return json(await folderInfo(url.searchParams.get("folder") ?? "", url.searchParams.get("route")));
          } catch (e) {
            return e instanceof FolderError ? bad(e.message) : bad((e as Error).message, 500);
          }
        case "archive": {
          if (!parts[2]) return json(listArchive());
          if (parts[3] === "restore" && req.method === "POST") return restoreArchive(parts[2]);
          if (parts[3] === "purge" && req.method === "POST") return purgeArchive(parts[2]);
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
        case "duplicate": {
          // A new session next to this one on the same attached folder: same recipe minus automations, new conversation, own mission.
          if (!String(body.purpose ?? "").trim()) return bad("purpose required");
          if (!r || !s.linked) return bad("only a session attached to a folder can be duplicated");
          const copy = Object.fromEntries(DUPLICATE_KEYS.filter(k => r[k] !== undefined).map(k => [k, structuredClone(r[k])])) as Partial<Recipe>;
          return createSession({ ...copy, parent: s.parent, name: String(body.name ?? ""), purpose: String(body.purpose), folder: s.folder, start: body.start === true, createdBy: "duplicate" });
        }
        case "restart":
          if (r) {
            const extrasError = checkRecipeExtras(body);
            if (extrasError) return bad(extrasError);
            for (const k of RECIPE_KEYS) if (k in body) (r as Record<string, unknown>)[k] = body[k] || undefined;
            normalizeRecipeExtras(r);
          }
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
          if (next === "working" && s.state !== "working") {
            s.workingSince = Date.now();
            if (s.linked && s.kind === "child") {
              const others = [...ctx.sessions.values()].filter(x => x !== s && x.kind === "child" && x.linked && x.proc && x.state === "working" && samePath(x.folder, s.folder)).map(x => x.route);
              if (others.length) {
                const routes = others.join(", ");
                setIssue(s, "shared-folder-busy", "info", `working at the same time as ${routes} in ${s.folder}`, ["dismiss"]);
                notifyParent(s, `started working while ${routes} ${others.length > 1 ? "are" : "is"} working in the same folder ${s.folder}`);
                logEvent(s.route, "shared-folder-overlap", { with: routes });
              }
            }
          }
          if (next !== "working") {
            s.workingSince = undefined;
            clearIssue(s, "shared-folder-busy");
          }
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
          const extrasError = checkRecipeExtras(body);
          if (extrasError) return bad(extrasError);
          for (const k of RECIPE_KEYS) {
            if (!(k in body)) continue;
            // `skills: null` (no filter) and `roles: null` are real values; for the others null means "unset"
            const v = k === "skills" || k === "roles" ? body[k] : body[k] ?? undefined;
            (r as Record<string, unknown>)[k] = v && typeof v === "object" && !Array.isArray(v) && !Object.keys(v).length ? null : v;
          }
          if (typeof body.purpose === "string") r.purpose = body.purpose;
          normalizeRecipeExtras(r);
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
        case "files":
          return json(listFiles(s));
        case "file":
          return serveFile(s, url.searchParams.get("path"), url.searchParams.get("root"));
        case "relocate":
          return relocate(s, body, { park: parkSubtree, reconcile });
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
console.log(`term-ui listening on http://127.0.0.1:${PORT}/login?t=${TOKEN} (workspace ${ctx.ws})`);
