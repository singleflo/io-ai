#!/usr/bin/env bun
// Helper process around the omp SDK (kept out of the server process).
// Prints exactly one JSON line. Exit codes: 0 ok, 1 error, 3 refused / busy.
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { tryAcquireSessionLease } from "@oh-my-pi/pi-coding-agent/session/session-storage";

const [cmd, ...args] = process.argv.slice(2);
const out = (value: unknown, code = 0): never => {
  console.log(JSON.stringify(value));
  process.exit(code);
};

try {
  switch (cmd) {
    case "lease": {
      const handle = tryAcquireSessionLease(args[0]);
      if (!handle) out({ free: false }, 3);
      handle!.release();
      out({ free: true });
      break;
    }
    case "leases": {
      // true = the conversation is held by another process
      const held: Record<string, boolean> = {};
      for (const id of args) {
        const handle = tryAcquireSessionLease(id);
        held[id] = !handle;
        handle?.release();
      }
      out(held);
      break;
    }
    case "relocate": {
      const [file, recordedCwd, newCwd] = args;
      const m = await SessionManager.openRelocated(file, recordedCwd, newCwd);
      const result = { file: m.getSessionFile(), cwd: m.getRecordedCwd() };
      await m.close();
      out(result);
      break;
    }
    case "bucket":
      // Session directory omp uses for a cwd. SessionManager.list returns [] outside omp's own runtime, so the caller lists files.
      out({ dir: SessionManager.getDefaultSessionDir(args[0]) });
      break;
    default:
      out({ error: "usage: omp-sdk lease <id> | leases <id…> | relocate <file> <recordedCwd> <newCwd> | bucket <cwd>" }, 1);
  }
} catch (e) {
  const err = e as Error;
  if (err.name === "SessionMoveRefusedError") out({ error: "refused" }, 3);
  out({ error: err.message }, 1);
}
