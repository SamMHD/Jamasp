import Link from "next/link";
import { PageHeader } from "@/components/page-header";
import { listReports } from "@/lib/files";

export const dynamic = "force-dynamic";

export default function BriefsPage() {
  const reports = listReports();
  return (
    <div>
      <PageHeader title="Briefs" subtitle={`${reports.length} reports`} />
      <ul className="space-y-1">
        {reports.length === 0 && <li className="text-sm text-muted-foreground">no reports yet</li>}
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
