import { Skeleton, SkeletonPage, SkeletonPageHeader } from "@/components/ui/skeleton";

/** Prices: header, then the per-symbol chart grid (1 column, 2 at xl). */
export default function Loading() {
  return (
    <SkeletonPage label="Prices">
      <SkeletonPageHeader />
      <div className="grid gap-4 xl:grid-cols-2">
        {Array.from({ length: 6 }, (_, i) => (
          <section key={i} className="rounded border border-border p-4">
            <Skeleton className="mb-3 h-4 w-28" />
            <Skeleton className="h-40 w-full" />
          </section>
        ))}
      </div>
    </SkeletonPage>
  );
}
