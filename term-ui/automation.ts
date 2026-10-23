// Automations: cron schedules and webhook triggers that wake an agent. Both live in the recipe (they travel with the folder).
// Delivery waits for an idle moment; fires are audited as `schedule-fire` / `trigger-fire` events.
import { randomBytes } from "node:crypto";
import { ctx, sendTask, type Session } from "./core";
import { nextFire } from "./cron";
import { checkEnv, normalizeEnv } from "./secrets";
import { awaitingRoutes, inboxAdd, inboxOpenFor, lastRun, logEvent, setLastRun } from "./store";
import type { Recipe, Schedule, Trigger } from "./workspace";

const TICK_MS = 30_000;
const FLUSH_MS = 2_000;
const PENDING_TTL_MS = 30 * 60_000;
const HOOK_BODY_MAX = 20_000;

type Pending = { text: string; at: number };
const pending = new Map<string, Pending[]>(); // by route: texts waiting for the session to become idle

const newId = () => randomBytes(8).toString("hex");

// ---------- recipe fields ----------
/** Validates the automation/env/tools fields of an API body (create, edit). Returns an error text or undefined. */
export function checkRecipeExtras(body: Record<string, unknown>): string | undefined {
  const { schedules, triggers, tools } = body;
  if (schedules !== undefined && schedules !== null) {
    if (!Array.isArray(schedules)) return "schedules must be a list";
    for (const x of schedules as Partial<Schedule>[]) {
      if (typeof x?.cron !== "string" || typeof x.text !== "string" || !x.text.trim()) return "schedule needs cron and text";
      try {
        nextFire(x.cron, new Date());
      } catch (e) {
        return (e as Error).message; // `invalid cron: <expr>`
      }
    }
  }
  if (triggers !== undefined && triggers !== null) {
    if (!Array.isArray(triggers)) return "triggers must be a list";
    for (const x of triggers as Partial<Trigger>[]) if (typeof x?.name !== "string" || !x.name.trim() || typeof x.template !== "string") return "trigger needs name and template";
  }
  if (tools !== undefined && tools !== null && (!Array.isArray(tools) || tools.some(t => typeof t !== "string"))) return "tools must be a list of tool names or null";
  return checkEnv(body.env);
}

/** Fills what the UI/CLI leave out: a 16-hex id for empty or missing ids, `enabled` defaulting to true; the default `env` becomes unset. */
export function normalizeRecipeExtras(r: Recipe) {
  const seen = new Set<string>();
  const fresh = (id: unknown): string => {
    let v = typeof id === "string" && /^[0-9a-f]{16}$/.test(id) && !seen.has(id) ? id : newId();
    while (seen.has(v)) v = newId();
    seen.add(v);
    return v;
  };
  if (Array.isArray(r.schedules)) r.schedules = r.schedules.map((x): Schedule => ({ id: fresh(x.id), cron: x.cron.trim(), text: x.text, enabled: x.enabled !== false }));
  if (Array.isArray(r.triggers)) r.triggers = r.triggers.map((x): Trigger => ({ id: fresh(x.id), name: x.name.trim(), template: x.template, enabled: x.enabled !== false }));
  const env = normalizeEnv(r.env);
  if (env) r.env = env;
  else delete r.env;
}

// ---------- delivery ----------
function skipped(s: Session, reason: string) {
  const title = `Automation · ${s.route}`;
  const body = `delivery skipped: ${reason}`;
  if (inboxOpenFor(s.route, "issue").some(i => i.title === title && i.body === body)) return; // one open item per cause
  inboxAdd(s.route, "issue", title, body, { route: s.route, code: "delivery-skipped" });
}

const idle = (s: Session) => !!s.proc && (s.state === "idle" || s.state === "ready") && !awaitingRoutes().has(s.route);

/** Sends `text` to the session now, queues it while the session is busy, reports an inbox issue when it cannot be delivered. */
export function deliver(s: Session, text: string, source: "schedule" | "trigger") {
  if (!s.proc) return skipped(s, "session stopped");
  const msg = `[orch ${source}] ${text}`;
  if (idle(s)) {
    sendTask(s, msg);
    return;
  }
  const q = pending.get(s.route) ?? [];
  q.push({ text: msg, at: Date.now() });
  pending.set(s.route, q);
}

function flushPending() {
  const busy = awaitingRoutes();
  for (const [route, q] of pending) {
    const s = ctx.sessions.get(route);
    const live = q.filter(p => Date.now() - p.at < PENDING_TTL_MS);
    if (live.length !== q.length && s) skipped(s, "session busy");
    if (!s || !s.proc || !live.length) {
      if (s && !s.proc && live.length) skipped(s, "session stopped");
      pending.delete(route);
      continue;
    }
    if (idle(s) && !busy.has(route)) {
      sendTask(s, live.map(p => p.text).join("\n"));
      pending.delete(route);
    } else pending.set(route, live);
  }
}

// ---------- scheduler ----------
function schedulerTick() {
  const now = new Date();
  for (const s of ctx.sessions.values()) {
    for (const sch of s.recipe?.schedules ?? []) {
      if (!sch.enabled) continue;
      let last = lastRun(sch.id);
      if (!last) {
        // First sight: the clock starts at the recipe's creation (or now, for older sessions), so a schedule added a
        // moment before its minute still fires, and one added to an old session never fires retroactively.
        const created = s.recipe?.createdAt ? Date.parse(s.recipe.createdAt) : NaN;
        const start = Number.isFinite(created) && now.getTime() - created < TICK_MS * 2 ? new Date(created) : now;
        last = start.toISOString();
        setLastRun(sch.id, last);
      }
      let due: Date;
      try {
        due = nextFire(sch.cron, new Date(last));
      } catch {
        continue; // invalid cron stored by hand: never fires
      }
      if (due.getTime() > now.getTime()) continue;
      setLastRun(sch.id, now.toISOString());
      logEvent(s.route, "schedule-fire", { schedule: sch.id, cron: sch.cron });
      deliver(s, sch.text, "schedule");
    }
  }
}

export function startAutomation() {
  setInterval(() => {
    try {
      schedulerTick();
    } catch (e) {
      console.error("scheduler failed", e);
    }
  }, TICK_MS);
  setInterval(flushPending, FLUSH_MS);
}

// Reads at most `max` bytes of a request body; undefined when the body is larger (never buffers more than `max` + one chunk).
async function readCapped(req: Request, max: number): Promise<string | undefined> {
  if (Number(req.headers.get("content-length") ?? 0) > max) return undefined;
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      void reader.cancel();
      return undefined;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

// ---------- webhook ----------
/** `POST /hook/<id>`: 202 when delivered or queued, 404 for an unknown or disabled trigger. */
export async function handleHook(req: Request, id: string): Promise<Response> {
  if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
  for (const s of ctx.sessions.values()) {
    const t = s.recipe?.triggers?.find(x => x.id === id);
    if (!t || !t.enabled) continue;
    const body = await readCapped(req, HOOK_BODY_MAX);
    if (body === undefined) return new Response("payload too large", { status: 413 });
    logEvent(s.route, "trigger-fire", { trigger: t.name, bytes: body.length });
    deliver(s, t.template.replaceAll("{{body}}", body), "trigger");
    return new Response("accepted", { status: 202 });
  }
  return new Response("not found", { status: 404 });
}
