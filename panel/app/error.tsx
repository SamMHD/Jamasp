"use client";
export default function Error({ error, reset }: { error: Error; reset: () => void }) {
  return (
    <div className="rounded border border-amber-900 bg-amber-950/50 p-4 text-sm text-amber-300">
      <p className="font-medium">Couldn&apos;t read Jamasp state</p>
      <p className="mt-1 text-amber-400/80">{error.message}</p>
      <button onClick={reset} className="mt-2 rounded border border-amber-700 px-2 py-1">
        retry
      </button>
    </div>
  );
}
