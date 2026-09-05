import { Skeleton, SkeletonPage, SkeletonPageHeader } from "@/components/ui/skeleton";

/** Calendar: header, then events grouped under a Dubai-day heading. */
export default function Loading() {
  return (
    <SkeletonPage label="Calendar">
      <SkeletonPageHeader />
      {Array.from({ length: 4 }, (_, day) => (
        <section key={day} className="mb-6">
          <Skeleton className="mb-2 h-4 w-40" />
          <div className="space-y-2">
            {Array.from({ length: 3 }, (_, row) => (
              <Skeleton key={row} className="h-4 w-full max-w-2xl" />
            ))}
          </div>
        </section>
      ))}
    </SkeletonPage>
  );
}
