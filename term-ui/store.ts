// Persistent store (bun:sqlite, WAL) at `<ws>/.orch/orch.db`: audit/activity events, REQ register, inbox, usage, schedule runs, search index.
// Only typed helpers are exported; SQL never leaves this file.
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { orchDir, workspaceRoot } from "./workspace";

export type InboxKind = "question" | "approval" | "blocked" | "done" | "issue" | "digest" | "mcp";
export type InboxStatus = "open" | "answered" | "approved" | "rejected" | "dismissed";
export type InboxItem = {
  id: number;
  ts: string;
  route: string;
  kind: InboxKind;
  title: string;
  body: string;
  data: Record<string, unknown>;
  status: InboxStatus;
  answer: string | null;
  decided: string | null;
};
export type ReqStatus = "open" | "done" | "partial" | "blocked";
export type Req = {
  key: string;
  root: string;
  num: string;
  child: string;
  title: string;
  body: string;
  status: ReqStatus;
  opened: string | null;
  closed: string | null;
  result: string | null;
  verified: string | null;
  questions: string | null;
  cost: number;
  tokens: number;
};
export type EventRow = { id: number; ts: string; route: string; kind: string; data: Record<string, unknown> };
export type Usage = { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number };
export type RouteUsage = { route: string; cost: number; tokens: number };
export type SearchHits = {
  reqs: { key: string; root: string; num: string; child: string; title: string; status: ReqStatus }[];
  inbox: { id: number; route: string; kind: InboxKind; title: string }[];
};
export type ReqCounts = { opened: number; done: number; partial: number; blocked: number };
export type DigestData = {
  reqs: ReqCounts;
  reqsByRoot: Record<string, ReqCounts>;
  cost: { route: string; cost: number }[];
  approvals: { approved: number; rejected: number };
  issues: number;
  fires: number;
};

type InboxRow = Omit<InboxItem, "data"> & { data: string };
type EventDbRow = Omit<EventRow, "data"> & { data: string };

let handle: Database | undefined;

function db(): Database {
  if (handle) return handle;
  const dir = orchDir(workspaceRoot());
  mkdirSync(dir, { recursive: true });
  const d = new Database(join(dir, "orch.db"), { create: true });
  d.run("PRAGMA journal_mode = WAL");
  d.run("PRAGMA busy_timeout = 3000");
  d.run("CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY, ts TEXT, route TEXT, kind TEXT, data TEXT)");
  d.run("CREATE INDEX IF NOT EXISTS events_route ON events(route, id)");
  d.run(`CREATE TABLE IF NOT EXISTS reqs(key TEXT PRIMARY KEY, root TEXT, num TEXT, child TEXT, title TEXT, body TEXT, status TEXT, opened TEXT, closed TEXT,
    result TEXT, verified TEXT, questions TEXT, cost REAL NOT NULL DEFAULT 0, tokens INTEGER NOT NULL DEFAULT 0)`);
  d.run("CREATE TABLE IF NOT EXISTS inbox(id INTEGER PRIMARY KEY, ts TEXT, route TEXT, kind TEXT, title TEXT, body TEXT, data TEXT, status TEXT, answer TEXT, decided TEXT)");
  d.run("CREATE INDEX IF NOT EXISTS inbox_status ON inbox(status, id)");
  d.run(`CREATE TABLE IF NOT EXISTS usage(day TEXT, route TEXT, model TEXT, input INTEGER, output INTEGER, cache_read INTEGER, cache_write INTEGER, cost REAL,
    PRIMARY KEY(day, route, model))`);
  d.run("CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY, last TEXT)");
  d.run("CREATE VIRTUAL TABLE IF NOT EXISTS fts USING fts5(kind, ref, route, text)");
  handle = d;
  return d;
}

export const openStore = () => void db();

