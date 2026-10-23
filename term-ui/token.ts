// Server access token: one random secret per workspace, stored at `<ws>/.orch/token` (mode 0600).
import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const tokenFile = (ws: string) => join(ws, ".orch", "token");

export function readToken(ws: string): string | undefined {
  try {
    return readFileSync(tokenFile(ws), "utf8").trim() || undefined;
  } catch {
    return undefined;
  }
}

// Creates the token file when missing and returns the token.
export function ensureToken(ws: string): string {
  const existing = readToken(ws);
  if (existing) return existing;
  mkdirSync(join(ws, ".orch"), { recursive: true });
  const token = randomBytes(32).toString("hex");
  const file = tokenFile(ws);
  if (!existsSync(file)) writeFileSync(file, `${token}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
  return readToken(ws) ?? token;
}

export function tokenMatches(given: string | null | undefined, token: string): boolean {
  if (!given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function cookieValue(header: string | null, name: string): string | undefined {
  for (const part of (header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return undefined;
}
