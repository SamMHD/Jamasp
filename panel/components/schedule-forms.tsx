"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { addWakeup, cancelWakeup, runNow, type ActionResult } from "@/lib/actions";
import { RUN_TYPES } from "@/lib/validate";
import { t, type Messages } from "@/lib/i18n";

// `runType.*` — same dictionary keys and the same reasoning as
// components/status-strip.tsx's inline `runTypeLabel`: a one-line t() call
// does not earn a component-to-component import.
const runTypeLabel = (runType: string, messages: Messages): string =>
  t(messages, `runType.${runType}`);

function useAct() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const act = (fn: () => Promise<ActionResult>, onDone?: (r: ActionResult) => void) =>
    start(async () => {
      const r = await fn();
      if (r.ok) toast.success(r.message); else toast.error(r.message);
      router.refresh();
      onDone?.(r);
    });
  return { pending, act };
}

export function RunNowButtons({ capped, messages }: { capped: boolean; messages: Messages }) {
  const { pending, act } = useAct();
  const [task, setTask] = useState("");
  return (
    <div className="flex flex-wrap items-center gap-2">
      {RUN_TYPES.filter(rt => rt !== "retro").map(rt => (
        <Button key={rt} size="sm" variant="outline" disabled={pending || capped}
          title={capped ? "daily run cap reached" : `queue a ${rt} run now`}
          onClick={() => act(() => runNow(rt, task))}>
          {t(messages, "schedule.runNowPrefix")} {runTypeLabel(rt, messages)} {t(messages, "schedule.runNowSuffix")}
        </Button>
      ))}
      <Input className="w-64"
        placeholder={t(messages, "schedule.taskPlaceholder")}
        value={task} onChange={e => setTask(e.target.value)} />
      {capped && <span className="text-xs text-primary">{t(messages, "schedule.capReachedNote")}</span>}
    </div>
  );
}

/**
 * The run-type `<option>` list, exported so it can be rendered on its own.
 *
 * Radix mounts DialogContent's portal only once `open` is true, and
 * AddWakeupDialog holds `open` in internal state with no prop to force it,
 * so a static render of the dialog sees the trigger button and nothing
 * else. Lifting the options out is the same escape hatch
 * components/inbox-table.tsx's ItemHeadline uses: one exported call site,
 * rendered by the dialog and asserted directly by the test.
 *
 * `value={rt}` is the load-bearing part. A `<select>` with no explicit
 * `value` submits its option's TEXT CONTENT — and that text is now a
 * translated label, so without this the wakeup would be scheduled with a
 * Persian string where addWakeup expects the Latin run_type slug.
 */
export function RunTypeOptions({ messages }: { messages: Messages }) {
  return (
    <>
      {RUN_TYPES.map(rt => (
        <option key={rt} value={rt}>{runTypeLabel(rt, messages)}</option>
      ))}
    </>
  );
}

export function AddWakeupDialog({ messages }: { messages: Messages }) {
  const { pending, act } = useAct();
  const [open, setOpen] = useState(false);
  const [due, setDue] = useState("");
  const [type, setType] = useState<string>("deepdive");
  const [task, setTask] = useState("");
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild><Button size="sm">{t(messages, "schedule.scheduleWakeupBtn")}</Button></DialogTrigger>
      <DialogContent>
        <DialogHeader><DialogTitle>{t(messages, "schedule.scheduleADialogTitle")}</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div>
            <Label htmlFor="due">{t(messages, "schedule.dueLocalLabel")}</Label>
            <Input id="due" type="datetime-local" value={due}
              onChange={e => setDue(e.target.value)} />
          </div>
          <div>
            <Label htmlFor="type">{t(messages, "schedule.runTypeFieldLabel")}</Label>
            <select id="type" value={type} onChange={e => setType(e.target.value)}
              className="w-full rounded border border-border bg-background px-2 py-1.5 text-sm">
              <RunTypeOptions messages={messages} />
            </select>
          </div>
          <div>
            <Label htmlFor="task">{t(messages, "schedule.taskRequiredLabel")}</Label>
            <Input id="task" value={task} onChange={e => setTask(e.target.value)}
              placeholder={t(messages, "schedule.taskExamplePlaceholder")} />
          </div>
          <Button disabled={pending || !due} onClick={() => {
            act(() => addWakeup(new Date(due).toISOString(), type, task), r => {
              if (r.ok) setOpen(false);
            });
          }}>{t(messages, "schedule.scheduleBtn")}</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function CancelButton({ id, messages }: { id: number; messages: Messages }) {
  const { pending, act } = useAct();
  return (
    <Button size="sm" variant="ghost" disabled={pending}
      title="Only works before the wakeup fires — cannot stop a run already in progress"
      onClick={() => act(() => cancelWakeup(id))}>{t(messages, "common.cancel")}</Button>
  );
}
