// The billing rule, as plain code. references/billing-rule.md says the same thing in words.
//
// Each of the person's own actions (a message, an approval, an answer) opens a billable window from that moment until
// 10 minutes later. A moment is billable when it falls inside some window, and it goes to the folder of the person's
// most recent action before it. So agent time past the cap counts zero, and parallel sessions can't bill one minute
// twice: any moment belongs to at most one action. Nothing here depends on the order the logs were read in.
//
// Merged-timeline idle-cap counting follows pmochine/agent-hours (MIT), which showed per-session sums double-count.

export const CAP_MS = 10 * 60_000;

/** One thing the person did, with where they did it. */
export type Action = { at: number; agent: string; session: string; folder: string };

/** A stretch of billable time, owned by the action that opened it. */
export type Segment = { start: number; end: number; action: Action };

/** Which client a project folder belongs to. client_id null means the person said it isn't billed. */
export type FolderRule = { folder: string; client_id: number | null; engagement_id?: number | null; client?: string };

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function byTime(a: Action, b: Action): number {
  return a.at - b.at || cmp(a.folder, b.folder) || cmp(a.agent, b.agent) || cmp(a.session, b.session);
}

/** The billable timeline: each action's window, cut short where the person's next action starts. */
export function segments(actions: Action[], cap = CAP_MS): Segment[] {
  const sorted = [...actions].sort(byTime);
  const unique = sorted.filter((a, i) => i === 0 || byTime(a, sorted[i - 1]!) !== 0);
  const out: Segment[] = [];
  for (let i = 0; i < unique.length; i++) {
    const a = unique[i]!;
    const next = unique[i + 1];
    const end = next === undefined ? a.at + cap : Math.min(a.at + cap, next.at);
    if (end > a.at) out.push({ start: a.at, end, action: a });
  }
  return out;
}

/** The rule for a folder: the deepest mapped folder that is it or holds it. */
export function ruleFor(folder: string, rules: FolderRule[]): FolderRule | null {
  let best: FolderRule | null = null;
  for (const r of rules) {
    const base = r.folder.replace(/\/+$/, "") || "/";
    const inside = folder === base || folder.startsWith(base === "/" ? "/" : base + "/");
    if (inside && (best === null || base.length > best.folder.replace(/\/+$/, "").length)) best = r;
  }
  return best;
}

/** Calendar days in one time zone. */
export class Days {
  private fmt: Intl.DateTimeFormat;
  constructor(readonly timezone: string) {
    this.fmt = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  }
  private parts(ms: number) {
    const p = Object.fromEntries(this.fmt.formatToParts(ms).map((x) => [x.type, x.value]));
    return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
  }
  date(ms: number): string {
    return this.parts(ms).date;
  }
  time(ms: number): string {
    return this.parts(ms).time;
  }
  /** Cuts [start, end) at local midnight, giving each piece its own date. */
  split(start: number, end: number): { date: string; start: number; end: number }[] {
    const first = this.date(start);
    if (this.date(end - 1) === first) return [{ date: first, start, end }];
    let lo = start; // last ms on the first date
    let hi = end - 1; // a ms on a later date
    while (hi - lo > 1) {
      const mid = Math.floor((lo + hi) / 2);
      if (this.date(mid) === first) lo = mid;
      else hi = mid;
    }
    return [{ date: first, start, end: hi }, ...this.split(hi, end)];
  }
}

export type Session = { agent: string; session: string; folder: string; minutes: number };

export type Entry = {
  date: string;
  client_id: number;
  engagement_id: number | null;
  client: string | null;
  minutes: number;
  hours: number;
  /** Exact billable time, before rounding to whole minutes. */
  ms: number;
  spans: { start: string; end: string; local: string }[];
  sessions: Session[];
  note: string;
  source: string;
  idempotency_key: string;
};

export type Unbilled = { date: string; folder: string; minutes: number; why: "not mapped" | "not billed" };

const basename = (p: string) => p.replace(/\/+$/, "").split("/").pop() || p;
const round1 = (n: number) => Math.round(n * 10) / 10;

/**
 * Turns the person's actions into one entry per client (and engagement) per day, for the days from..to inclusive.
 * Minutes round to the nearest whole minute once, per entry.
 */
