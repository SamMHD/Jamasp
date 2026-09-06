import {
  Skeleton, SkeletonPage, SkeletonPanel, SkeletonPageHeader,
} from "@/components/ui/skeleton";

/**
 * Overview's loading fallback.
 *
 * This route is the reason the whole set exists. Overview is by far the
 * heaviest page in the panel — the largest RSC payload of any route — and
 * until this file landed it had no Suspense boundary, so the App Router had
 * nothing to prefetch for it and nothing to paint on click. Clicking
 * "Overview" from any sub-page left the *previous* page on screen for the
 * entire server round trip plus payload transfer, which on a weak
 * connection is tens of seconds of a UI that looks like it ignored the
 * click. (The round trip itself was also 9.1s until lib/db.ts's
 * getClusterHeads was fixed; see the comment there.)
 *
 * The shape mirrors app/page.tsx block for block — the two 2:1 treemaps, the
 * status strip, the technical panel, the 3/2 split below it — because the
 * fallback is prefetched and therefore free, and a fallback that lands in
 * the destination's real layout tells the reader the click worked *and*
 * where it is going. Keep it in step when the page's blocks change; a
 * skeleton that no longer matches is worse than none, because the layout
 * then jumps when the real content swaps in.
 */
export default function Loading() {
  return (
    <SkeletonPage label="Overview">
      {/* The ticker band, first and fixed-height. Its 48px is the same
          reservation the real strip makes (lib/tradingview.ts
          #TV_TICKER_TAPE_HEIGHT), so the page does not step down by a band's
          worth when the fallback swaps in. */}
      <Skeleton className="mb-4 h-12 w-full" />

      <SkeletonPageHeader />

      {/* Market map: heading row + window toggle, then the 2:1 treemap box.
          aspect-[2/1] rather than a fixed height, matching the 1200x600
          viewBox the real MarketMap preserves. */}
      <section className="mb-4">
        <div className="mb-2 flex items-center justify-between">
          <Skeleton className="h-4 w-28" />
          <div className="flex gap-1">
            <Skeleton className="h-6 w-12" />
            <Skeleton className="h-6 w-20" />
          </div>
        </div>
        <Skeleton className="aspect-[2/1] w-full" />
      </section>

      <section className="mb-4">
        <Skeleton className="mb-2 h-4 w-28" />
        <Skeleton className="aspect-[2/1] w-full" />
      </section>

      {/* Status strip: a row of small stat chips. */}
      <div className="flex flex-wrap gap-2">
        {Array.from({ length: 5 }, (_, i) => <Skeleton key={i} className="h-8 w-28" />)}
      </div>

      <SkeletonPanel className="mt-4" lines={6} />

      {/* Same grid as the page: 1 column below lg, 2/3 split above it.
          Left (narrow): horizon, news flow. Right (wide): drivers, forecast
          record — the Drivers card is the one that needs the width, because
          its column count is a container query. The stance panel is NOT here
          any more — it moved to the foot of the page, and so must its
          placeholder, or the loading state promises a layout the real page no
          longer has. */}
      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-5">
        <div className="flex flex-col gap-4 lg:col-span-2">
          <SkeletonPanel lines={3} />
          <SkeletonPanel lines={6} />
        </div>
        <div className="flex flex-col gap-4 lg:col-span-3">
          <SkeletonPanel lines={6} />
          <SkeletonPanel lines={5} />
        </div>
      </div>

      {/* Fundamental: full width, at the foot, the longest block on the page. */}
      <SkeletonPanel className="mt-4" lines={8} />

      <Skeleton className="mt-4 h-8 w-full" />
    </SkeletonPage>
  );
}
