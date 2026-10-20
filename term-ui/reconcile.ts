// reconcile: one idempotent pass that makes init and every out-of-band change converge.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildCatalog, fileHashes, ompVersion, saveCatalog } from "./catalog";
import {
  BLOCKING, bucketSessions, clearIssue, ctx, fingerprint, headerCwd, findSessionFile, isBlocked, newSession, observe, applyMcpProfile,
  restartSession, saveRecipe, setIssue, startSession, type Parts, type Session,
} from "./core";
import { terminateTree } from "./pty";
import { orchDir, samePath, scanWorkspace, type Known } from "./workspace";

const catalogFile = () => join(orchDir(ctx.ws), "catalog.json");
const knownFile = () => join(orchDir(ctx.ws), "known.json");
let queue: Promise<void> = Promise.resolve();
let lastVersionCheck = 0;
let catalogEpoch = 0;
let unmanagedEpoch = -1;

export const reconcile = (): Promise<void> => (queue = queue.then(pass).catch(e => console.error("reconcile failed", e)));

export async function refreshCatalog() {
  ctx.catalog = await buildCatalog();
  saveCatalog(catalogFile(), ctx.catalog);
  catalogEpoch++;
  for (const c of ctx.catalog.missing) ctx.globalIssues.set("catalog-partial", { code: "catalog-partial", level: "flag", text: `omp command failed: ${ctx.catalog.missing.join(", ")}`, actions: [] });
  if (!ctx.catalog.missing.length) ctx.globalIssues.delete("catalog-partial");
  checkSdk();
}

function checkSdk() {
  const v = ctx.catalog?.ompVersion;
  if (!v || !ctx.sdkVersion || v === ctx.sdkVersion) ctx.globalIssues.delete("sdk-mismatch");
  else ctx.globalIssues.set("sdk-mismatch", { code: "sdk-mismatch", level: "flag", text: `SDK ${ctx.sdkVersion} != omp ${v}: run "cd term-ui && bun add @oh-my-pi/pi-coding-agent@${v} @oh-my-pi/pi-utils@${v}"`, actions: [] });
}