// ---------- time ----------
const pad = (n: number) => String(n).padStart(2, "0");
export const localDay = (d: Date = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
// ISO bounds [start, end) of a local calendar day (YYYY-MM-DD).
function dayRange(day: string): [string, string] {
  const [y, m, d] = day.split("-").map(Number);
  return [new Date(y, m - 1, d).toISOString(), new Date(y, m - 1, d + 1).toISOString()];
}
const parseObject = (text: string | null): Record<string, unknown> => {
  try {
    const v: unknown = JSON.parse(text ?? "{}");
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
};

// ---------- events (audit log + activity) ----------
export function logEvent(route: string, kind: string, data: Record<string, unknown> = {}) {
  db().query("INSERT INTO events(ts, route, kind, data) VALUES(?, ?, ?, ?)").run(new Date().toISOString(), route, kind, JSON.stringify(data));
}

export function eventsList(route: string | null, limit: number): EventRow[] {
  const rows = (route
    ? db().query("SELECT * FROM events WHERE route = ? ORDER BY id DESC LIMIT ?").all(route, limit)
    : db().query("SELECT * FROM events ORDER BY id DESC LIMIT ?").all(limit)) as EventDbRow[];
  return rows.map(r => ({ ...r, data: parseObject(r.data) }));
}

// ---------- inbox ----------
type InboxListener = (item: InboxItem, change: "add" | "update") => void;
const inboxListeners: InboxListener[] = [];
export const onInboxChange = (fn: InboxListener) => void inboxListeners.push(fn);
const emitInbox = (item: InboxItem, change: "add" | "update") => {
  for (const fn of inboxListeners) {
    try {
      fn(item, change);
    } catch {}
  }
};
const toItem = (r: InboxRow): InboxItem => ({ ...r, data: parseObject(r.data) });

function indexText(kind: "req" | "inbox", ref: string, route: string, text: string) {
  db().query("DELETE FROM fts WHERE kind = ? AND ref = ?").run(kind, ref);
  db().query("INSERT INTO fts(kind, ref, route, text) VALUES(?, ?, ?, ?)").run(kind, ref, route, text);
}

export function inboxAdd(route: string, kind: InboxKind, title: string, body: string, data: Record<string, unknown> = {}): InboxItem {
  const ts = new Date().toISOString();
  const res = db().query("INSERT INTO inbox(ts, route, kind, title, body, data, status) VALUES(?, ?, ?, ?, ?, ?, 'open')").run(ts, route, kind, title, body, JSON.stringify(data));
  const item = inboxGet(Number(res.lastInsertRowid))!;
  indexText("inbox", String(item.id), route, `${title}\n${body}`);
  emitInbox(item, "add");
  return item;
}

export function inboxGet(id: number): InboxItem | undefined {
  const r = db().query("SELECT * FROM inbox WHERE id = ?").get(id) as InboxRow | null;
  return r ? toItem(r) : undefined;
}

export function inboxList(status: "open" | "all", limit: number): InboxItem[] {
  const rows = (status === "open"
    ? db().query("SELECT * FROM inbox WHERE status = 'open' ORDER BY id DESC LIMIT ?").all(limit)
    : db().query("SELECT * FROM inbox ORDER BY id DESC LIMIT ?").all(limit)) as InboxRow[];
  return rows.map(toItem);
}

export function inboxOpenFor(route: string, kind: InboxKind): InboxItem[] {
  return (db().query("SELECT * FROM inbox WHERE status = 'open' AND route = ? AND kind = ? ORDER BY id").all(route, kind) as InboxRow[]).map(toItem);
}

export function inboxCounts(): { open: number; approvals: number } {
  const r = db().query("SELECT COUNT(*) AS open, COALESCE(SUM(kind = 'approval'), 0) AS approvals FROM inbox WHERE status = 'open'").get() as { open: number; approvals: number };
  return { open: r.open, approvals: r.approvals };
}

// Routes with an open approval or an open `orch_ask_user` question (REQ questions carry `data.child` and do not block the asking agent).
export function awaitingRoutes(): Set<string> {
  const rows = db().query("SELECT DISTINCT route FROM inbox WHERE status = 'open' AND (kind = 'approval' OR (kind = 'question' AND json_extract(data, '$.child') IS NULL))").all() as { route: string }[];
  return new Set(rows.map(r => r.route));
}

// Open item -> decided. Returns undefined when the item does not exist or was already decided.
export function inboxDecide(id: number, status: Exclude<InboxStatus, "open">, answer: string | null = null): InboxItem | undefined {
  const res = db().query("UPDATE inbox SET status = ?, answer = ?, decided = ? WHERE id = ? AND status = 'open'").run(status, answer, new Date().toISOString(), id);
  if (!res.changes) return undefined;
  const item = inboxGet(id)!;
  emitInbox(item, "update");
  return item;
}

// Open items of routes that no longer exist are dismissed (route "" = workspace-wide, e.g. the digest, is kept).
export function inboxDismissMissing(routes: Set<string>): number {
  const rows = db().query("SELECT id, route FROM inbox WHERE status = 'open' AND route <> ''").all() as { id: number; route: string }[];
  let n = 0;
  for (const r of rows) if (!routes.has(r.route) && inboxDecide(r.id, "dismissed")) n++;
  return n;
}

// Moves open and closed items, and the route references in their data, from `from` (and its subtree) to `to`.
export function inboxRenameRoutes(from: string, to: string): void {
  const like = `${from.replace(/[\\%_]/g, "\\$&")}/%`;
  const affected = db().query("SELECT id FROM inbox WHERE route = ? OR route LIKE ? ESCAPE '\\' ORDER BY id DESC").all(from, like) as { id: number }[];
  db().query("UPDATE inbox SET route = ? || substr(route, length(?) + 1) WHERE route = ? OR route LIKE ? ESCAPE '\\'").run(to, from, from, like);
  // route references inside `data`: same prefix rewrite where they match
  for (const key of ["route", "child", "root"]) {
    db().query(`UPDATE inbox SET data = json_set(data, '$.${key}', ? || substr(json_extract(data, '$.${key}'), length(?) + 1))
      WHERE json_valid(data) AND json_type(data, '$.${key}') = 'text' AND (json_extract(data, '$.${key}') = ? OR json_extract(data, '$.${key}') LIKE ? ESCAPE '\\')`).run(to, from, from, like);
  }
  const open = affected.map(a => inboxGet(a.id)).find(i => i?.status === "open");
  if (open) emitInbox(open, "update");
}

// ---------- REQ register ----------
export function reqOpen(a: { root: string; num: string; child: string; title: string; body: string }): Req {
  const key = `${a.root}#${a.num}`;
  const now = new Date().toISOString();
  db().query(`INSERT INTO reqs(key, root, num, child, title, body, status, opened) VALUES(?, ?, ?, ?, ?, ?, 'open', ?)
    ON CONFLICT(key) DO UPDATE SET child = excluded.child, title = excluded.title, body = excluded.body, status = 'open', closed = NULL`).run(key, a.root, a.num, a.child, a.title, a.body, now);
  const req = reqGet(key)!;
  indexText("req", key, a.root, `${a.num} ${a.title}\n${a.body}`);
  return req;
}

export function reqGet(key: string): Req | undefined {
  const r = db().query("SELECT * FROM reqs WHERE key = ?").get(key) as Req | null;
  return r ?? undefined;
}

export function reqReply(key: string, status: ReqStatus, result: string | null, verified: string | null, questions: string | null): Req | undefined {
  const res = db().query("UPDATE reqs SET status = ?, closed = ?, result = ?, verified = ?, questions = ? WHERE key = ?").run(status, new Date().toISOString(), result, verified, questions, key);
  if (!res.changes) return undefined;
  const req = reqGet(key)!;
  indexText("req", key, req.root, `${req.num} ${req.title}\n${req.body}\n${result ?? ""}\n${questions ?? ""}`);
  return req;
}

// Adds cost/tokens to the newest REQ of a child that is open or was closed in the last 2 minutes: the usage of the
// turn that sends the reply is reported after the reply itself. No-op when the child has no such REQ.
export function reqAddCost(child: string, cost: number, tokens: number) {
  const since = new Date(Date.now() - 120_000).toISOString();
  db().query(`UPDATE reqs SET cost = cost + ?, tokens = tokens + ? WHERE key = (SELECT key FROM reqs WHERE child = ? AND (status = 'open' OR closed >= ?) ORDER BY opened DESC LIMIT 1)`).run(cost, tokens, child, since);
}

export function reqList(f: { root?: string; status?: string; limit: number }): Req[] {
  const where: string[] = [];
  const args: (string | number)[] = [];
  if (f.root) {
    where.push("root = ?");
    args.push(f.root);
  }
  if (f.status) {
    where.push("status = ?");
    args.push(f.status);
  }
  const sql = `SELECT * FROM reqs${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY opened DESC LIMIT ?`;
  return db().query(sql).all(...args, f.limit) as Req[];
}

// ---------- usage ----------
export function addUsage(route: string, model: string, u: Usage, day: string = localDay()) {
  db().query(`INSERT INTO usage(day, route, model, input, output, cache_read, cache_write, cost) VALUES(?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(day, route, model) DO UPDATE SET input = input + excluded.input, output = output + excluded.output,
    cache_read = cache_read + excluded.cache_read, cache_write = cache_write + excluded.cache_write, cost = cost + excluded.cost`).run(day, route, model, u.input, u.output, u.cacheRead, u.cacheWrite, u.cost);
}

// Cost and tokens (input + output) per route over the last `days` local days, today included.
export function usageByRoute(days: number): RouteUsage[] {
  const from = new Date();
  from.setDate(from.getDate() - (days - 1));
  return db().query("SELECT route, SUM(cost) AS cost, SUM(input + output) AS tokens FROM usage WHERE day >= ? GROUP BY route ORDER BY cost DESC").all(localDay(from)) as RouteUsage[];
}

// ---------- runs ----------
export function lastRun(id: string): string | undefined {
  return (db().query("SELECT last FROM runs WHERE id = ?").get(id) as { last: string } | null)?.last;
}
export function setLastRun(id: string, last: string) {
  db().query("INSERT INTO runs(id, last) VALUES(?, ?) ON CONFLICT(id) DO UPDATE SET last = excluded.last").run(id, last);
}

// ---------- search ----------
export function search(q: string, limit = 25): SearchHits {
  const tokens = q.match(/[\p{L}\p{N}_-]+/gu) ?? [];
  if (!tokens.length) return { reqs: [], inbox: [] };
  const match = tokens.map(t => `"${t.replaceAll('"', '""')}"*`).join(" ");
  const hits = db().query("SELECT kind, ref FROM fts WHERE fts MATCH ? ORDER BY rank LIMIT ?").all(match, limit * 2) as { kind: string; ref: string }[];
  const out: SearchHits = { reqs: [], inbox: [] };
  for (const h of hits) {
    if (h.kind === "req" && out.reqs.length < limit) {
      const r = reqGet(h.ref);
      if (r) out.reqs.push({ key: r.key, root: r.root, num: r.num, child: r.child, title: r.title, status: r.status });
    } else if (h.kind === "inbox" && out.inbox.length < limit) {
      const i = inboxGet(Number(h.ref));
      if (i) out.inbox.push({ id: i.id, route: i.route, kind: i.kind, title: i.title });
    }
  }
  return out;
}

// ---------- digest ----------
const emptyCounts = (): ReqCounts => ({ opened: 0, done: 0, partial: 0, blocked: 0 });

export function digestData(day: string): DigestData {
  const [from, to] = dayRange(day);
  const d = db();
  const reqsByRoot: DigestData["reqsByRoot"] = {};
  const total = emptyCounts();
  const bump = (root: string, field: keyof ReqCounts) => {
    (reqsByRoot[root] ??= emptyCounts())[field]++;
    total[field]++;
  };
  for (const r of d.query("SELECT root FROM reqs WHERE opened >= ? AND opened < ?").all(from, to) as { root: string }[]) bump(r.root, "opened");
  for (const r of d.query("SELECT root, status FROM reqs WHERE closed >= ? AND closed < ? AND status != 'open'").all(from, to) as { root: string; status: "done" | "partial" | "blocked" }[]) bump(r.root, r.status);
  const cost = d.query("SELECT route, SUM(cost) AS cost FROM usage WHERE day = ? GROUP BY route ORDER BY cost DESC").all(day) as { route: string; cost: number }[];
  const decided = (status: string) => (d.query("SELECT COUNT(*) AS n FROM inbox WHERE kind = 'approval' AND status = ? AND decided >= ? AND decided < ?").get(status, from, to) as { n: number }).n;
  const issues = (d.query("SELECT COUNT(*) AS n FROM inbox WHERE kind = 'issue' AND ts >= ? AND ts < ?").get(from, to) as { n: number }).n;
  const fires = (d.query("SELECT COUNT(*) AS n FROM events WHERE kind IN ('schedule-fire', 'trigger-fire') AND ts >= ? AND ts < ?").get(from, to) as { n: number }).n;
  return { reqs: total, reqsByRoot, cost, approvals: { approved: decided("approved"), rejected: decided("rejected") }, issues, fires };
}
