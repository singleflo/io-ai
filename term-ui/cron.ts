// Minimal 5-field cron (minute hour day-of-month month day-of-week), evaluated in local time.
// Supports `*`, `n`, `a-b`, `a,b`, `*/n`, `a-b/n`. Day-of-week 0 and 7 are Sunday.
// As in classic cron, when both day-of-month and day-of-week are restricted a day matches if either matches.

type Field = { values: Set<number>; star: boolean };
type Spec = { minute: Field; hour: Field; dom: Field; month: Field; dow: Field };

const RANGES: [min: number, max: number][] = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]];

function parseField(text: string, [min, max]: [number, number], expr: string): Field {
  const invalid = () => new Error(`invalid cron: ${expr}`);
  const values = new Set<number>();
  for (const part of text.split(",")) {
    const m = /^(?:\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(part);
    if (!m) throw invalid();
    const step = m[3] === undefined ? 1 : Number(m[3]);
    if (step < 1) throw invalid();
    const from = m[1] === undefined ? min : Number(m[1]);
    // `n/step` without a range is not standard cron: only `*/n` and `a-b/n` take a step
    if (m[1] !== undefined && m[2] === undefined && m[3] !== undefined) throw invalid();
    const to = m[1] === undefined ? max : m[2] === undefined ? from : Number(m[2]);
    if (from < min || to > max || from > to) throw invalid();
    for (let v = from; v <= to; v += step) values.add(v);
  }
  return { values, star: text === "*" };
}

function parse(expr: string): Spec {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) throw new Error(`invalid cron: ${expr}`);
  const [minute, hour, dom, month, dow] = fields.map((f, i) => parseField(f, RANGES[i], expr));
  if (dow.values.has(7)) dow.values.add(0);
  return { minute, hour, dom, month, dow };
}

const dayMatches = (spec: Spec, d: Date): boolean => {
  const domOk = spec.dom.values.has(d.getDate());
  const dowOk = spec.dow.values.has(d.getDay());
  if (spec.dom.star || spec.dow.star) return domOk && dowOk;
  return domOk || dowOk;
};

/** First fire time strictly after `after` (minute resolution). Throws `invalid cron: <expr>`. */
export function nextFire(expr: string, after: Date): Date {
  const spec = parse(expr);
  const d = new Date(after.getTime());
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1);
  const limit = after.getFullYear() + 6;
  while (d.getFullYear() <= limit) {
    if (!spec.month.values.has(d.getMonth() + 1)) {
      d.setMonth(d.getMonth() + 1, 1);
      d.setHours(0, 0, 0, 0);
      continue;
    }
    if (!dayMatches(spec, d)) {
      d.setDate(d.getDate() + 1);
      d.setHours(0, 0, 0, 0);
      continue;
    }
    if (!spec.hour.values.has(d.getHours())) {
      d.setHours(d.getHours() + 1, 0, 0, 0);
      continue;
    }
    if (!spec.minute.values.has(d.getMinutes())) {
      d.setMinutes(d.getMinutes() + 1, 0, 0);
      continue;
    }
    return d;
  }
  throw new Error(`invalid cron: ${expr}`);
}

export const validCron = (expr: string): boolean => {
  try {
    parse(expr);
    return true;
  } catch {
    return false;
  }
};
