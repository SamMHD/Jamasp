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

export function RunNowButtons({ capped }: { capped: boolean }) {
  const { pending, act } = useAct();
  const [task, setTask] = useState("");
  return (
    <div className="flex flex-wrap items-center gap-2">
      {RUN_TYPES.filter(t => t !== "retro").map(t => (
        <Button key={t} size="sm" variant="outline" disabled={pending || capped}
          title={capped ? "daily run cap reached" : `queue a ${t} run now`}
          onClick={() => act(() => runNow(t, task))}>
          Run {t} now
        </Button>
      ))}
      <Input className="w-64"
        placeholder="optional task text — blank defaults to a generic note, for any run type"
        value={task} onChange={e => setTask(e.target.value)} />
      {capped && <span className="text-xs text-primary">cap reached — runs disabled</span>}
    </div>
  );
}

export function AddWakeupDialog() {
  const { pending, act } = useAct();
  const [open, setOpen] = useState(false);
  const [due, setDue] = useState("");
  const [type, setType] = useState<string>("deepdive");
  const [task, setTask] = useState("");
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild><Button size="sm">Schedule wakeup</Button></DialogTrigger>
      <DialogContent>
        <DialogHeader><DialogTitle>Schedule a wakeup</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div>
            <Label htmlFor="due">Due (your local time)</Label>
            <Input id="due" type="datetime-local" value={due}
              onChange={e => setDue(e.target.value)} />
          </div>
          <div>
            <Label htmlFor="type">Run type</Label>
            <select id="type" value={type} onChange={e => setType(e.target.value)}
              className="w-full rounded border border-border bg-background px-2 py-1.5 text-sm">
              {RUN_TYPES.map(t => <option key={t}>{t}</option>)}
            </select>
          </div>
          <div>
            <Label htmlFor="task">Task (required)</Label>
            <Input id="task" value={task} onChange={e => setTask(e.target.value)}
              placeholder="e.g. read the Fed statement and assess gold impact" />
          </div>
          <Button disabled={pending || !due} onClick={() => {
            act(() => addWakeup(new Date(due).toISOString(), type, task), r => {
              if (r.ok) setOpen(false);
            });
          }}>Schedule</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function CancelButton({ id }: { id: number }) {
  const { pending, act } = useAct();
  return (
    <Button size="sm" variant="ghost" disabled={pending}
      title="Only works before the wakeup fires — cannot stop a run already in progress"
      onClick={() => act(() => cancelWakeup(id))}>cancel</Button>
  );
}
