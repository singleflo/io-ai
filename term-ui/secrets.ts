// Secrets store (`<ws>/.orch/secrets.json`, mode 0600) and the environment a session process receives.
// Values never leave this module except into a child's environment: the API lists names only.
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { orchDir, workspaceRoot, type EnvSpec } from "./workspace";

export const SECRET_NAME_RE = /^[A-Z_][A-Z0-9_]*$/;

const file = () => join(orchDir(workspaceRoot()), "secrets.json");

function load(): Record<string, string> {
  try {
    const v = JSON.parse(readFileSync(file(), "utf8")) as Record<string, unknown>;
    return Object.fromEntries(Object.entries(v).filter((e): e is [string, string] => typeof e[1] === "string"));
  } catch {
    return {};
  }
}

function save(all: Record<string, string>) {
  mkdirSync(orchDir(workspaceRoot()), { recursive: true });
  const tmp = `${file()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(all, null, 2)}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file());
}

export const secretNames = (): string[] => Object.keys(load()).sort();

export function setSecret(name: string, value: string) {
  save({ ...load(), [name]: value });
}

export function deleteSecret(name: string): boolean {
  const all = load();
  if (!(name in all)) return false;
  delete all[name];
  save(all);
  return true;
}

export const DEFAULT_ENV: EnvSpec = { inherit: "all", secrets: [] };

const MINIMAL_KEYS = new Set(["PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "TMPDIR", "SSH_AUTH_SOCK"]);
const MINIMAL_PREFIXES = ["LC_", "XDG_", "OMP_", "PI_"];

/**
 * The base environment of a session process (before the orch variables are added).
 * `minimal` keeps a short allowlist; both modes add every selected secret: the value from the store,
 * else from the server's own environment. Names that resolve nowhere are returned in `missing`.
 */
export function baseEnv(spec: EnvSpec | undefined, source: Record<string, string | undefined>): { env: Record<string, string>; missing: string[] } {
  const { inherit, secrets } = spec ?? DEFAULT_ENV;
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(source)) {
    if (v === undefined) continue;
    if (inherit === "all" || MINIMAL_KEYS.has(k) || MINIMAL_PREFIXES.some(p => k.startsWith(p))) env[k] = v;
  }
  const stored = secrets.length ? load() : {};
  const missing: string[] = [];
  for (const name of secrets) {
    const v = stored[name] ?? source[name];
    if (v === undefined) missing.push(name);
    else env[name] = v;
  }
  return { env, missing };
}

/** Validation of a recipe `env` value from an API body; returns an error text or undefined. */
export function checkEnv(v: unknown): string | undefined {
  if (v === null || v === undefined) return undefined;
  if (typeof v !== "object" || Array.isArray(v)) return "env must be an object";
  const { inherit, secrets } = v as { inherit?: unknown; secrets?: unknown };
  if (inherit !== undefined && inherit !== "all" && inherit !== "minimal") return "env.inherit must be all or minimal";
  if (secrets !== undefined && (!Array.isArray(secrets) || secrets.some(n => typeof n !== "string" || !SECRET_NAME_RE.test(n)))) return "env.secrets must be a list of secret names";
  return undefined;
}

/** Normalizes a validated `env` body value: the default (`all`, no secrets) is stored as unset so it never raises `restart-needed`. */
export function normalizeEnv(v: unknown): EnvSpec | null {
  if (v === null || v === undefined) return null;
  const { inherit = "all", secrets = [] } = v as Partial<EnvSpec>;
  return inherit === "all" && !secrets.length ? null : { inherit, secrets };
}

/** `/api/secrets` routes. `rest` = path parts after `secrets`. */
export async function handleSecrets(req: Request, rest: string[]): Promise<Response> {
  const name = rest[0];
  if (!name) return req.method === "GET" ? Response.json(secretNames()) : new Response("method not allowed", { status: 405 });
  if (!SECRET_NAME_RE.test(name)) return new Response("invalid secret name (A-Z, 0-9, _)", { status: 400 });
  if (req.method === "PUT") {
    const body = (await req.json().catch(() => ({}))) as { value?: unknown };
    if (typeof body.value !== "string" || !body.value) return new Response("value required", { status: 400 });
    setSecret(name, body.value);
    return Response.json({ ok: true });
  }
  if (req.method === "DELETE") return deleteSecret(name) ? Response.json({ ok: true }) : new Response("unknown secret", { status: 404 });
  return new Response("method not allowed", { status: 405 });
}
