// omp extension loaded into every term-ui session: reports id/state/heartbeat to the term-ui server,
// and in root sessions delivers child notices (exit, hang) into the conversation.
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

const BEAT_MS = 20_000;
const NOTICE_POLL_MS = 5_000;

export default function (pi: ExtensionAPI) {
  const url = process.env.ORCH_URL;
  const route = process.env.ORCH_ROUTE;
  const peer = process.env.ORCH_PEER;
  if (!url || !route || !peer) return;
  const endpoint = (path: string) => `${url}/api/sessions/${encodeURIComponent(route)}/${path}`;
  const post = (path: string, body: unknown) =>
    fetch(endpoint(path), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }).catch(() => undefined);

  let lastPostedId: string | undefined;
  const hello = (sessionId: string, reason: "start" | "switch") => {
    lastPostedId = sessionId;
    void post("hello", { sessionId, pid: process.pid, reason });
  };

  pi.on("session_start", (_e, ctx) => {
    if (!ctx.hasUI) return; // subagents share the orch environment; only the main session reports
    pi.setSessionName(peer);
    hello(ctx.sessionManager.getSessionId(), "start");
    ctx.setInterval(() => void post("beat", {}), BEAT_MS);
    // Notices are queued only for roots; for children the endpoint always returns [].
    ctx.setInterval(async () => {
      const r = await post("notices", {});
      if (!r?.ok) return;
      const notices = (await r.json()) as string[];
      if (!notices.length) return;
      pi.sendUserMessage(`${notices.join("\n")}\n(automatic term-ui notice: apply the "Child health" rule of the ROOT PROTOCOL)`, {
        deliverAs: "aside",
        attribution: "agent",
      });
    }, NOTICE_POLL_MS);
  });
  pi.on("session_switch", (_e, ctx) => {
    if (!ctx.hasUI) return;
    hello(ctx.sessionManager.getSessionId(), "switch");
  });
  pi.on("agent_start", (_e, ctx) => {
    if (ctx.hasUI) {
      const sessionId = ctx.sessionManager.getSessionId();
      if (sessionId !== lastPostedId) hello(sessionId, "switch");
    }
    void post("state", { state: "working" });
  });
  pi.on("agent_end", () => void post("state", { state: "idle" }));
  pi.on("session_shutdown", () => void post("state", { state: "stopped" }));
}
