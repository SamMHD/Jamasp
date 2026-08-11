/**
 * News-volume shape for the fundamental band. Pure — the page reads the
 * SQL aggregate (db.itemVolumeByDay) and the newest item timestamp, this
 * derives the window.
 *
 * The window is anchored to the newest item, not to `now` — the same
 * decision the spot chart made for a frozen feed: when ingest stalls the
 * desk should keep seeing the final fortnight of shape while the
 * "last item Nh ago" caption states the staleness, rather than watching
 * bars slide off the axis as wall-clock time drifts. The ingest-stale
 * warning at the top of the page owns the alarm.
 *
 * Split is gold topic vs everything else — the emphasis form: the desk's
 * question is "how heavy is the flow and how much of it is about gold";
 * seven topics as seven hues would bury that answer (and outrun the three
 * validated categorical slots). The full per-topic breakdown stays in
 * each bar's hover title and the table twin.
 */

export type VolumeRow = { day: string; topic: string; n: number };

export type PulseDay = {
  /** UTC day, "2026-08-11". */
  day: string;
  gold: number;
  other: number;
  byTopic: Record<string, number>;
};

export type NewsPulse = {
  /** Oldest first; exactly windowDays entries, zero-filled. Empty when no items exist. */
  days: PulseDay[];
  anchorDay: string | null;
  total: number;
  maxTotal: number;
};

const DAY_MS = 86400_000;

export function deriveNewsPulse(
  rows: VolumeRow[],
  anchorTs: string | null,
  windowDays = 14,
): NewsPulse {
  const anchorMs = anchorTs === null ? NaN : Date.parse(anchorTs);
  if (!Number.isFinite(anchorMs)) {
    return { days: [], anchorDay: null, total: 0, maxTotal: 0 };
  }
  const anchorDay = new Date(anchorMs).toISOString().slice(0, 10);
  const anchorDayMs = Date.parse(`${anchorDay}T00:00:00Z`);

  const byDay = new Map<string, PulseDay>();
  const days: PulseDay[] = [];
  for (let i = windowDays - 1; i >= 0; i--) {
    const day = new Date(anchorDayMs - i * DAY_MS).toISOString().slice(0, 10);
    const d: PulseDay = { day, gold: 0, other: 0, byTopic: {} };
    byDay.set(day, d);
    days.push(d);
  }

  for (const r of rows) {
    const d = byDay.get(r.day);
    if (!d || !(r.n > 0)) continue; // outside the day window (the SQL cutoff is wider)
    if (r.topic === "gold") d.gold += r.n;
    else d.other += r.n;
    d.byTopic[r.topic] = (d.byTopic[r.topic] ?? 0) + r.n;
  }

  let total = 0;
  let maxTotal = 0;
  for (const d of days) {
    const t = d.gold + d.other;
    total += t;
    if (t > maxTotal) maxTotal = t;
  }
  return { days, anchorDay, total, maxTotal };
}
