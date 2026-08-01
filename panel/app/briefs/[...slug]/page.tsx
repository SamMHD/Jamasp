import Link from "next/link";
import { notFound } from "next/navigation";
import { Markdown } from "@/components/markdown";
import { readReport } from "@/lib/files";

export const dynamic = "force-dynamic";

export default async function BriefPage({ params }: { params: Promise<{ slug: string[] }> }) {
  const { slug } = await params;
  const text = readReport(slug.join("/"));
  if (text === null) notFound();
  return (
    <div>
      <Link href="/briefs" className="text-sm text-primary">← all briefs</Link>
      <div className="mt-4"><Markdown text={text} /></div>
    </div>
  );
}
