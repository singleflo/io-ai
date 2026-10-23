// Workspace model: a session is a folder containing `.orch/session.json`; routes are relative folder paths.
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";

export type Roles = { default?: string; task?: string; smol?: string; plan?: string; slow?: string };
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
  createdBy?: string;
  createdAt?: string;
  mcpOwned?: string[]; // MCP server names orch wrote into `<folder>/.omp/mcp.json` (disabled user-level servers)
};
export type Kind = "root" | "child";
export type Found = {
  route: string;
  name: string;
  folder: string;
  linked?: boolean; // folder is reached through a workspace link (.orch/link.json); linkDir is the route's own directory
  linkDir?: string;
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
  return process.env.ORCH_HOME ?? (flag > 0 ? process.argv[flag + 1] : undefined) ?? join(homedir(), "orch");
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
export const peerOf = (route: string) => route.replaceAll("/", ".");

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

export function readRecipe(folder: string): { recipe: Recipe | null; error?: string } {
  try {
    const raw = JSON.parse(readFileSync(sessionFile(folder), "utf8")) as Recipe;
    return { recipe: { ...raw, previousSessionIds: raw.previousSessionIds ?? [] } };
  } catch (e) {
    return { recipe: null, error: (e as Error).message };
  }
}

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

// Recursive scan. Skips dot/underscore dirs, node_modules and symlinks; a session folder's children are scanned too.
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
      const target = readLink(dir2); // a link registers an external folder as the session's folder
      if (target !== undefined) {
        const folder = existsSync(target) ? target : dir2;
        const { recipe, error } = existsSync(target) ? readRecipe(folder) : { recipe: null, error: `link target missing: ${target}` };
        const route = toRoute(ws, dir2);
        found.push({ route, name: e.name, folder, linked: true, linkDir: dir2, parent, kind: parent ? "child" : "root", depth, recipe, recipeError: error });
        // children of a linked session are links placed under the link directory; the target tree is not scanned
      } else if (existsSync(sessionFile(dir2))) {
        const { recipe, error } = readRecipe(dir2);
        const route = toRoute(ws, dir2);
        found.push({ route, name: e.name, folder: dir2, parent, kind: parent ? "child" : "root", depth, recipe, recipeError: error });
        walk(dir2, route, depth + 1);
      } else {
        walk(dir2, parent, depth);
      }
    }
  };
  walk(ws, null, 0);
  return found;
}
