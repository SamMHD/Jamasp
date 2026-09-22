import { t, type Messages } from "@/lib/i18n";

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

/**
 * "3h ago" / "in 2d", in the reader's own language.
 *
 * `messages` is required and sits BEFORE the optional `now` so the compiler
 * catches a caller that forgets — this string reaches the news flow, every
 * quote tile, the status strip, predictions and the stance header, which
 * makes it the most-repeated piece of chrome in the panel and the most
 * expensive one to leave English.
 *
 * The magnitude and its unit stay Latin ("3h", "2d") in both locales. That
 * is compact chrome notation in the same register as "24h" and "w/w", which
 * this panel already keeps Latin deliberately, and it honours the global
 * rule that digits never become Persian-Indic. Only the "ago"/"in" wrapper
 * is an English WORD, and only that goes through the dictionary — as a
 * template, because Persian puts the qualifier on the other side ("تا 2h").
 */
export function fmtAge(ts: string, messages: Messages, now: Date = new Date()): string {
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
  return t(messages, future ? "time.inTemplate" : "time.agoTemplate")
    .replace("{age}", label);
}
