// Deliverables: files an agent produced (`outbox/` of its session dir first, then the newest files of its working folder).
import { readdirSync, realpathSync, statSync } from "node:fs";
import { basename, join, relative, resolve, sep } from "node:path";
import type { Session } from "./core";

export type SessionFile = { path: string; size: number; mtime: number; root: "dir" | "folder" };

const OUTBOX_MAX = 200;
const RECENT_MAX = 100;
const RECENT_DEPTH = 4;
const SKIP = new Set([".git", "node_modules", ".orch", ".omp", "outbox"]);

// Regular files under `dir` (symlinks are never followed), paths relative to `base`, tagged with the `root` they are served from.
function walk(base: string, dir: string, depth: number, skip: Set<string>, out: SessionFile[], root: SessionFile["root"]) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      if (depth > 0 && !skip.has(e.name)) walk(base, full, depth - 1, skip, out, root);
    } else if (e.isFile()) {
      try {
        const st = statSync(full);
        out.push({ path: relative(base, full).split(sep).join("/"), size: st.size, mtime: Math.round(st.mtimeMs), root });
      } catch {}
    }
  }
}

const newest = (files: SessionFile[], max: number) => files.sort((a, b) => b.mtime - a.mtime).slice(0, max);

export function listFiles(s: Session): { outbox: SessionFile[]; recent: SessionFile[] } {
  const outbox: SessionFile[] = [];
  walk(s.dir, join(s.dir, "outbox"), 32, new Set(), outbox, "dir");
  const recent: SessionFile[] = [];
  walk(s.folder, s.folder, RECENT_DEPTH, SKIP, recent, "folder");
  return { outbox: newest(outbox, OUTBOX_MAX), recent: newest(recent, RECENT_MAX) };
}

const INLINE: Record<string, string> = {
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  txt: "text/plain; charset=utf-8",
  md: "text/plain; charset=utf-8",
  json: "application/json",
  csv: "text/plain; charset=utf-8",
  html: "text/plain; charset=utf-8", // never rendered: an agent-written page must not run in the UI origin
};

/** `GET /api/sessions/<r>/file?path=<relative>&root=dir|folder`: the real path must stay inside the real session dir (`dir`) or working folder. */
export function serveFile(s: Session, rel: string | null, rootParam: string | null): Response {
  if (!rel) return new Response("path required", { status: 400 });
  const outside = new Response("path outside session folder", { status: 400 });
  const root = resolve(rootParam === "dir" ? s.dir : s.folder);
  const lexical = resolve(root, rel);
  if (lexical !== root && !lexical.startsWith(root + sep)) return outside;
  let real: string;
  let realRoot: string;
  try {
    realRoot = realpathSync(root);
    real = realpathSync(lexical);
  } catch {
    return new Response("not found", { status: 404 });
  }
  if (real !== realRoot && !real.startsWith(realRoot + sep)) return outside;
  if (!statSync(real).isFile()) return new Response("not a file", { status: 400 });
  const ext = real.split(".").pop()?.toLowerCase() ?? "";
  const type = INLINE[ext];
  const name = encodeURIComponent(basename(real));
  return new Response(Bun.file(real), {
    headers: {
      "content-type": type ?? "application/octet-stream",
      "content-disposition": `${type ? "inline" : "attachment"}; filename*=UTF-8''${name}`,
      ...(ext === "svg" ? { "content-security-policy": "sandbox" } : {}), // an SVG opened in a tab cannot script the UI origin (the sandbox would break the PDF viewer)
      "x-content-type-options": "nosniff",
    },
  });
}
