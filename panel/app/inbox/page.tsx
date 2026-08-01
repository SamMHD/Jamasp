import { AutoRefresh } from "@/components/auto-refresh";
import { PageHeader } from "@/components/page-header";
import { InboxTable } from "@/components/inbox-table";
import { getItemFilters, getUnreadCount } from "@/lib/db";

export const dynamic = "force-dynamic";

export default function InboxPage() {
  const { sources, topics } = getItemFilters();
  return (
    <div>
      <AutoRefresh />
      <PageHeader title="Inbox" subtitle={`${getUnreadCount()} unread cluster representatives`} />
      <InboxTable sources={sources} topics={topics} />
    </div>
  );
}
