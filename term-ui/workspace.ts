// Workspace model: a session is a folder containing `.orch/session.json`; routes are relative folder paths.
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

export type Roles = { default?: string; task?: string; smol?: string; plan?: string; slow?: string };
export type Schedule = { id: string; cron: string; text: string; enabled: boolean };
export type Trigger = { id: string; name: string; template: string; enabled: boolean };
export type EnvSpec = { inherit: "all" | "minimal"; secrets: string[] };
export type Recipe = {
  version: 1;
  sessionId: string | null;
  previousSessionIds: string[];
  desired: "running" | "stopped";
  purpose?: string;
  model?: string;
  thinking?: string;
  roles?: Roles | null;
  compactPercent?: number | null;
  mcp?: string[] | "all" | "manual";
  skills?: string[] | null; // selected skill names; null = every injected skill
  tools?: string[] | null;
  approve?: string[]; // tool-name globs that wait for the user's decision in the inbox; live (no restart)
  schedules?: Schedule[]; // live: the scheduler reads them every tick
  triggers?: Trigger[]; // live: `POST /hook/<id>`
  env?: EnvSpec;
  createdBy?: string;
  createdAt?: string;
  mcpOwned?: string[]; // MCP server names orch wrote into `<folder>/.omp/mcp.json` (disabled user-level servers)
  folder?: string; // working folder: absolute path outside the workspace; absent = the session's own workspace dir
};
export type Kind = "root" | "child";
export type Found = {
  route: string;
  name: string;
  folder: string; // the cwd: `recipe.folder` when linked, else `dir`
  dir: string; // the session's workspace directory (holds `.orch/session.json`)
  linked: boolean; // `recipe.folder` is set (or a legacy link is pending migration)
  folderMissing?: boolean; // linked folder does not exist
  parent: string | null;
  kind: Kind;
  depth: number;
  recipe: Recipe | null; // null when session.json is unreadable
  recipeError?: string;
};
export type Known = Record<string, { route: string; lastSeen: string }>;

export const NAME_RE = /^[a-z][a-z0-9-]{1,31}$/;

export function workspaceRoot(): string {
  const flag = process.argv.indexOf("--workspace");
  const flagValue = flag > 0 && !process.argv[flag + 1]?.startsWith("--") ? process.argv[flag + 1] : undefined; // the CLI uses --workspace as a boolean
  return process.env.ORCH_HOME ?? flagValue ?? join(homedir(), "orch");
}

export const orchDir = (ws: string) => join(ws, ".orch");
export const sessionFile = (folder: string) => join(folder, ".orch", "session.json");
export const linkFile = (dir: string) => join(dir, ".orch", "link.json");
export const readLink = (dir: string): string | undefined => {
  try {
    const target = (JSON.parse(readFileSync(linkFile(dir), "utf8")) as { target?: string }).target;
    return target && isAbsolute(target) ? target : undefined;
  } catch {
    return undefined;
  }
};
export const toRoute = (ws: string, folder: string) => relative(ws, folder).split(sep).join("/");
// omp peer names: 1-24 chars of [A-Za-z0-9_.-], not all digits, not main/all/self; omp silently replaces an invalid one with
// the cwd basename. Short routes keep the readable "<parent>.<child>" form; longer or reserved ones become
// "<parent>.<name>-<hash4>" (last two route segments, truncated) so they stay unique and still read as a child.
const PEER_MAX = 24;
const RESERVED_PEERS = new Set(["main", "all", "self"]);
const peerSafe = (seg: string) => seg.replace(/[^A-Za-z0-9_-]/g, "-");
export const peerOf = (route: string): string => {
  const segs = route.split("/").map(peerSafe);
  const full = segs.join(".");
  if (full.length <= PEER_MAX && !RESERVED_PEERS.has(full) && !/^\d+$/.test(full)) return full;
  const hash = createHash("sha1").update(route).digest("hex").slice(0, 4);
  const name = segs[segs.length - 1].slice(0, 14);
  const parent = segs.length > 1 ? segs[segs.length - 2].slice(0, PEER_MAX - 6 - name.length).replace(/[-_]+$/, "") : "";
  return `${parent ? `${parent}.` : ""}${name}-${hash}`;
};

// Real-path comparison; case-insensitive on macOS/Windows file systems.
export function samePath(a: string, b: string): boolean {
  const norm = (p: string) => {
    let r: string;
    try {
      r = realpathSync.native(p);
    } catch {
      r = p;
    }
    return process.platform === "darwin" || process.platform === "win32" ? r.toLowerCase() : r;
  };
  return norm(a) === norm(b);
}

function parseRecipe(file: string): { recipe: Recipe | null; error?: string } {
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as Recipe;
    return { recipe: { ...raw, previousSessionIds: raw.previousSessionIds ?? [] } };
  } catch (e) {
    return { recipe: null, error: (e as Error).message };
  }
}

export const readRecipe = (folder: string) => parseRecipe(sessionFile(folder));

