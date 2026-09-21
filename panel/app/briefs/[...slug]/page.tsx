import { cookies } from "next/headers";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Markdown } from "@/components/markdown";
import { SourceLang } from "@/components/source-lang";
import { readReport, readReportFa } from "@/lib/files";
import { getMessages, LANG_COOKIE, resolveLocale, t } from "@/lib/i18n";

export const dynamic = "force-dynamic";

export default async function BriefPage({ params }: { params: Promise<{ slug: string[] }> }) {
  const { slug } = await params;
  const text = readReport(slug.join("/"));
  if (text === null) notFound();

  // Same pattern as app/state/page.tsx's LocalizedDocument: a whole-document
  // sidecar with no sub-structure to hang a finer-grained marker on, so
  // English-with-one-marker is the fallback whenever the Persian body is
  // absent or its recorded hash no longer matches this report.
  const locale = resolveLocale((await cookies()).get(LANG_COOKIE)?.value);
  const messages = getMessages(locale);
  const reportFa = locale === "fa" ? readReportFa(slug) : null;

  return (
    <div>
      <Link href="/briefs" className="text-sm text-primary">{t(messages, "briefs.backToAllBriefs")}</Link>
      <div className="mt-4">
        {reportFa !== null ? (
          <Markdown text={reportFa} />
        ) : (
          <SourceLang fallback={locale === "fa"} messages={messages} block>
            <Markdown text={text} />
          </SourceLang>
        )}
      </div>
    </div>
  );
}
