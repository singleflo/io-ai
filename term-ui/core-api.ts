// HTTP handlers of the work layer: inbox, approvals, ask, REQ register, usage, activity, search, digest and the
// extension reporting endpoints (`/api/sessions/<route>/report-*`, `policy`, `approval`, `ask`).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ctx, findSessionFile, sendTask, setIssue, clearIssue, type Session } from "./core";
import {
  addUsage, digestData, eventsList, inboxAdd, inboxDecide, inboxGet, inboxList, inboxOpenFor, lastRun, localDay, logEvent, reqAddCost, reqGet, reqList, reqOpen, reqReply, search, setLastRun, usageByRoute,
  type DigestData, type InboxItem, type ReqStatus,
} from "./store";
import { peerOf } from "./workspace";

const json = (v: unknown, status = 200) => Response.json(v, { status });
const bad = (text: string, status = 400) => new Response(text, { status });

type Body = Record<string, unknown>;
const readBody = async (req: Request): Promise<Body> => {
  const v: unknown = await req.json().catch(() => ({}));
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Body) : {};
};
const str = (v: unknown) => (typeof v === "string" ? v : "");
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const limitOf = (url: URL, def: number, max: number) => Math.min(max, Math.max(1, Number(url.searchParams.get("limit")) || def));

// ---------- audit ----------
// Endpoints the extension and the page call all the time: not audited.
const QUIET_ACTIONS = new Set(["hello", "beat", "state", "notices", "policy", "approval", "ask", "report-usage", "report-req", "report-reply", "report-mcp"]);
const REDACTED = new Set(["text", "value", "answer"]); // free text and secrets: only the length is logged

// Logs every non-GET `/api/*` call. `req` must be a clone: the handler still reads the original body.
export async function auditRequest(req: Request, parts: string[]) {
  if (req.method === "GET" || parts[0] !== "api") return;
  const sessionScoped = parts[1] === "sessions" && parts.length >= 4;
  const action = sessionScoped ? parts[parts.length - 1] : parts.slice(1).join("/");
  if (sessionScoped && QUIET_ACTIONS.has(action)) return;
  const body = await readBody(req);
  const safe: Body = {};
  for (const [k, v] of Object.entries(body)) safe[k] = REDACTED.has(k) && typeof v === "string" ? `[${v.length} chars]` : v;
  const route = sessionScoped ? parts.slice(2, -1).join("/") : parts[1] === "sessions" ? [str(body.parent), str(body.name)].filter(Boolean).join("/") : "";
  logEvent(route, "api", { action, body: safe });
}

// ---------- inbox ----------
function decide(item: InboxItem | undefined, status: "answered" | "approved" | "rejected" | "dismissed", answer: string | null): Response {
  if (!item) return bad("unknown or already decided", 409);
  logEvent(item.route, "inbox", { id: item.id, kind: item.kind, status, answer: answer === null ? null : `[${answer.length} chars]` });
  return json(item);
}

async function inboxAction(req: Request, id: number, action: string): Promise<Response> {
  const item = inboxGet(id);
  if (!item) return bad("unknown inbox item", 404);
  if (item.status !== "open") return bad("already decided", 409);
  const body = await readBody(req);
  const answer = str(body.answer).trim();
  switch (action) {
    case "answer": {
      if (item.kind !== "question") return bad("not a question");
      if (!answer) return bad("answer required");
      const child = str(item.data.child);
      if (child) {
        // A REQ question: the answer goes to the root that sent the REQ.
        const root = ctx.sessions.get(str(item.data.root));
        if (!root?.proc) return bad("root not running", 409);
        try {
          sendTask(root, `[orch] user answer for ${child} ${str(item.data.num)}: ${answer}`);
        } catch (e) {
          return bad((e as Error).message, 409);
        }
      }
      return decide(inboxDecide(id, "answered", answer), "answered", answer);
    }
    case "approve": {
      if (item.kind !== "approval") return bad("not an approval");
      if (answer) {
        // An edited tool input (JSON text).
        try {
          const v: unknown = JSON.parse(answer);
          if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("not an object");
        } catch {
          return bad("edited input must be a JSON object");
        }
      }
      return decide(inboxDecide(id, "approved", answer || null), "approved", answer || null);
    }
    case "reject":
      if (item.kind !== "approval") return bad("not an approval");
      return decide(inboxDecide(id, "rejected", answer || null), "rejected", answer || null);
    case "dismiss":
      return decide(inboxDecide(id, "dismissed", null), "dismissed", null);
  }
  return bad("unknown action", 404);
}

