import { cookies } from "next/headers";
import { PageHeader } from "@/components/page-header";
import { PriceChart } from "@/components/price-chart";
import { getPriceSnapshots } from "@/lib/db";
import { getMessages, LANG_COOKIE, resolveLocale, t } from "@/lib/i18n";

export const dynamic = "force-dynamic";

export default async function Page() {
  const locale = resolveLocale((await cookies()).get(LANG_COOKIE)?.value);
  const messages = getMessages(locale);
  const snapshots = getPriceSnapshots();
  return (
    <div>
      <PageHeader title={t(messages, "nav.prices")}
        subtitle={`${snapshots.length} ${t(messages, "prices.symbolsTracked")}`} />
      <div className="grid gap-4 xl:grid-cols-2">
        {snapshots.length === 0 && <p className="text-sm text-muted-foreground">{t(messages, "common.noPriceData")}</p>}
        {snapshots.map(s => <PriceChart key={s.symbol} symbol={s.symbol} messages={messages} />)}
      </div>
    </div>
  );
}
