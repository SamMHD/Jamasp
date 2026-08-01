const DUBAI_OFFSET_MS = 4 * 3600_000;
const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

export function cls(...parts: (string | false | undefined | null)[]): string {
  return parts.filter(Boolean).join(" ");
}

export function fmtUtc(ts: string): string {
  const d = new Date(ts);
  if (isNaN(d.getTime())) return ts;
  const p = (n: number) => String(n).padStart(2, "0");
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}Z`;
}

export function fmtDubai(ts: string): string {
  const d = new Date(new Date(ts).getTime() + DUBAI_OFFSET_MS);
  if (isNaN(d.getTime())) return ts;
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getUTCHours())}:${p(d.getUTCMinutes())} DXB`;
}

export function fmtAge(ts: string, now: Date = new Date()): string {
  const then = new Date(ts).getTime();
  if (isNaN(then)) return ts;
  let diff = now.getTime() - then;
  const future = diff < 0;
  diff = Math.abs(diff);
  const mins = Math.round(diff / 60_000);
  const label =
    mins < 60 ? `${mins}m` :
    mins < 48 * 60 ? `${Math.round(mins / 60)}h` :
    `${Math.round(mins / 1440)}d`;
  return future ? `in ${label}` : `${label} ago`;
}
