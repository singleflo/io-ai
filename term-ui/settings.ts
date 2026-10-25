// Global settings (`<ws>/.orch/settings.json`): which omp models are visible and the model defaults of new sessions.
// The model filter is visibility only: the server keeps accepting every catalog model.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { orchDir, workspaceRoot } from "./workspace";

export type ModelPick = { model: string | null; thinking: string | null; task: string | null; smol: string | null };
export type Settings = { models: string[] | null; defaults: { root: ModelPick; child: ModelPick }; quotaFallback: ModelPick | null };

export const THINKING_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;

const emptyPick = (): ModelPick => ({ model: null, thinking: null, task: null, smol: null });

export const DEFAULT_SETTINGS: Settings = {
  models: null,
  defaults: { root: emptyPick(), child: emptyPick() },
  quotaFallback: { model: "zai/glm-5.3", thinking: "high", task: "zai/glm-5.3-flash:low", smol: "zai/glm-5.3-flash:low" },
};

const file = () => join(orchDir(workspaceRoot()), "settings.json");

const clone = (s: Settings): Settings => structuredClone(s);

export function loadSettings(): Settings {
  let text: string;
  try {
    text = readFileSync(file(), "utf8");
  } catch {
    return clone(DEFAULT_SETTINGS);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    console.error(`settings.json ignored: ${e instanceof Error ? e.message : String(e)}`);
    return clone(DEFAULT_SETTINGS);
  }
  const v = validateSettings(parsed, null);
  if (typeof v === "string") {
    console.error(`settings.json ignored: ${v}`);
    return clone(DEFAULT_SETTINGS);
  }
  return v;
}

export function saveSettings(s: Settings): void {
  mkdirSync(orchDir(workspaceRoot()), { recursive: true });
  const tmp = `${file()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(s, null, 2)}\n`);
  renameSync(tmp, file());
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isLevel = (v: string) => (THINKING_LEVELS as readonly string[]).includes(v);

type Field = { value: string | null } | { error: string };

// A field that is null or a string; anything else is an error.
function nullableString(v: unknown, label: string): Field {
  if (v === null || v === undefined) return { value: null };
  return typeof v === "string" ? { value: v } : { error: `${label} must be a string or null` };
}

// A model reference: must exist in the catalog and be visible. `where` is used in the error texts.
function checkModel(m: string, where: string, catalogModels: string[] | null, visible: string[] | null, modelLabel: boolean): string | undefined {
  if (catalogModels && !catalogModels.includes(m)) return `unknown model: ${m}`;
  if (visible && !visible.includes(m)) return `${where}${modelLabel ? " model" : ""} not in the visible list: ${m}`;
  return undefined;
}

function checkPick(v: unknown, where: string, catalogModels: string[] | null, visible: string[] | null): ModelPick | string {
  if (!isRecord(v)) return `${where} must be an object`;
  const pick = emptyPick();
  const model = nullableString(v.model, `${where} model`);
  if ("error" in model) return model.error;
  if (model.value !== null) {
    const err = checkModel(model.value, where, catalogModels, visible, true);
    if (err) return err;
  }
  pick.model = model.value;
  const thinking = nullableString(v.thinking, `${where} thinking`);
  if ("error" in thinking) return thinking.error;
  if (thinking.value !== null && !isLevel(thinking.value)) return `invalid thinking level: ${thinking.value}`;
  pick.thinking = thinking.value;
  for (const role of ["task", "smol"] as const) {
    const f = nullableString(v[role], `${where} ${role}`);
    if ("error" in f) return f.error;
    if (f.value === null) continue;
    const cut = f.value.lastIndexOf(":");
    const base = cut < 0 ? f.value : f.value.slice(0, cut);
    const level = cut < 0 ? null : f.value.slice(cut + 1);
    if (level !== null && !isLevel(level)) return `invalid thinking level: ${level}`;
    const err = checkModel(base, `${where} ${role}`, catalogModels, visible, false);
    if (err) return err;
    pick[role] = f.value;
  }
  return pick;
}

/** Validates an API/body value. Returns the normalized settings or the first error as text. `catalogModels` null = catalog unknown (membership is not checked). */
export function validateSettings(body: unknown, catalogModels: string[] | null): Settings | string {
  if (!isRecord(body)) return "settings must be an object";
  let models: string[] | null = null;
  if (body.models !== null && body.models !== undefined) {
    if (!Array.isArray(body.models) || !body.models.length) return "select at least one model";
    const list: string[] = [];
    for (const m of body.models) {
      if (typeof m !== "string") return "models must be strings";
      if (catalogModels && !catalogModels.includes(m)) return `unknown model: ${m}`;
      if (!list.includes(m)) list.push(m);
    }
    models = list;
  }
  if (!isRecord(body.defaults)) return "defaults must be an object";
  const root = checkPick(body.defaults.root, "root", catalogModels, models);
  if (typeof root === "string") return root;
  const child = checkPick(body.defaults.child, "child", catalogModels, models);
  if (typeof child === "string") return child;
  let quotaFallback: ModelPick | null = null;
  if (body.quotaFallback !== null && body.quotaFallback !== undefined) {
    const q = checkPick(body.quotaFallback, "quota fallback", catalogModels, models);
    if (typeof q === "string") return q;
    quotaFallback = q;
  }
  return { models, defaults: { root, child }, quotaFallback };
}

export const visibleModels = (all: string[] | null, s: Settings): string[] | null => {
  const allowed = s.models;
  return all && allowed ? all.filter(m => allowed.includes(m)) : all;
};
