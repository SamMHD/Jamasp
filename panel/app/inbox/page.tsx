import { cookies } from "next/headers";
import { AutoRefresh } from "@/components/auto-refresh";
import { PageHeader } from "@/components/page-header";
import { InboxTable } from "@/components/inbox-table";
import { getItemFilters, getUnreadCount } from "@/lib/db";
import { getMessages, LANG_COOKIE, resolveLocale, t } from "@/lib/i18n";

export const dynamic = "force-dynamic";

export default async function InboxPage() {
  const { sources, topics } = getItemFilters();
  // Resolved here, not in InboxTable: that component is a client component
  // fetching /api/inbox, and the lang cookie is httpOnly — see
  // components/shell/app-shell.tsx's identical read for why no client
  // component may read it directly.
  const locale = resolveLocale((await cookies()).get(LANG_COOKIE)?.value);
  const messages = getMessages(locale);
  return (
    <div>
      <AutoRefresh />
      <PageHeader title={t(messages, "nav.inbox")}
        subtitle={`${getUnreadCount()} ${t(messages, "inbox.unreadSubtitle")}`} />
      <InboxTable sources={sources} topics={topics} locale={locale} messages={messages} />
    </div>
  );
}
