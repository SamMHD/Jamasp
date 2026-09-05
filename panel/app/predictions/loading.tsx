import { Skeleton, SkeletonPage, SkeletonPageHeader } from "@/components/ui/skeleton";

/**
 * Predictions: header, the state filter strip, then the Live / Resolved
 * split the unfiltered ledger opens with.
 *
 * Six filter chips because that is what the page always renders — `all`
 * plus the five states in lib/predictions.ts (due, open, hit, miss,
 * unclear) — so the strip does not reflow when the real counts land. The
 * rows are the collapsed `<details>` summary height, two lines of claim
 * under a meta line, which is the shape every row has before anyone opens
 * one.
 */
export default function Loading() {
  return (
    <SkeletonPage label="Predictions">
      <SkeletonPageHeader />
      <div className="mb-4 flex flex-wrap gap-1.5">
        {Array.from({ length: 6 }, (_, i) => (
          <Skeleton key={i} className="h-8 w-20" />
        ))}
      </div>
      {["Live", "Resolved"].map(section => (
        <section key={section} className="mb-8">
          <Skeleton className="mb-2 h-4 w-56" />
          <div className="space-y-2">
            {Array.from({ length: 5 }, (_, row) => (
              <Skeleton key={row} className="h-14 w-full" />
            ))}
          </div>
        </section>
      ))}
    </SkeletonPage>
  );
}
