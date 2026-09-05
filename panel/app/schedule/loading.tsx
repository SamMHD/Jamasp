import { Skeleton, SkeletonPage, SkeletonPageHeader, SkeletonRows } from "@/components/ui/skeleton";

/** Schedule: the run-cap stat card and controls, then three tables. */
export default function Loading() {
  return (
    <SkeletonPage label="Schedule">
      <SkeletonPageHeader subtitle={false} />
      <div className="mb-6 flex flex-wrap items-center gap-4">
        <Skeleton className="h-16 w-40" />
        <div className="space-y-2">
          <Skeleton className="h-9 w-64" />
          <Skeleton className="h-9 w-40" />
        </div>
      </div>
      <Skeleton className="mb-2 h-4 w-40" />
      <SkeletonRows rows={4} />
      <Skeleton className="mb-2 mt-8 h-4 w-32" />
      <SkeletonRows rows={8} />
    </SkeletonPage>
  );
}
