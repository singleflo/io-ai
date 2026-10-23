// Role presets: `presets/<role>/preset.json` + `AGENTS.md` in the repo, overridable per role in `<ws>/.orch/presets/<role>/`.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { NAME_RE, orchDir, workspaceRoot, type EnvSpec, type Recipe } from "./workspace";

export type Preset = {
  label: string;
  kind: "child";
  purpose: string;
  model?: string;
  thinking?: string;
  mcp: string[];
  skills: string[] | null;
  tools: string[] | null;
  env: EnvSpec;
  approve: string[];
  schedules: { cron: string; text: string }[];
};

const repoPresets = () => join(resolve(import.meta.dir, ".."), "presets");
const dirs = () => [join(orchDir(workspaceRoot()), "presets"), repoPresets()]; // the workspace wins by role name

const roleDir = (role: string): string | undefined => (NAME_RE.test(role) ? dirs().map(d => join(d, role)).find(d => existsSync(join(d, "preset.json"))) : undefined);

export type LoadedPreset = { role: string; preset: Preset; agents: string | undefined };

export function loadPreset(role: string): LoadedPreset | undefined {
  const dir = roleDir(role);
  if (!dir) return undefined;
  try {
    const preset = JSON.parse(readFileSync(join(dir, "preset.json"), "utf8")) as Preset;
    const agentsFile = join(dir, "AGENTS.md");
    return { role, preset, agents: existsSync(agentsFile) ? readFileSync(agentsFile, "utf8") : undefined };
  } catch {
    return undefined;
  }
}

export function listPresets(): { role: string; label: string; preset: Preset }[] {
  const roles = new Set<string>();
  for (const d of dirs()) if (existsSync(d)) for (const e of readdirSync(d, { withFileTypes: true })) if (e.isDirectory()) roles.add(e.name);
  return [...roles].sort().flatMap(role => {
    const p = loadPreset(role);
    return p ? [{ role, label: p.preset.label, preset: p.preset }] : [];
  });
}

/**
 * Recipe fields a preset supplies. MCP names absent from the catalog are dropped (reported in `warnings`).
 * Schedules get `enabled: true`; ids are assigned by the caller's normalization.
 */
export function presetFields(p: Preset, catalogMcp: string[] | null): { fields: Partial<Recipe>; warnings: string[] } {
  const warnings: string[] = [];
  const mcp = catalogMcp ? p.mcp.filter(n => catalogMcp.includes(n) || (warnings.push(`mcp server not in catalog: ${n}`), false)) : p.mcp;
  const fields: Partial<Recipe> = {
    purpose: p.purpose,
    mcp,
    skills: p.skills,
    tools: p.tools,
    env: p.env,
    approve: p.approve,
    schedules: p.schedules.map(s => ({ id: "", cron: s.cron, text: s.text, enabled: true })),
  };
  if (p.model) fields.model = p.model;
  if (p.thinking) fields.thinking = p.thinking;
  return { fields, warnings };
}