async function pass() {
  // 1. catalog
  if (!ctx.catalog) {
    await refreshCatalog();
  } else {
    const h = fileHashes(ctx.catalog.agentDir);
    let stale = h.config !== ctx.catalog.hashes.config || h.mcp !== ctx.catalog.hashes.mcp;
    if (Date.now() - lastVersionCheck > 60_000) {
      lastVersionCheck = Date.now();
      stale ||= (await ompVersion()) !== ctx.catalog.ompVersion;
    }
    if (stale) {
      const mcpChanged = h.mcp !== ctx.catalog.hashes.mcp;
      await refreshCatalog();
      if (mcpChanged) for (const s of ctx.sessions.values()) if (s.recipe) applyMcpProfile(s);
    }
  }

  // 2. scan
  const found = scanWorkspace(ctx.ws);
  const next = new Map<string, Session>();
  const idRoutes = new Map<string, string[]>();
  for (const f of found) {
    const old = ctx.sessions.get(f.route) ?? [...ctx.sessions.values()].find(o => o.recipe?.sessionId && o.recipe.sessionId === f.recipe?.sessionId && !found.some(x => x.route === o.route));
    const s = old ?? newSession(f);
    const movedFrom = old && old.route !== f.route ? old.route : undefined;
    Object.assign(s, f);
    if (movedFrom && s.proc) {
      // folder moved by hand while running: stop, the next start relocates the omp file
      s.restarting = true;
      void terminateTree(s.proc.pid);
    }
    if (f.recipeError) setIssue(s, "recipe-invalid", "flag", f.recipeError, []);
    else clearIssue(s, "recipe-invalid");
    next.set(f.route, s);
    const id = f.recipe?.sessionId;
    if (id) idRoutes.set(id, [...(idRoutes.get(id) ?? []), f.route]);
  }
  for (const [route, s] of ctx.sessions) if (!next.has(route) && s.proc) void terminateTree(s.proc.pid);
  ctx.sessions.clear();
  for (const [r, s] of next) ctx.sessions.set(r, s);

  // duplicate ids (folder copied)
  for (const [id, routes] of idRoutes) {
    if (routes.length < 2) continue;
    const file = findSessionFile(id);
    const cwd = file ? headerCwd(file) : undefined;
    const owner = routes.find(r => cwd && samePath(cwd, ctx.sessions.get(r)!.folder));
    for (const r of routes) {
      const s = ctx.sessions.get(r)!;
      if (r === owner) continue;
      if (owner) {
        s.recipe!.sessionId = null;
        s.recipe!.desired = "stopped";
        saveRecipe(s);
        setIssue(s, "copied-new-identity", "info", "this folder is a copy: it lost the session id", ["dismiss"]);
      } else setIssue(s, "duplicate-id", "ask", `session id ${id} exists in ${routes.join(", ")}`, ["keep-here"]);
    }
  }
  for (const s of ctx.sessions.values()) if (!s.recipe || s.recipe.sessionId === null) clearIssue(s, "duplicate-id");

  // 3. orphans (known.json)
  let known: Known = {};
  try {
    known = JSON.parse(readFileSync(knownFile(), "utf8")) as Known;
  } catch {}
  const now = new Date().toISOString();
  const live = new Set([...ctx.sessions.values()].map(s => s.recipe?.sessionId).filter((x): x is string => !!x));
  for (const s of ctx.sessions.values()) if (s.recipe?.sessionId) known[s.recipe.sessionId] = { route: s.route, lastSeen: now };
  ctx.known = known;
  void live;

  for (const s of ctx.sessions.values()) {
    const r = s.recipe;
    if (!r) continue;
    // role change vs spawn
    if (s.proc && s.spawnKind && s.spawnKind !== s.kind) setIssue(s, "role-changed", "flag", `now a ${s.kind}, started as ${s.spawnKind}`, ["restart"]);
    // 7. missing models
    const models = ctx.catalog?.models;
    if (models) {
      const wanted = [r.model, ...Object.values(r.roles ?? {})].filter((m): m is string => !!m).map(m => m.split(":")[0]);
      const gone = wanted.filter(m => !models.includes(m));
      if (gone.length) setIssue(s, "model-missing", "flag", `not in omp catalog: ${gone.join(", ")}`, []);
      else clearIssue(s, "model-missing");
    }
    // 5. restart-needed
    if (s.proc && s.spawnParts && !s.restarting) {
      const cur = fingerprint(s);
      const changed = (Object.keys(cur) as (keyof Parts)[]).filter(k => cur[k] !== s.spawnParts![k]);
      if (changed.length) setIssue(s, "restart-needed", "flag", `changed since start: ${changed.join(", ")}`, ["restart"]);
      else clearIssue(s, "restart-needed");
    }
    // observer
    if (s.proc) {
      try {
        observe(s);
      } catch {}
    }
    // 8. unmanaged sessions
    if (unmanagedEpoch !== catalogEpoch) {
      const files = await bucketSessions(s.folder);
      const known2 = new Set([r.sessionId, ...r.previousSessionIds]);
      // Pre-existing omp sessions in the folder (e.g. a live one) are never offered for adoption.
      const since = Date.parse(r.createdAt ?? "") || 0;
      const extra = files.filter(f => !known2.has(f.id) && f.birthMs > since);
      if (extra.length) {
        s.latestUnmanaged = extra[0].id;
        setIssue(s, "unmanaged-sessions", "info", `${extra.length} other omp session(s) exist for this folder`, ["adopt-latest", "dismiss"]);
      }
    }
  }
  unmanagedEpoch = catalogEpoch;

  // 4. start what should run
  for (const s of ctx.sessions.values()) {
    if (s.recipe?.desired === "running" && !s.proc && !s.starting && !s.crashed && !s.restarting && !isBlocked(s)) await startSession(s);
  }
  void BLOCKING;
  void restartSession;
  void existsSync;

  // 9. known.json
  writeFileSync(knownFile(), `${JSON.stringify(known, null, 2)}\n`);
}

export const orphans = () => {
  const present = new Set([...ctx.sessions.values()].map(s => s.recipe?.sessionId).filter((x): x is string => !!x));
  return Object.entries(ctx.known).filter(([id]) => !present.has(id)).map(([id, v]) => ({ id, ...v }));
};
