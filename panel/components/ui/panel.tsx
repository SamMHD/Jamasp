import * as React from "react";
import { cn } from "@/lib/utils";

const TONE = {
  default: "border-border bg-card",
  warn: "border-primary/40 bg-primary/5",
  destructive: "border-destructive/50 bg-destructive/10",
} as const;

/**
 * The panel surface. Replaces sixteen hand-rolled
 * `rounded border border-border` divs and the single Card call site.
 *
 * `empty` replaces the body rather than sitting above it: a panel that shows
 * "no data yet" and a populated body at once is a contradiction, and every
 * existing empty state in this codebase is exclusive.
 *
 * `tone` sets role="status" so a state change is announced, but the caller
 * always supplies the words — the tone is never the only carrier of meaning.
 */
export function Panel({
  title, action, footer, tone = "default", empty, className, children, ...props
}: React.ComponentProps<"section"> & {
  title?: React.ReactNode;
  action?: React.ReactNode;
  footer?: React.ReactNode;
  tone?: keyof typeof TONE;
  empty?: React.ReactNode;
}) {
  return (
    <section
      role={tone === "default" ? undefined : "status"}
      className={cn("@container rounded-lg border p-3 lg:p-4", TONE[tone], className)}
      {...props}
    >
      {(title || action) && (
        <div className="mb-2 flex items-start justify-between gap-2">
          {title && (
            <h2 className="text-label uppercase text-ink-dim">{title}</h2>
          )}
          {action && <div className="shrink-0">{action}</div>}
        </div>
      )}
      {empty !== undefined
        ? <p className="text-body text-muted-foreground">{empty}</p>
        : children}
      {footer && <div className="mt-3 text-meta text-ink-dim">{footer}</div>}
    </section>
  );
}
