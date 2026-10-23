// Folder inspection for the wizard: server-side directory picker and "what does this folder already hold".
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { bucketSessions, ctx, heldLeases } from "./core";
import { linkFile, sessionFile } from "./workspace";

export class FolderError extends Error {}

const isDir = (p: string) => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

function requireDir(dir: string): string {
  if (!isAbsolute(dir) || !isDir(dir)) throw new FolderError("folder must be an existing absolute path");
  return dir;
}

// ---------- GET /api/fs ----------
export type FsEntry = { name: string; path: string; isSession: boolean; isGit: boolean };

export function listDirs(dirParam: string | null): { dir: string; parent: string | null; entries: FsEntry[] } {
  const dir = requireDir(dirParam || homedir());
  const entries: FsEntry[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith(".")) continue;
    const path = join(dir, e.name);
    if (!(e.isDirectory() || (e.isSymbolicLink() && isDir(path)))) continue;
    entries.push({ name: e.name, path, isSession: existsSync(sessionFile(path)) || existsSync(linkFile(path)), isGit: existsSync(join(path, ".git")) });
  }
  entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
  return { dir, parent: dirname(dir) === dir ? null : dirname(dir), entries };
}

// ---------- conversations ----------
const HEAD_BYTES = 64 * 1024;
const TAIL_BYTES = 256 * 1024;

function readRange(file: string, from: number, bytes: number): string {
  const fd = openSync(file, "r");
  try {
    const buf = Buffer.alloc(bytes);
    return buf.toString("utf8", 0, readSync(fd, buf, 0, bytes, from));
  } finally {
    closeSync(fd);
  }
}

type Line = { type?: string; title?: string; model?: string; role?: string; message?: { role?: string; content?: string | { type?: string; text?: string }[] } };

function parseLines(text: string): Line[] {
  const out: Line[] = [];
  for (const line of text.split("\n")) {
    if (!line.startsWith("{")) continue;
    try {
      out.push(JSON.parse(line) as Line);
    } catch {} // a range cut mid-line
  }
  return out;
}

const modelOf = (lines: Line[]): string | undefined =>
  lines.findLast(e => e.type === "model_change" && e.model && (!e.role || e.role === "default"))?.model?.split(":")[0];

function firstUserText(lines: Line[]): string | undefined {
  for (const e of lines) {
    if (e.type !== "message" || e.message?.role !== "user") continue;
    const c = e.message.content;
    const text = typeof c === "string" ? c : c?.find(p => p.type === "text" && p.text)?.text;
    if (text?.trim()) return text.trim();
  }
  return undefined;
}

// Title: the `title` entry of the head, else the first user message (80 chars); model: last default-role model_change.
export function conversationMeta(file: string): { title: string | null; model: string | null } {
  const head = parseLines(readRange(file, 0, HEAD_BYTES));
  const size = statSync(file).size;
  const tail = size > HEAD_BYTES ? parseLines(readRange(file, Math.max(HEAD_BYTES, size - TAIL_BYTES), TAIL_BYTES)) : [];
  const title = head.find(e => e.type === "title" && e.title)?.title ?? firstUserText(head)?.replace(/\s+/g, " ").slice(0, 80);
  return { title: title ?? null, model: modelOf(tail) ?? modelOf(head) ?? null };
}

// ---------- GET /api/folder-info ----------
const SKILL_ROOTS = [".omp", ".agents", ".claude"];
const MCP_FILES = [".omp/mcp.json", ".mcp.json", "mcp.json"];

function projectSkills(folder: string): { name: string; source: string }[] {
  const out = new Map<string, string>();
  for (const root of SKILL_ROOTS) {
    const dir = join(folder, root, "skills");
    if (!isDir(dir)) continue;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const file = join(dir, e.name, "SKILL.md");
      if (!existsSync(file)) continue;
      const declared = /^name:\s*["']?([^"'\r\n]+?)["']?\s*$/m.exec(readFileSync(file, "utf8").slice(0, 4096))?.[1];
      const name = declared || e.name;
      if (!out.has(name)) out.set(name, `${root}/skills`);
    }
  }
  return [...out].map(([name, source]) => ({ name, source }));
}

function projectMcp(folder: string, owned: Set<string>, errors: string[]): { name: string; source: string; enabled: boolean }[] {
  const out = new Map<string, { name: string; source: string; enabled: boolean }>();
  for (const rel of MCP_FILES) {
    const file = join(folder, rel);
    if (!existsSync(file)) continue;
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as { mcpServers?: Record<string, { enabled?: boolean }> };
      const servers = parsed.mcpServers ?? {};
      for (const [name, d] of Object.entries(servers)) if (!owned.has(name) && !out.has(name)) out.set(name, { name, source: rel, enabled: d?.enabled !== false });
    } catch (e) {
      errors.push(`${rel}: ${(e as Error).message}`);
    }
  }
  return [...out.values()];
}

export type Conversation = { id: string; title: string | null; modified: string; model: string | null; live: boolean };

export async function folderInfo(folderParam: string, route: string | null) {
  const folder = requireDir(folderParam);
  const errors: string[] = [];
  const files = (await bucketSessions(folder)).slice(0, 20);
  const held = files.length ? await heldLeases(files.map(f => f.id)) : {};
  const conversations: Conversation[] = files.map(f => {
    let meta: { title: string | null; model: string | null } = { title: null, model: null };
    try {
      meta = conversationMeta(f.path);
    } catch (e) {
      errors.push(`${f.id}: ${(e as Error).message}`);
    }
    return { id: f.id, ...meta, modified: statSync(f.path).mtime.toISOString(), live: held[f.id] === true };
  });
  const owned = new Set(route ? ctx.sessions.get(route)?.recipe?.mcpOwned ?? [] : []);
  return {
    folder,
    isGit: existsSync(join(folder, ".git")),
    hasAgentsMd: existsSync(join(folder, "AGENTS.md")),
    isSession: existsSync(sessionFile(folder)) || existsSync(linkFile(folder)),
    conversations,
    projectSkills: projectSkills(folder),
    projectMcp: projectMcp(folder, owned, errors),
    errors,
  };
}
