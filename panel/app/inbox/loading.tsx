import { Skeleton, SkeletonPage, SkeletonPageHeader, SkeletonRows } from "@/components/ui/skeleton";

/** Inbox: header, the filter row, then the item table. */
export default function Loading() {
  return (
    <SkeletonPage label="Inbox">
      <SkeletonPageHeader />
      <div className="mb-3 flex flex-wrap gap-2">
        <Skeleton className="h-9 w-56" />
        <Skeleton className="h-9 w-40" />
        <Skeleton className="h-9 w-40" />
        <Skeleton className="h-9 w-28" />
      </div>
      <SkeletonRows rows={12} />
    </SkeletonPage>
  );
}
