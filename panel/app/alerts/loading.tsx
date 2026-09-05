import { Skeleton, SkeletonPage, SkeletonPageHeader } from "@/components/ui/skeleton";

/** Alerts: header, the Sent/Warnings tab strip, then the message list. */
export default function Loading() {
  return (
    <SkeletonPage label="Alerts">
      <SkeletonPageHeader subtitle={false} />
      <div className="mb-4 flex gap-2">
        <Skeleton className="h-9 w-28" />
        <Skeleton className="h-9 w-32" />
      </div>
      <div className="space-y-3">
        {Array.from({ length: 8 }, (_, i) => <Skeleton key={i} className="h-12 w-full" />)}
      </div>
    </SkeletonPage>
  );
}