export function entries(actions: Action[], rules: FolderRule[], days: Days, from: string, to: string, cap = CAP_MS) {
  type Acc = { client_id: number; engagement_id: number | null; client: string | null; ms: number; pieces: [number, number][]; sessions: Map<string, Session & { ms: number }> };
  const billed = new Map<string, Acc & { date: string }>();
  const unbilled = new Map<string, { date: string; folder: string; ms: number; why: Unbilled["why"] }>();

  for (const seg of segments(actions, cap)) {
    for (const piece of days.split(seg.start, seg.end)) {
      if (piece.date < from || piece.date > to) continue;
      const ms = piece.end - piece.start;
      const rule = ruleFor(seg.action.folder, rules);
      if (rule === null || rule.client_id === null) {
        const why = rule === null ? "not mapped" : "not billed";
        const folder = rule === null ? seg.action.folder : rule.folder;
        const k = `${piece.date}\0${folder}`;
        const u = unbilled.get(k) ?? { date: piece.date, folder, ms: 0, why };
        u.ms += ms;
        unbilled.set(k, u);
        continue;
      }
      const engagement_id = rule.engagement_id ?? null;
      const k = `${piece.date}\0${rule.client_id}\0${engagement_id}`;
      const e = billed.get(k) ?? { date: piece.date, client_id: rule.client_id, engagement_id, client: rule.client ?? null, ms: 0, pieces: [], sessions: new Map() };
      e.ms += ms;
      e.pieces.push([piece.start, piece.end]);
      const sk = `${seg.action.agent}\0${seg.action.session}\0${seg.action.folder}`;
      const s = e.sessions.get(sk) ?? { agent: seg.action.agent, session: seg.action.session, folder: seg.action.folder, minutes: 0, ms: 0 };
      s.ms += ms;
      e.sessions.set(sk, s);
      billed.set(k, e);
    }
  }

  const out: Entry[] = [];
  for (const e of billed.values()) {
    const minutes = Math.round(e.ms / 60_000);
    if (minutes < 1) continue; // under half a minute in a day: nothing to bill
    e.pieces.sort((a, b) => a[0] - b[0]);
    const spans: [number, number][] = [];
    for (const [s, t] of e.pieces) {
      const last = spans[spans.length - 1];
      if (last && last[1] === s) last[1] = t;
      else spans.push([s, t]);
    }
    const sessions = [...e.sessions.values()]
      .sort((a, b) => cmp(a.agent, b.agent) || cmp(a.session, b.session) || cmp(a.folder, b.folder))
      .map(({ ms, ...s }) => ({ ...s, minutes: round1(ms / 60_000) }));
    const ids = [...new Set(sessions.map((s) => `${s.agent}/${s.session}`))];
    const folders = [...new Set(sessions.map((s) => basename(s.folder)))].sort(cmp);
    out.push({
      date: e.date,
      client_id: e.client_id,
      engagement_id: e.engagement_id,
      client: e.client,
      minutes,
      hours: Math.round((minutes / 60) * 100) / 100,
      ms: e.ms,
      spans: spans.map(([s, t]) => ({ start: new Date(s).toISOString(), end: new Date(t).toISOString(), local: `${days.time(s)}-${days.time(t)}` })),
      sessions,
      note: `Directed coding agents in ${folders.join(", ")}`,
      source: `agent-time: ${ids.join(", ")}`,
      // One entry per client, engagement and day. If that day's logs or folders change after it was written,
      // solobooks refuses the changed entry under the same key instead of billing the day twice.
      idempotency_key: `agent-time:${e.date}:client-${e.client_id}:engagement-${e.engagement_id ?? "none"}`,
    });
  }
  out.sort((a, b) => cmp(a.date, b.date) || a.client_id - b.client_id || (a.engagement_id ?? 0) - (b.engagement_id ?? 0));

  const skipped: Unbilled[] = [...unbilled.values()]
    .map((u) => ({ date: u.date, folder: u.folder, minutes: round1(u.ms / 60_000), why: u.why }))
    .sort((a, b) => cmp(a.date, b.date) || cmp(a.folder, b.folder));
  return { entries: out, unbilled: skipped };
}
