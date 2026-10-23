// Change a session's folder: relink a link whose project moved, move a linked session's `.orch` to another project,
// bring a linked session back into the workspace, or turn a workspace session into a link.
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { ctx, removeOwnedMcp, type Session } from "./core";
import { terminateTree } from "./pty";
import { linkFile, readRecipe, sessionFile, writeRecipe, type Recipe } from "./workspace";

export type RelocateBody = { folder?: unknown; conversation?: unknown };
export type RelocateDeps = {
  park: (subtree: Session[]) => Promise<Map<Session, Recipe["desired"]>>;
  subtreeOf: (s: Session) => Session[];
  reconcile: () => Promise<void>;
};

const fail = (text: string, status = 400) => new Response(text, { status });
const isDir = (p: string) => existsSync(p) && statSync(p).isDirectory();

// rename; across devices copy + remove
function moveEntry(from: string, to: string) {
  try {
    renameSync(from, to);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EXDEV") throw e;
    cpSync(from, to, { recursive: true });
    rmSync(from, { recursive: true, force: true });
  }
}

const writeLink = (dir: string, target: string) => {
  mkdirSync(join(dir, ".orch"), { recursive: true });
  writeFileSync(linkFile(dir), `${JSON.stringify({ target: resolve(target) }, null, 2)}\n`);
};

function holder(folder: string, except: Session): Session | undefined {
  const norm = resolve(folder);
  return [...ctx.sessions.values()].find(x => x !== except && resolve(x.folder) === norm);
}

/** Starts a fresh conversation in a recipe that now lives at `folder`. */
function forgetConversation(folder: string) {
  const { recipe } = readRecipe(folder);
  if (!recipe) return;
  if (recipe.sessionId) recipe.previousSessionIds.push(recipe.sessionId);
  recipe.sessionId = null;
  writeRecipe(folder, recipe);
}

type Plan = { left?: string[] };

// Removes the MCP entries orch wrote into a folder, and the `.omp/` directory when that leaves it empty.
function dropOwnedMcp(folder: string, owned: string[]) {
  removeOwnedMcp(folder, owned);
  const omp = join(folder, ".omp");
  if (existsSync(omp) && !readdirSync(omp).length) rmSync(omp, { recursive: true });
}

// Executes the validated case; returns what stayed behind (workspace session turned into a link).
// Every filesystem step registers its inverse in `undo`; the caller replays it (newest first) when a later step fails,
// so a half-applied relocation never leaves a recipe at one place and the link at another.
function apply(s: Session, folder: string | null, hasRecipeThere: boolean, undo: (() => void)[]): Plan {
  const dir = s.linkDir ?? s.folder; // the session's own directory in the workspace
  const owned = s.recipe?.mcpOwned ?? [];
  const move = (from: string, to: string) => {
    moveEntry(from, to);
    undo.push(() => moveEntry(to, from));
  };
  if (s.linked && folder && hasRecipeThere) {
    writeLink(dir, folder); // 1. relink after the project moved
    return {};
  }
  if (s.linked && folder) {
    // 2a. move `.orch` to a project that has none
    const old = s.folder;
    move(join(old, ".orch"), join(folder, ".orch"));
    writeLink(dir, folder);
    dropOwnedMcp(old, owned);
    return {};
  }
  if (s.linked) {
    // 2b. into the workspace: the session file comes back to the link directory, the project keeps no orch files
    const old = s.folder;
    move(sessionFile(old), sessionFile(dir));
    const link = readFileSync(linkFile(dir), "utf8");
    unlinkSync(linkFile(dir));
    undo.push(() => writeFileSync(linkFile(dir), link));
    rmSync(join(old, ".orch", "config.yml"), { force: true });
    if (!readdirSync(join(old, ".orch")).length) rmSync(join(old, ".orch"), { recursive: true });
    dropOwnedMcp(old, owned);
    return {};
  }
  // 3. workspace session -> link to `folder`
  mkdirSync(join(folder!, ".orch"), { recursive: true });
  move(sessionFile(dir), sessionFile(folder!));
  writeLink(dir, folder!);
  dropOwnedMcp(dir, owned);
  return { left: readdirSync(dir).filter(n => n !== ".orch") };
}

export async function relocate(s: Session, body: RelocateBody, deps: RelocateDeps): Promise<Response> {
  const conversation = body.conversation ?? "keep";
  if (conversation !== "keep" && conversation !== "new") return fail('conversation must be "keep" or "new"');
  const folder = body.folder === null ? null : typeof body.folder === "string" ? body.folder.trim() : undefined;
  if (folder === undefined) return fail("folder must be an existing absolute path");
  if (s.state === "working" && s.proc) return fail("busy: the session is working", 409);

  let hasRecipeThere = false;
  if (folder !== null) {
    if (!isAbsolute(folder) || !isDir(folder)) return fail("folder must be an existing absolute path");
    const rel = relative(resolve(ctx.ws), resolve(folder));
    if (!(rel.startsWith("..") || isAbsolute(rel))) return fail("folder inside the workspace does not need a link");
    hasRecipeThere = existsSync(sessionFile(folder));
    if (holder(folder, s)) return fail("folder already holds a session", 409);
    // a project that is not a session must have no orch files at all, unless this is the relink of a link
    if (!(s.linked && hasRecipeThere) && (hasRecipeThere || existsSync(join(folder, ".orch")))) return fail("folder already holds a session", 409);
  }
  if (s.linked) {
    if (s.recipeError?.startsWith("link target missing") && !hasRecipeThere) return fail("no recipe at the new folder and the old one is missing");
  } else {
    if (folder === null) return fail("folder must be an existing absolute path");
    if (deps.subtreeOf(s).length > 1) return fail("move or archive the children first", 409);
  }

  const prev = await deps.park([s]);
  if (s.proc && !s.recipe) {
    // a broken link has no recipe to park, but its process may still run in the folder that moved away
    const exited = s.proc.exited;
    s.restarting = false;
    void terminateTree(s.proc.pid, 3000);
    await Promise.race([exited, Bun.sleep(8000)]);
    s.crashed = false;
  }
  const undo: (() => void)[] = [];
  try {
    const plan = apply(s, folder, hasRecipeThere, undo);
    const newFolder = folder ?? s.linkDir ?? s.folder;
    if (conversation === "new") forgetConversation(newFolder);
    for (const [x, d] of prev) if (x.recipe) x.recipe.desired = d;
    await deps.reconcile(); // desired comes back from the moved recipe file on rescan
    return Response.json({ ok: true, ...plan });
  } catch (e) {
    for (const step of undo.reverse()) {
      try {
        step();
      } catch {} // best effort: the first failure is the one reported
    }
    for (const [x, d] of prev) if (x.recipe) x.recipe.desired = d;
    await deps.reconcile();
    return fail(`relocation failed: ${(e as Error).message}`, 500);
  }
}
