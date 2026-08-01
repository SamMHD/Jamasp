import { PageHeader } from "@/components/page-header";
import { PriceChart } from "@/components/price-chart";
import { getPriceSnapshots } from "@/lib/db";

export const dynamic = "force-dynamic";

export default function Page() {
  const snapshots = getPriceSnapshots();
  return (
    <div>
      <PageHeader title="Prices" subtitle={`${snapshots.length} symbols tracked`} />
      <div className="grid gap-4 xl:grid-cols-2">
        {snapshots.length === 0 && <p className="text-sm text-muted-foreground">no price data yet</p>}
        {snapshots.map(s => <PriceChart key={s.symbol} symbol={s.symbol} />)}
      </div>
    </div>
  );
}
