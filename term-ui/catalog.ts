// Catalog: a snapshot of the omp installation (models, usage, config, MCP, skills) read through omp's own CLI.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Recipe, Roles } from "./workspace";
import { workspaceRoot } from "./workspace";
import { SDK_BUN } from "./core";
import { existsSync, readdirSync } from "node:fs";

export type McpServer = { type?: string; command?: string; args?: string[]; url?: string; enabled?: boolean };
export type Catalog = {
  builtAt: string;
  ompVersion: string | null;
  agentDir: string | null;
  models: string[] | null;
  modelRoles: Roles | null;
  compactionThresholdPercent: number | null;
  toolToggles: Record<string, boolean> | null;
  mcpServers: Record<string, McpServer> | null;
  skills: { name: string; filePath: string }[] | null;
  workspaceSkills: { name: string; role: string }[] | null;
  usage: { anthropic7dUsedFraction: number | null } | null;
  hashes: { config: string | null; mcp: string | null };
  builtinTools: string[]; // built-in omp tool names (the `tools` allowlist is chosen among them)
  missing: string[]; // commands that failed
};

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

async function run(cmd: string[]): Promise<string | null> {
  try {
    const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
    const text = await new Response(p.stdout).text();
    return (await p.exited) === 0 ? text : null;
  } catch {
    return null;
  }
}

const json = <T>(s: string | null): T | null => {
  if (s === null) return null;
  try {
    return JSON.parse(s) as T;
  } catch {
    return null;
  }
};

export async function ompVersion(): Promise<string | null> {
  const v = (await run(["omp", "--version"]))?.trim();
  return v ? v.replace(/^omp\//, "") : null;
}

export function fileHashes(agentDir: string | null): Catalog["hashes"] {
  const h = (f: string) => (agentDir && existsSync(join(agentDir, f)) ? sha(readFileSync(join(agentDir, f), "utf8")) : null);
  return { config: h("config.yml"), mcp: h("mcp.json") };
}

export async function buildCatalog(): Promise<Catalog> {
  const [version, agentDirRaw, config, models, usage, skills, builtin] = await Promise.all([
    ompVersion(),
    run(["omp", "config", "path"]),
    run(["omp", "config", "list", "--json"]),
    run(["omp", "models", "--json"]),
    run(["omp", "usage", "--json"]),
    run(["omp", "skill", "list", "--json"]),
    run([SDK_BUN, join(import.meta.dir, "omp-sdk.ts"), "tools"]),
  ]);
  const agentDir = agentDirRaw?.trim() || null;
  const missing: string[] = [];
  const need = <T>(name: string, v: T | null): T | null => (v === null ? (missing.push(name), null) : v);

  const cfg = need("config list", json<Record<string, { value: unknown }>>(config));
  const mod = need("models", json<{ models: { selector: string }[] }>(models));
  const use = need("usage", json<{ reports: { provider: string; limits: { id: string; amount?: { usedFraction?: number } }[] }[] }>(usage));
  const sk = need("skill list", json<{ skills: { name: string; filePath: string }[] }>(skills));
  const tools = need("builtin tools", json<{ tools: string[] }>(builtin));

  let mcpServers: Catalog["mcpServers"] = null;
  if (agentDir && existsSync(join(agentDir, "mcp.json"))) {
    const raw = json<{ mcpServers?: Record<string, McpServer> }>(readFileSync(join(agentDir, "mcp.json"), "utf8"));
    mcpServers = {};
    for (const [name, d] of Object.entries(raw?.mcpServers ?? {})) mcpServers[name] = { type: d.type, command: d.command, args: d.args, url: d.url, enabled: d.enabled !== false };
  }

  const toolToggles: Record<string, boolean> = {};
  for (const [k, v] of Object.entries(cfg ?? {})) if (/^[a-zA-Z]+\.enabled$/.test(k) && typeof v.value === "boolean") toolToggles[k.replace(".enabled", "")] = v.value;
  const anthropic7d = use?.reports.find(r => r.provider === "anthropic")?.limits.find(l => l.id === "anthropic:7d")?.amount?.usedFraction ?? null;

  return {
    builtAt: new Date().toISOString(),
    ompVersion: version,
    agentDir,
    models: mod ? mod.models.map(m => m.selector) : null,
    modelRoles: (cfg?.modelRoles?.value as Roles | undefined) ?? null,
    compactionThresholdPercent: (cfg?.["compaction.thresholdPercent"]?.value as number | undefined) ?? null,
    toolToggles: cfg ? toolToggles : null,
    mcpServers,
    skills: sk ? sk.skills.map(s => ({ name: s.name, filePath: s.filePath })) : null,
    workspaceSkills: workspaceSkills(),
    usage: use ? { anthropic7dUsedFraction: anthropic7d } : null,
    hashes: fileHashes(agentDir),
    builtinTools: tools ? tools.tools : [],
    missing,
  };
}

// Skills shipped in the orchestrator repo and in the workspace: common for every session, root for roots only.
function workspaceSkills(): { name: string; role: string }[] {
  const out: { name: string; role: string }[] = [];
  for (const [dir, role] of [[resolve(import.meta.dir, "..", "skills"), "repo"], [resolve(workspaceRoot(), ".orch", "skills"), "workspace"]] as const)
    for (const area of ["common", "root"] as const) {
      const p = join(dir, area);
      if (!existsSync(p)) continue;
      for (const e of readdirSync(p, { withFileTypes: true })) if (e.isDirectory()) out.push({ name: e.name, role: `${role}/${area}` });
    }
  return out;
}

export const saveCatalog = (file: string, c: Catalog) => writeFileSync(file, `${JSON.stringify(c, null, 2)}\n`);

// Deterministic default recipe from the catalog.
export function recipeDefaults(c: Catalog, kind: "root" | "child"): Partial<Recipe> {
  const quotaTight = (c.usage?.anthropic7dUsedFraction ?? 0) > 0.9;
  const base: Partial<Recipe> = kind === "root" ? { mcp: "all", compactPercent: null } : { mcp: [], compactPercent: 55 };
  if (quotaTight) return { ...base, model: "zai/glm-5.3", thinking: "high", roles: { task: "zai/glm-5.3-flash:low", smol: "zai/glm-5.3-flash:low" } };
  const def = c.modelRoles?.default;
  const [model, level] = def ? def.split(":") : [undefined, undefined];
  return { ...base, model, thinking: level, roles: null };
}
