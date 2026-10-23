// omp extension loaded into every term-ui session: reports id/state/heartbeat/usage/REQs/MCP health to the term-ui server,
// gates tool calls the recipe lists in `approve` behind the user's decision (inbox), adds `orch_ask_user` to roots,
// and in root sessions delivers child notices (exit, hang) into the conversation.
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";

const BEAT_MS = 20_000;
const NOTICE_POLL_MS = 5_000;
const POLICY_POLL_MS = 30_000;
const DECISION_POLL_MS = 2_000;
const MCP_AUTH_ERROR = /401|403|unauthori[sz]ed|invalid_grant|expired|re-?auth/i;
const REQ_OPEN = /^(REQ-\d+)\s*·\s*(.+)$/;
const REQ_REPLY = /^(REQ-\d+)\s*·\s*[^·]+·\s*(DONE|PARTIAL|BLOCKED)\b/;
const REQ_BLOCKED = /^(REQ-\d+) BLOCKED · [^·]+ · (.+)$/;

type Item = { id: number; status: "open" | "answered" | "approved" | "rejected" | "dismissed"; answer: string | null };

const globRegex = (glob: string) => new RegExp(`^${glob.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*")}$`, "i");
const field = (text: string, name: string) => new RegExp(`^${name}:\\s*(.*)$`, "im").exec(text)?.[1]?.trim() ?? "";
const asRecord = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

