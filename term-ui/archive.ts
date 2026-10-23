// Archive support for linked sessions: the project's `.orch` directory (recipe + config) travels inside the archived
// link folder at `<linkDir>/.orch/project/`, so an archived session leaves nothing of orch in the external project.
import { cpSync, existsSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { removeOwnedMcp, type Session } from "./core";
import { linkFile } from "./workspace";

const PROJECT = "project"; // `<linkDir>/.orch/project/` holds the project's `.orch` while archived
const SKIP: Record<string, true> = { ".git": true, node_modules: true };

const isDir = (p: string) => existsSync(p) && statSync(p).isDirectory();

// rename; across devices copy + remove
function moveDir(from: string, to: string) {
  try {
    renameSync(from, to);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EXDEV") throw e;
    cpSync(from, to, { recursive: true });
    rmSync(from, { recursive: true, force: true });
  }
}

/** Moves the project `.orch` of every linked session in `subtree` into its link folder and cleans the project's MCP file. */
export function detachProjects(subtree: Session[]): void {
  for (const x of subtree) {
    if (!x.linked || !x.linkDir) continue;
    const projectOrch = join(x.folder, ".orch");
    if (!isDir(projectOrch)) continue;
    removeOwnedMcp(x.folder, x.recipe?.mcpOwned ?? []);
    moveDir(projectOrch, join(x.linkDir, ".orch", PROJECT));
    const omp = join(x.folder, ".omp");
    if (isDir(omp) && !readdirSync(omp).length) rmSync(omp, { recursive: true });
  }
}

type ArchivedLink = { linkDir: string; target: string };

// Link folders under `dir` that hold an archived project (`.orch/link.json` next to `.orch/project/`).
function archivedLinks(dir: string): ArchivedLink[] {
  const out: ArchivedLink[] = [];
  const walk = (d: string) => {
    const project = join(d, ".orch", PROJECT);
    if (isDir(project)) {
      try {
        const link = JSON.parse(readFileSync(linkFile(d), "utf8")) as { target?: unknown };
        if (typeof link.target === "string" && link.target) out.push({ linkDir: d, target: resolve(link.target) });
      } catch {
        // no readable link: nothing to reattach
      }
    }
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory() && e.name !== ".orch" && !SKIP[e.name]) walk(join(d, e.name));
    }
  };
  if (isDir(dir)) walk(dir);
  return out;
}

/** Targets under `dir` whose project already has an `.orch` folder: restoring would overwrite it. */
export function projectConflicts(dir: string): string[] {
  return archivedLinks(dir).filter(l => existsSync(join(l.target, ".orch"))).map(l => l.target);
}

/** Moves every archived project `.orch` under `dir` back to its target. Returns a warning when a target is missing. */
export function reattachProjects(dir: string): string | undefined {
  const missing: string[] = [];
  for (const l of archivedLinks(dir)) {
    if (!isDir(l.target)) {
      missing.push(l.target);
      continue;
    }
    moveDir(join(l.linkDir, ".orch", PROJECT), join(l.target, ".orch"));
  }
  return missing.length ? `project folder missing, recipe kept in the link: ${missing.join(", ")}` : undefined;
}
