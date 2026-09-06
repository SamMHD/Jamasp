import { Skeleton, SkeletonPage, SkeletonPageHeader } from "@/components/ui/skeleton";

/**
 * Markets: header, the provenance banner, then a stack of widget cards.
 *
 * The blocks are sized to the real widget heights in
 * components/tradingview-embed.tsx so the page does not jump when the cards
 * land — which matters more here than elsewhere, because the widgets
 * themselves arrive seconds later still and the skeleton is what stands in
 * for the layout in between.
 */
export default function Loading() {
  return (
    <SkeletonPage label="Markets">
      <SkeletonPageHeader />
      <Skeleton className="mb-4 h-24 w-full rounded-lg" />
      <div className="space-y-4">
        {[560, 420, 440, 480, 480, 460].map((h, i) => (
          <section key={i} className="rounded-lg border border-border p-3 lg:p-4">
            <Skeleton className="mb-2 h-3 w-48" />
            <Skeleton className="mb-3 h-3 w-full max-w-xl" />
            {/* Inline height rather than a Tailwind class: these come from
                the widget heights in components/tradingview-embed.tsx, and a
                JIT class built from a variable would not be generated. */}
            <div style={{ height: h }}>
              <Skeleton className="h-full w-full rounded-md" />
            </div>
          </section>
        ))}
      </div>
    </SkeletonPage>
  );
}
