"use client";
export default function Error({ error, reset }: { error: Error; reset: () => void }) {
  return (
    <div className="rounded border border-primary/40 bg-primary/5 p-4 text-sm text-foreground">
      <p className="font-medium">Couldn&apos;t read Jamasp state</p>
      <p className="mt-1 text-muted-foreground">{error.message}</p>
      <button onClick={reset} className="mt-2 rounded border border-primary/40 px-2 py-1">
        retry
      </button>
    </div>
  );
}
