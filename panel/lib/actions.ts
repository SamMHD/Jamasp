"use server";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { revalidatePath } from "next/cache";
import { JAMASP_ROOT } from "./paths";
import { buildWakeupAddArgs, buildWakeupCancelArgs } from "./cliArgs";
import { validateWakeup } from "./validate";

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
