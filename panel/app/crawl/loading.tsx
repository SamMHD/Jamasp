import { SkeletonPage, SkeletonPageHeader, SkeletonRows } from "@/components/ui/skeleton";

/** Crawl: header plus the per-source health table. */
export default function Loading() {
  return (
    <SkeletonPage label="Crawl">
      <SkeletonPageHeader />
      <SkeletonRows rows={12} />
    </SkeletonPage>
  );
}