export function writeRecipe(folder: string, recipe: Recipe) {
  mkdirSync(join(folder, ".orch"), { recursive: true });
  const tmp = `${sessionFile(folder)}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(recipe, null, 2)}\n`);
  renameSync(tmp, sessionFile(folder)); // atomic: a crash never leaves half a recipe
}

export function newRecipe(over: Partial<Recipe>): Recipe {
  return {
    version: 1,
    sessionId: null,
    previousSessionIds: [],
    desired: "running",
    createdAt: new Date().toISOString(),
    mcpOwned: [],
    ...over,
  };
}

// True when `folder` is an absolute path that is neither the workspace nor inside it.
const outsideOf = (ws: string, folder: string) => {
  if (!isAbsolute(folder)) return false;
  const rel = relative(ws, folder);
  return rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel);
};

// Recursive scan. Skips dot/underscore dirs, node_modules and symlinks; a session's children are scanned too.
export function scanWorkspace(ws: string): Found[] {
  const found: Found[] = [];
  const walk = (dir: string, parent: string | null, depth: number) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory() || e.isSymbolicLink()) continue;
      if (e.name.startsWith(".") || e.name.startsWith("_") || e.name === "node_modules") continue;
      const dir2 = join(dir, e.name);
      const route = toRoute(ws, dir2);
      const kind: Kind = parent ? "child" : "root";
      if (existsSync(sessionFile(dir2))) {
        const read = readRecipe(dir2);
        let { recipe } = read;
        let error = read.error;
        const wanted = recipe?.folder;
        if (recipe && wanted !== undefined && (typeof wanted !== "string" || !isAbsolute(wanted) || !outsideOf(ws, wanted))) {
          recipe = null;
          error = "recipe folder must be an absolute path outside the workspace";
        }
        const linked = !!recipe?.folder;
        const folder = recipe?.folder ?? dir2;
        found.push({ route, name: e.name, folder, dir: dir2, linked, folderMissing: linked && !existsSync(folder) ? true : undefined, parent, kind, depth, recipe, recipeError: error });
        walk(dir2, route, depth + 1);
      } else if (readLink(dir2) !== undefined) {
        // legacy link not migrated yet (its recipe is missing): reported as a broken link
        found.push({ route, name: e.name, folder: dir2, dir: dir2, linked: true, parent, kind, depth, recipe: null, recipeError: `link target missing: ${readLink(dir2)}` });
        walk(dir2, route, depth + 1);
      } else {
        walk(dir2, parent, depth);
      }
    }
  };
  walk(ws, null, 0);
  return found;
}

// Moves legacy recipes (`link.json` + `<target>/.orch/session.json`, or the archived `.orch/project/`) into the session's own dir
// as `recipe.folder`. The source is deleted only after the destination was written. Returns one log line per event.
export function migrateLegacyLinks(ws: string): string[] {
  const log: string[] = [];
  const walk = (dir: string) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory() || e.isSymbolicLink()) continue;
      if (e.name.startsWith(".") || e.name.startsWith("_") || e.name === "node_modules") continue;
      const dir2 = join(dir, e.name);
      const target = readLink(dir2);
      if (target !== undefined) migrateOne(dir2, target, log);
      walk(dir2);
    }
  };
  walk(ws);
  return log;
}

function migrateOne(dir: string, target: string, log: string[]) {
  const projectDir = join(dir, ".orch", "project");
  const targetOrch = join(target, ".orch");
  const archived = existsSync(join(projectDir, "session.json"));
  const sourceDir = archived ? projectDir : targetOrch;
  const hasSource = archived || (existsSync(target) && existsSync(join(targetOrch, "session.json")));
  const ownExists = existsSync(sessionFile(dir));
  const own = ownExists ? readRecipe(dir).recipe : null;
  if (ownExists && !(own?.folder && samePath(own.folder, target))) return; // the session already has a recipe of its own: the link is stale, not ours to convert
  if (!ownExists) {
    if (!hasSource) return; // the scan reports it as broken
    const { recipe, error } = parseRecipe(join(sourceDir, "session.json"));
    if (!recipe) {
      log.push(`legacy link ${dir}: ${error}`);
      return;
    }
    recipe.folder = resolve(target);
    try {
      writeRecipe(dir, recipe);
    } catch (e) {
      log.push(`legacy link ${dir}: ${(e as Error).message}`); // the source stays in place
      return;
    }
  }
  // an earlier run that died after writing the recipe (`own` has a folder) only finishes the cleanup below
  try {
    if (hasSource) {
      rmSync(join(sourceDir, "session.json"), { force: true });
      rmSync(join(sourceDir, "config.yml"), { force: true });
      if (archived) rmSync(projectDir, { recursive: true, force: true });
      else if (readdirSync(targetOrch).length === 0) rmdirSync(targetOrch);
    }
    rmSync(linkFile(dir), { force: true });
  } catch (e) {
    log.push(`legacy link ${dir}: cleanup failed: ${(e as Error).message}`);
    return;
  }
  log.push(`migrated ${dir} → folder ${target}`);
}
