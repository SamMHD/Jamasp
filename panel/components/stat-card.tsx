import { Card, CardContent } from "@/components/ui/card";
import { cls } from "@/lib/format";

const TONES = { ok: "text-emerald-400", warn: "text-amber-400", bad: "text-red-400" };

export function StatCard({ label, value, sub, tone }: {
  label: string; value: string; sub?: string; tone?: keyof typeof TONES;
}) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className="text-xs uppercase tracking-wide text-muted-foreground">{label}</div>
        <div className={cls("mt-1 text-2xl font-semibold", tone && TONES[tone])}>{value}</div>
        {sub && <div className="text-xs text-muted-foreground">{sub}</div>}
      </CardContent>
    </Card>
  );
}