// ---------- digest ----------
export type Digest = { date: string; text: string; reqs: DigestData["reqs"]; byRoot: DigestData["reqsByRoot"]; cost: DigestData["cost"]; approvals: DigestData["approvals"]; issues: number; fires: number };

export function buildDigest(date: string): Digest {
  const d = digestData(date);
  const lines = [`Digest for ${date}`, `REQs: ${d.reqs.opened} opened, ${d.reqs.done} done, ${d.reqs.partial} partial, ${d.reqs.blocked} blocked`];
  for (const [root, c] of Object.entries(d.reqsByRoot)) lines.push(`  ${root}: ${c.opened} opened, ${c.done} done, ${c.partial} partial, ${c.blocked} blocked`);
  const total = d.cost.reduce((a, c) => a + c.cost, 0);
  lines.push(`Cost: $${total.toFixed(2)}`);
  for (const c of d.cost) lines.push(`  ${c.route}: $${c.cost.toFixed(2)}`);
  lines.push(`Approvals: ${d.approvals.approved} approved, ${d.approvals.rejected} rejected`, `Issues raised: ${d.issues}`, `Schedule and trigger fires: ${d.fires}`);
  return { date, text: lines.join("\n"), reqs: d.reqs, byRoot: d.reqsByRoot, cost: d.cost, approvals: d.approvals, issues: d.issues, fires: d.fires };
}

// First tick after 08:00 local time with no digest yet today: yesterday's digest goes to the inbox.
export function digestTick(now: Date = new Date()) {
  const today = localDay(now);
  if (now.getHours() < 8 || (lastRun("digest") ?? "") >= today) return;
  setLastRun("digest", today);
  const yesterday = localDay(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1));
  const digest = buildDigest(yesterday);
  const r = digest.reqs;
  const quiet = r.opened + r.done + r.partial + r.blocked + digest.cost.length + digest.approvals.approved + digest.approvals.rejected + digest.issues + digest.fires === 0;
  if (!quiet) inboxAdd("", "digest", `Daily digest · ${yesterday}`, digest.text, {});
}

// ---------- conversation search ----------
type Hit = { route: string; ts: string; snippet: string };
const SEARCH_MAX_HITS = 50;
const SEARCH_MAX_MS = 3000;

function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const out: string[] = [];
  for (const part of content) if (part && typeof part === "object" && "text" in part && typeof part.text === "string") out.push(part.text);
  return out.join("\n");
}

async function searchConversations(q: string): Promise<Hit[]> {
  const needle = q.toLowerCase();
  const plain = !/["\\\n\r\t]/.test(needle); // JSON escaping cannot hide the needle from the raw-line prefilter
  const deadline = Date.now() + SEARCH_MAX_MS;
  const hits: Hit[] = [];
  for (const s of ctx.sessions.values()) {
    const id = s.recipe?.sessionId;
    const file = id ? findSessionFile(id) : undefined;
    if (!file) continue;
    const decoder = new TextDecoder();
    let rest = "";
    const handle = (line: string) => {
      if (plain && !line.toLowerCase().includes(needle)) return;
      let entry: unknown;
      try {
        entry = JSON.parse(line);
      } catch {
        return;
      }
      if (!entry || typeof entry !== "object" || !("message" in entry)) return;
      const m = entry.message;
      if (!m || typeof m !== "object" || !("role" in m) || (m.role !== "user" && m.role !== "assistant") || !("content" in m)) return;
      const text = messageText(m.content);
      const at = text.toLowerCase().indexOf(needle);
      if (at < 0) return;
      const ts = "timestamp" in entry && typeof entry.timestamp === "string" ? entry.timestamp : "";
      const from = Math.max(0, at - 60);
      hits.push({ route: s.route, ts, snippet: text.slice(from, from + 120).replace(/\s+/g, " ") });
    };
    for await (const chunk of Bun.file(file).stream()) {
      rest += decoder.decode(chunk, { stream: true });
      let nl = rest.indexOf("\n");
      while (nl >= 0) {
        handle(rest.slice(0, nl));
        rest = rest.slice(nl + 1);
        nl = rest.indexOf("\n");
        if (hits.length >= SEARCH_MAX_HITS) return hits;
      }
      if (Date.now() > deadline) return hits;
    }
    if (rest) handle(rest);
    if (hits.length >= SEARCH_MAX_HITS) return hits;
  }
  return hits;
}

// ---------- extension reporting ----------
const NONE = /^(none|n\/a|-|—|)$/i;
const sanitizeServer = (name: string) => name.toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/_+/g, "_").replace(/^_+|_+$/g, "");

