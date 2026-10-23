// Persistent terminal scrollback: `<ws>/.orch/scrollback/<peer>.log`, one file per route (`/` -> `.`).
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { orchDir, peerOf } from "./workspace";

const fileOf = (ws: string, route: string) => join(orchDir(ws), "scrollback", `${peerOf(route)}.log`);

export function loadScrollback(ws: string, route: string): string {
  try {
    return readFileSync(fileOf(ws, route), "utf8");
  } catch {
    return "";
  }
}

export function saveScrollback(ws: string, route: string, text: string) {
  mkdirSync(join(orchDir(ws), "scrollback"), { recursive: true });
  writeFileSync(fileOf(ws, route), text);
}

// A moved or restored route keeps its history.
export function renameScrollback(ws: string, from: string, to: string) {
  const src = fileOf(ws, from);
  const dst = fileOf(ws, to);
  if (src !== dst && existsSync(src) && !existsSync(dst)) renameSync(src, dst);
}
