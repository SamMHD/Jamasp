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
              {/* `value={rt}` explicit: the option's text now carries the
                  translated label, and a <select> with no `value` submits
                  its TEXT CONTENT — without this the wakeup would be
                  scheduled with a Persian string instead of the run_type
                  slug addWakeup expects. */}
              {RUN_TYPES.map(rt => (
                <option key={rt} value={rt}>{runTypeLabel(rt, messages)}</option>
              ))}
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