function projectMcpNames(s: Session): string[] {
  try {
    const v: unknown = JSON.parse(readFileSync(join(s.folder, ".omp", "mcp.json"), "utf8"));
    const servers = v && typeof v === "object" && "mcpServers" in v ? v.mcpServers : undefined;
    return servers && typeof servers === "object" ? Object.keys(servers) : [];
  } catch {
    return [];
  }
}

// The extension reports either a real server name (connection events) or the tool name after `mcp__` (tool errors):
// resolve it against the known server names, longest sanitized prefix first.
export function resolveMcpServer(s: Session, raw: string): string {
  const names = [...new Set([...Object.keys(ctx.catalog?.mcpServers ?? {}), ...projectMcpNames(s), ...(s.mcpFailed?.keys() ?? [])])];
  const exact = names.find(n => n === raw);
  if (exact) return exact;
  const best = names.filter(n => raw === sanitizeServer(n) || raw.startsWith(`${sanitizeServer(n)}_`)).sort((a, b) => sanitizeServer(b).length - sanitizeServer(a).length)[0];
  return best ?? raw.split("_")[0];
}

function reportMcp(s: Session, body: Body): Response {
  const raw = str(body.server);
  if (!raw) return bad("server required");
  const server = resolveMcpServer(s, raw);
  if (body.type === "failed") {
    const error = str(body.error).slice(0, 200) || "connection failed";
    (s.mcpFailed ??= new Map()).set(server, error);
    setIssue(s, "mcp-failed", "flag", [...s.mcpFailed].map(([k, v]) => `${k}: ${v}`).join("; "), ["restart", "dismiss"]);
    const open = inboxOpenFor(s.route, "mcp").find(i => i.title === server);
    if (!open) inboxAdd(s.route, "mcp", server, `${server}: ${error}`, {});
    logEvent(s.route, "mcp-failed", { server, error });
  } else if (body.type === "connected") {
    if (s.mcpFailed?.delete(server)) {
      if (!s.mcpFailed.size) clearIssue(s, "mcp-failed");
      else {
        setIssue(s, "mcp-failed", "flag", [...s.mcpFailed].map(([k, v]) => `${k}: ${v}`).join("; "), ["restart", "dismiss"]);
        for (const item of inboxOpenFor(s.route, "mcp")) if (item.title === server) inboxDecide(item.id, "dismissed");
      }
    }
  } else return bad("type must be failed or connected");
  return json({ ok: true });
}

function reportReq(s: Session, body: Body): Response {
  const num = str(body.num);
  if (!/^REQ-\d+$/.test(num)) return bad("invalid REQ number");
  const to = str(body.to);
  const child = [...ctx.sessions.values()].find(x => peerOf(x.route) === to)?.route ?? to;
  const req = reqOpen({ root: s.route, num, child, title: str(body.title), body: str(body.body) });
  return json({ key: req.key });
}

function reportReply(s: Session, body: Body): Response {
  if (!s.parent) return bad("not a child session");
  const num = str(body.num);
  const status = str(body.status).toLowerCase() as ReqStatus;
  if (!/^REQ-\d+$/.test(num) || !["done", "partial", "blocked"].includes(status)) return bad("invalid REQ reply");
  const key = `${s.parent}#${num}`;
  const result = str(body.result) || null;
  const verified = str(body.verified) || null;
  const questions = str(body.questions) || null;
  if (!reqGet(key)) reqOpen({ root: s.parent, num, child: s.route, title: num, body: "" }); // a REQ the root did not send through peer_send
  reqReply(key, status, result, verified, questions);
  const title = `${num} · ${s.route} · ${status.toUpperCase()}`;
  const text = [result ? `Result: ${result}` : "", verified ? `Verified: ${verified}` : "", questions ? `Questions: ${questions}` : ""].filter(Boolean).join("\n");
  if (status === "blocked") inboxAdd(s.route, "blocked", title, text, {});
  else if (questions && !NONE.test(questions.trim())) inboxAdd(s.route, "question", title, text, { child: s.route, num, root: s.parent });
  else inboxAdd(s.route, "done", title, text, {});
  return json({ key });
}

