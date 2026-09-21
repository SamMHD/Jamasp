import { cookies } from "next/headers";
import Link from "next/link";
import { PageHeader } from "@/components/page-header";
import { listReports } from "@/lib/files";
import { getMessages, LANG_COOKIE, resolveLocale, t } from "@/lib/i18n";

export const dynamic = "force-dynamic";

export default async function BriefsPage() {
  // Same pattern as the other list pages: only the chrome (title, subtitle,
  // empty state) is localized here — per the brief, "the briefs index lists
  // filenames and dates" (below) "those stay as they are."
  const locale = resolveLocale((await cookies()).get(LANG_COOKIE)?.value);
  const messages = getMessages(locale);
  const reports = listReports();
  return (
    <div>
      <PageHeader title={t(messages, "nav.briefs")}
        subtitle={`${reports.length} ${t(messages, "briefs.subtitleReports")}`} />
      <ul className="space-y-1">
        {reports.length === 0 && <li className="text-sm text-muted-foreground">{t(messages, "briefs.noReportsYet")}</li>}
        {reports.map(r => (
          <li key={r.slug}>
            <Link href={`/briefs/${r.slug}`} className="text-sm hover:text-primary">
              {r.slug.split("/").pop()}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
