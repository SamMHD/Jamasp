import { Skeleton, SkeletonPage, SkeletonText } from "@/components/ui/skeleton";

/** A single brief: the back link, then report prose. */
export default function Loading() {
  return (
    <SkeletonPage label="brief">
      <Skeleton className="h-4 w-24" />
      <div className="mt-6 space-y-6">
        <Skeleton className="h-7 w-80" />
        <SkeletonText lines={5} />
        <Skeleton className="h-5 w-56" />
        <SkeletonText lines={7} />
        <Skeleton className="h-5 w-48" />
        <SkeletonText lines={6} />
      </div>
    </SkeletonPage>
  );
}