export default function (pi: ExtensionAPI) {
  const url = process.env.ORCH_URL;
  const route = process.env.ORCH_ROUTE;
  const peer = process.env.ORCH_PEER;
  if (!url || !route || !peer) return;
  const kind = process.env.ORCH_KIND;
  const headers = { "content-type": "application/json", authorization: `Bearer ${process.env.ORCH_TOKEN ?? ""}` };
  const endpoint = (path: string) => `${url}/api/sessions/${encodeURIComponent(route)}/${path}`;
  const post = (path: string, body: unknown) =>
    fetch(endpoint(path), { method: "POST", headers, body: JSON.stringify(body) }).catch(() => undefined);
  const get = (path: string) => fetch(path.startsWith("/") ? `${url}${path}` : endpoint(path), { headers }).catch(() => undefined);
  const sleep = (ctx: ExtensionContext, ms: number) => {
    const { promise, resolve } = Promise.withResolvers<void>();
    ctx.setTimeout(() => resolve(), ms);
    return promise;
  };
  // Polls an inbox item until the user decides it. No timeout: an approval can wait for hours.
  async function awaitDecision(ctx: ExtensionContext, id: number): Promise<Item | undefined> {
    for (;;) {
      const r = await get(`/api/inbox/${id}`);
      if (r?.status === 404) return undefined;
      if (r?.ok) {
        const item = (await r.json().catch(() => undefined)) as Item | undefined;
        if (item && item.status !== "open") return item;
      }
      await sleep(ctx, DECISION_POLL_MS);
    }
  }

  // Posts a request that needs the user (approval, question) and returns the inbox id; retries while the server is unreachable.
  async function openItem(ctx: ExtensionContext, path: "approval" | "ask", body: unknown): Promise<number | undefined> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const r = await post(path, body);
      if (r?.ok) return ((await r.json().catch(() => ({}))) as { id?: number }).id;
      await sleep(ctx, DECISION_POLL_MS);
    }
    return undefined;
  }

  let lastPostedId: string | undefined;
  const hello = (sessionId: string, reason: "start" | "switch") => {
    lastPostedId = sessionId;
    void post("hello", { sessionId, pid: process.pid, reason });
  };

  // ---------- approval policy ----------
  // Fail closed: until the policy has been read once, no tool call may run (a matching call could otherwise
  // slip through while the first fetch is in flight). After the first read a failed refresh keeps the last policy.
  let approve: RegExp[] = [];
  let policyLoaded = false;
  const refreshPolicy = async () => {
    const r = await get("policy");
    if (!r?.ok) return;
    const policy = asRecord(await r.json().catch(() => ({})));
    approve = Array.isArray(policy.approve) ? policy.approve.filter((p): p is string => typeof p === "string" && p.length > 0).map(globRegex) : [];
    policyLoaded = true;
  };
  async function policyReady(ctx: ExtensionContext): Promise<boolean> {
    for (let attempt = 0; !policyLoaded && attempt < 10; attempt++) {
      await refreshPolicy();
      if (!policyLoaded) await sleep(ctx, 1_000);
    }
    return policyLoaded;
  }

  // ---------- REQ register ----------
  function reportReq(toolName: string, input: Record<string, unknown>) {
    if (toolName !== "peer_send" && toolName !== "peer_request") return;
    const message = typeof input.message === "string" ? input.message : "";
    const first = message.split("\n", 1)[0].trim();
    if (kind === "root") {
      const m = REQ_OPEN.exec(first);
      if (m) void post("report-req", { num: m[1], title: m[2].trim(), to: typeof input.to === "string" ? input.to : "", body: message });
    } else if (kind === "child") {
      const m = REQ_REPLY.exec(first);
      if (m) {
        void post("report-reply", { num: m[1], status: m[2], result: field(message, "Result"), verified: field(message, "Verified"), questions: field(message, "Questions") });
        return;
      }
      const b = REQ_BLOCKED.exec(first);
      if (b) void post("report-reply", { num: b[1], status: "BLOCKED", result: b[2].trim() });
    }
  }

  pi.on("session_start", (_e, ctx) => {
    if (!ctx.hasUI) return; // subagents share the orch environment; only the main session reports
    pi.setSessionName(peer);
    hello(ctx.sessionManager.getSessionId(), "start");
    // Tools allowlist: `ORCH_TOOLS_DENY` lists the built-in tools the recipe does not allow; MCP and extension tools are never listed.
    const deny = new Set((process.env.ORCH_TOOLS_DENY ?? "").split(",").filter(Boolean));
    if (deny.size) void pi.setActiveTools(pi.getActiveTools().filter(n => !deny.has(n)));
    void refreshPolicy();
    ctx.setInterval(() => void refreshPolicy(), POLICY_POLL_MS);
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

  // ---------- usage ----------
  pi.on("message_end", event => {
    const m = event.message;
    if (m.role !== "assistant" || !m.usage) return;
    void post("report-usage", { model: m.model, input: m.usage.input, output: m.usage.output, cacheRead: m.usage.cacheRead, cacheWrite: m.usage.cacheWrite, cost: m.usage.cost.total });
  });

  // ---------- tool gate: REQ reporting + approvals ----------
  pi.on("tool_call", async (event, ctx) => {
    const input = asRecord(event.input);
    reportReq(event.toolName, input);
    if (!(await policyReady(ctx))) return { block: true, reason: "The approval policy could not be loaded from term-ui. Do not retry this call; report it." };
    if (!approve.some(re => re.test(event.toolName))) return;
    const id = await openItem(ctx, "approval", { toolName: event.toolName, input });
    if (id === undefined) return { block: true, reason: "The approval service is unreachable. Do not retry this call; report it." };
    const item = await awaitDecision(ctx, id);
    if (item?.status === "approved") {
      if (!item.answer) return;
      try {
        return { input: asRecord(JSON.parse(item.answer)) }; // the user edited the draft
      } catch {
        return { block: true, reason: "The edited input was not valid JSON. Do not retry this call; report it." };
      }
    }
    const why = item?.status === "rejected" ? item.answer || "no reason" : "dismissed without a decision";
    return { block: true, reason: `Rejected by the user: ${why}. Do not retry this call; report it.` };
  });

  // ---------- MCP health ----------
  pi.events.on("mcp:connection-status", data => {
    const e = asRecord(data);
    if (typeof e.serverName !== "string") return;
    if (e.type === "failed") void post("report-mcp", { server: e.serverName, type: "failed", error: String(e.error ?? "").slice(0, 200) });
    else if (e.type === "connected") void post("report-mcp", { server: e.serverName, type: "connected" });
  });
  // Expired credentials surface only when a tool is called: an auth-looking error from an MCP tool marks its server failed.
  pi.on("tool_result", event => {
    if (!event.toolName.startsWith("mcp__") || !event.isError) return;
    const text = event.content.map(c => (c.type === "text" ? c.text : "")).join(" ");
    if (MCP_AUTH_ERROR.test(text)) void post("report-mcp", { server: event.toolName.slice("mcp__".length), type: "failed", error: text.slice(0, 200) });
  });

  // ---------- ask the user (roots only) ----------
  if (kind === "root") {
    const z = pi.zod;
    const Ask = z.object({
      question: z.string().describe("The question, in the user's language"),
      options: z.array(z.string()).optional().describe("Answer choices shown as buttons; omit for a free-text answer"),
    });
    pi.registerTool({
      name: "orch_ask_user",
      label: "Ask the user",
      description: "Ask the user a question and wait for the answer in the term-ui inbox. Use it for every question to the user; NEVER wait for an answer in prose.",
      parameters: Ask,
      approval: "read",
      async execute(_toolCallId, raw, _signal, _onUpdate, ctx) {
        const params = Ask.parse(raw);
        const id = await openItem(ctx, "ask", { question: params.question, options: params.options ?? [] });
        const item = id === undefined ? undefined : await awaitDecision(ctx, id);
        const text = item?.status === "answered" && item.answer ? item.answer : "The user gave no answer.";
        return { content: [{ type: "text", text }], details: {} };
      },
    });
  }
}