async function sessionAction(req: Request, s: Session, action: string): Promise<Response | undefined> {
  switch (action) {
    case "policy":
      return json({ approve: (s.recipe?.approve ?? []).filter(p => typeof p === "string") });
    case "approval": {
      const body = await readBody(req);
      const toolName = str(body.toolName);
      if (!toolName) return bad("toolName required");
      const input = body.input && typeof body.input === "object" && !Array.isArray(body.input) ? body.input : {};
      const item = inboxAdd(s.route, "approval", toolName, JSON.stringify(input).slice(0, 400), { toolName, input });
      return json({ id: item.id });
    }
    case "ask": {
      const body = await readBody(req);
      const question = str(body.question).trim();
      if (!question) return bad("question required");
      const options = Array.isArray(body.options) ? body.options.filter(o => typeof o === "string") : [];
      const item = inboxAdd(s.route, "question", question.slice(0, 120), question, options.length ? { options } : {});
      return json({ id: item.id });
    }
    case "report-usage": {
      if (req.method !== "POST") return undefined;
      const body = await readBody(req);
      const usage = { input: num(body.input), output: num(body.output), cacheRead: num(body.cacheRead), cacheWrite: num(body.cacheWrite), cost: num(body.cost) };
      addUsage(s.route, str(body.model) || "unknown", usage);
      if (s.kind === "child") reqAddCost(s.route, usage.cost, usage.input + usage.output);
      return json({ ok: true });
    }
    case "report-req":
      return reportReq(s, await readBody(req));
    case "report-reply":
      return reportReply(s, await readBody(req));
    case "report-mcp":
      return reportMcp(s, await readBody(req));
  }
  return undefined;
}

// ---------- router ----------
// Returns undefined for requests this module does not own.
export async function coreRoute(req: Request, url: URL, parts: string[]): Promise<Response | undefined> {
  if (parts[0] !== "api") return undefined;
  switch (parts[1]) {
    case "inbox": {
      if (!parts[2]) return req.method === "GET" ? json(inboxList(url.searchParams.get("status") === "all" ? "all" : "open", limitOf(url, 100, 1000))) : bad("method not allowed", 405);
      const id = Number(parts[2]);
      if (!Number.isInteger(id)) return bad("invalid id");
      if (!parts[3]) {
        const item = inboxGet(id);
        return item ? json(item) : bad("unknown inbox item", 404);
      }
      return req.method === "POST" ? inboxAction(req, id, parts[3]) : bad("method not allowed", 405);
    }
    case "reqs":
      return json(reqList({ root: url.searchParams.get("root") || undefined, status: url.searchParams.get("status") || undefined, limit: limitOf(url, 200, 1000) }));
    case "usage":
      if (parts[2] !== "sessions") return undefined;
      return json(usageByRoute([1, 7, 30].includes(Number(url.searchParams.get("days"))) ? Number(url.searchParams.get("days")) : 1));
    case "activity":
      return json(eventsList(url.searchParams.get("route") || null, limitOf(url, 200, 1000)));
    case "search": {
      const q = (url.searchParams.get("q") ?? "").trim();
      if (!q) return json({ reqs: [], inbox: [], conversations: [] });
      return json({ ...search(q), conversations: await searchConversations(q) });
    }
    case "digest": {
      const date = url.searchParams.get("date") ?? localDay();
      return /^\d{4}-\d{2}-\d{2}$/.test(date) ? json(buildDigest(date)) : bad("date must be YYYY-MM-DD");
    }
    case "sessions": {
      if (parts.length < 4) return undefined;
      const action = parts[parts.length - 1];
      if (!QUIET_ACTIONS.has(action) || action === "hello" || action === "beat" || action === "state" || action === "notices") return undefined;
      const s = ctx.sessions.get(parts.slice(2, -1).join("/"));
      if (!s) return bad("unknown session", 404);
      return sessionAction(req, s, action);
    }
  }
  return undefined;
}
