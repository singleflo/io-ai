// Process layer: PTY spawn and process-tree termination. POSIX only for now (Bun.spawn terminal);
// everything else in term-ui uses cross-platform APIs so a ConPTY backend can be added here.
import type { Subprocess } from "bun";

export type PtyExit = { code: number | null; signal: string | null };
export type PtyProc = {
  pid: number;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  exited: Promise<PtyExit>;
};
export type PtyOptions = {
  cwd: string;
  env: Record<string, string>;
  cols: number;
  rows: number;
  onData(chunk: string): void;
};

export function assertPtySupported() {
  if (process.platform === "win32") {
    console.error("term-ui: Windows terminal backend (ConPTY) is not implemented yet");
    process.exit(1);
  }
}

export function spawnPty(args: string[], o: PtyOptions): PtyProc {
  const decoder = new TextDecoder();
  const proc: Subprocess = Bun.spawn(args, {
    cwd: o.cwd,
    env: o.env,
    terminal: { cols: o.cols, rows: o.rows, data: (_t, bytes) => o.onData(decoder.decode(bytes, { stream: true })) },
  });
  const term = proc.terminal;
  if (!term) throw new Error("terminal backend unavailable");
  return {
    pid: proc.pid,
    write: d => term.write(d),
    resize: (c, r) => term.resize(c, r),
    exited: proc.exited.then(code => ({ code: proc.signalCode ? null : code, signal: proc.signalCode ?? null })),
  };
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

// pid + every descendant, from `ps -A -o pid=,ppid=`.
async function descendants(root: number): Promise<number[]> {
  const p = Bun.spawn(["ps", "-A", "-o", "pid=,ppid="], { stdout: "pipe" });
  const text = await new Response(p.stdout).text();
  const children = new Map<number, number[]>();
  for (const line of text.split("\n")) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);
    if (!pid || Number.isNaN(ppid)) continue;
    children.set(ppid, [...(children.get(ppid) ?? []), pid]);
  }
  const all: number[] = [];
  const walk = (pid: number) => {
    all.push(pid);
    for (const c of children.get(pid) ?? []) walk(c);
  };
  walk(root);
  return all;
}

// SIGTERM to the whole tree, SIGKILL to survivors after graceMs (a frozen process ignores SIGTERM).
export async function terminateTree(pid: number, graceMs = 5000) {
  if (process.platform === "win32") {
    Bun.spawn(["taskkill", "/PID", String(pid), "/T", "/F"]);
    return;
  }
  const tree = await descendants(pid);
  for (const p of tree) {
    try {
      process.kill(p, "SIGTERM");
    } catch {}
  }
  setTimeout(() => {
    for (const p of tree) if (alive(p)) {
      try {
        process.kill(p, "SIGKILL");
      } catch {}
    }
  }, graceMs);
}
