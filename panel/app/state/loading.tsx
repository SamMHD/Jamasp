import {
  Skeleton, SkeletonPage, SkeletonPageHeader, SkeletonRows, SkeletonText,
} from "@/components/ui/skeleton";

/** State: stance prose, the watchlist, the predictions table, the playbook. */
export default function Loading() {
  return (
    <SkeletonPage label="State">
      <SkeletonPageHeader subtitle={false} />
      <section className="mb-8">
        <Skeleton className="mb-2 h-4 w-24" />
        <SkeletonText lines={6} />
      </section>
      <section className="mb-8">
        <Skeleton className="mb-2 h-4 w-28" />
        <SkeletonText lines={4} />
      </section>
      <section className="mb-8">
        <Skeleton className="mb-2 h-4 w-56" />
        <SkeletonRows rows={8} />
      </section>
      <section>
        <Skeleton className="mb-2 h-4 w-24" />
        <SkeletonText lines={5} />
      </section>
    </SkeletonPage>
  );
}
