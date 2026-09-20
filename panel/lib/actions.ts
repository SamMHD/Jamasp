"use server";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { JAMASP_ROOT } from "./paths";
import { buildWakeupAddArgs, buildWakeupCancelArgs } from "./cliArgs";
import { validateWakeup } from "./validate";
import { LANG_COOKIE, LOCALES, type Locale } from "./i18n";

const pexec = promisify(execFile);

export type ActionResult = { ok: boolean; message: string };

async function jamasp(args: string[]): Promise<ActionResult> {
  try {
    const { stdout } = await pexec("uv", ["run", "jamasp", ...args],
      { cwd: JAMASP_ROOT, timeout: 60_000 });
    return { ok: true, message: stdout.trim() };
  } catch (e: unknown) {
    const err = e as { stderr?: string; stdout?: string; message?: string };
    return { ok: false,
      message: (err.stderr || err.stdout || err.message || "command failed").trim() };
  }
}

export async function markInboxRead(): Promise<ActionResult> {
  const r = await jamasp(["inbox", "--mark-read"]);
  if (r.ok) revalidatePath("/inbox");
  return r;
}

export async function addWakeup(dueAt: string, runType: string, task: string):
  Promise<ActionResult> {
  const v = validateWakeup(dueAt, runType, task);
  if (!v.ok) return { ok: false, message: v.error };
  const r = await jamasp(buildWakeupAddArgs(v.dueAtUtc, runType, task));
  if (r.ok) revalidatePath("/schedule");
  return r;
}

export async function cancelWakeup(id: number): Promise<ActionResult> {
  if (!Number.isInteger(id) || id < 1) return { ok: false, message: `bad wakeup id: ${id}` };
  const r = await jamasp(buildWakeupCancelArgs(id));
  if (r.ok) revalidatePath("/schedule");
  return r;
}

export async function runNow(runType: string, task: string): Promise<ActionResult> {
  return addWakeup(new Date().toISOString(), runType,
    task.trim() || `${runType} triggered from panel`);
}

/**
 * Persist the viewer's language choice.
 *
 * A cookie rather than a database row: the panel's rule is that every DATA
 * write goes through the `jamasp` CLI, and a per-browser display preference
 * is not data. This also keeps the choice working on a host where the CLI is
 * mid-deploy.
 *
 * `revalidatePath("/", "layout")` rather than a client-side refresh, because
 * the locale changes server-rendered output — every headline, every label —
 * not just what the browser paints.
 */
export async function setLocale(locale: Locale): Promise<void> {
  if (!LOCALES.includes(locale)) return;
  const jar = await cookies();
  jar.set(LANG_COOKIE, locale, {
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
    sameSite: "lax",
    // No client component reads this cookie directly; the locale reaches
    // them as a prop threaded down from the server, like every other piece
    // of data in this panel. Nothing needs script access to it, so don't
    // grant it.
    httpOnly: true,
  });
  revalidatePath("/", "layout");
}
