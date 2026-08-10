/**
 * Parsing for `state/stance.md` — the agent's current market view.
 *
 * The agent rewrites this file freehand every run, so only what has proven
 * stable across real history is parsed: the `##` section headings (stable
 * across every run inspected, though they take varying parenthetical
 * suffixes) and the `Weights a/b/c (…)` line inside `## View`. The preamble
 * between the H1 and the first `##` uses improvised bold labels every run
 * (`EVENT-PENDING`, `Kpler`, `Crowding`, `Mecca pact`) and is therefore
 * rendered verbatim, never parsed.
 */

/** Lines that begin a new block and must never be folded into the previous one. */
const BLOCK_START = /^\s*(#{1,6}\s|[-*+]\s|\d+[.)]\s|>|\||\s*$)/;
const HEADING = /^\s*#{1,6}\s/;

/**
 * Join hard-wrapped continuation lines into their paragraph.
 *
 * Stance prose is wrapped at ~72 characters, which breaks any line-based
 * regex: searching the raw text for the weights line finds it in 1 of 10
 * real versions; searching unwrapped text finds it in 10 of 10. Run this
 * before any other matching. Blank lines, headings, list-item starts, block
 * quotes, table rows and fenced code are all preserved.
 */
export function unwrapParagraphs(text: string): string {
  const out: string[] = [];
  let fenced = false;
  for (const line of text.split("\n")) {
    if (/^\s*```/.test(line)) {
      fenced = !fenced;
      out.push(line);
      continue;
    }
    const prev = out[out.length - 1];
    const continues =
      !fenced &&
      prev !== undefined &&
      prev.trim() !== "" &&
      line.trim() !== "" &&
      !BLOCK_START.test(line) &&
      !HEADING.test(prev);
    if (continues) out[out.length - 1] = `${prev.replace(/\s+$/, "")} ${line.trim()}`;
    else out.push(line);
  }
  return out.join("\n");
}
