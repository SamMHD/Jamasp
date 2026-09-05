import { Skeleton, SkeletonPage, SkeletonPageHeader } from "@/components/ui/skeleton";

/**
 * Briefs: header plus the report list. Also covers `briefs/[...slug]` for as
 * long as that segment has no `loading.tsx` of its own — it does (a prose
 * shape), because a report reads nothing like a list of links.
 */
export default function Loading() {
  return (
    <SkeletonPage label="Briefs">
      <SkeletonPageHeader />
      <div className="space-y-2">
        {Array.from({ length: 14 }, (_, i) => <Skeleton key={i} className="h-4 w-64" />)}
      </div>
    </SkeletonPage>
  );
}
