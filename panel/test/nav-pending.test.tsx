import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { Gauge } from "lucide-react";

const status = vi.hoisted(() => ({ pending: false }));
vi.mock("next/link", () => ({
  default: ({ children }: { children: React.ReactNode }) => <a>{children}</a>,
  useLinkStatus: () => status,
}));

const { NavItemBody, NavPendingDot } = await import("@/components/shell/nav-pending");

const render = (pending: boolean, node: React.ReactElement) => {
  status.pending = pending;
  return renderToStaticMarkup(node);
};

describe("NavItemBody", () => {
  it("renders the icon and label when idle", () => {
    const html = render(false, <NavItemBody icon={Gauge} label="Overview" />);
    expect(html).toContain("Overview");
    expect(html).toContain("<svg");
  });

  // The live region must be empty until a navigation is actually in flight,
  // or every nav render announces nine destinations at once.
  it("announces nothing while idle", () => {
    const html = render(false, <NavItemBody icon={Gauge} label="Overview" />);
    expect(html).not.toContain("Loading Overview");
  });

  it("names the destination it is loading", () => {
    const html = render(true, <NavItemBody icon={Gauge} label="Overview" />);
    expect(html).toContain("Loading Overview");
  });

  // The hint is delayed by CSS (`nav-hint-*` in app/globals.css), not by a
  // timer, so a transition that resolves inside 120ms never paints a
  // spinner. If the class stops being applied the delay silently stops
  // applying too and every fast click flashes.
  it("carries the delayed-hint classes when pending", () => {
    const html = render(true, <NavItemBody icon={Gauge} label="Overview" />);
    expect(html).toContain("nav-hint-in");
    expect(html).toContain("nav-hint-out");
    expect(html).toContain("nav-hint-label");
  });

  // Feedback is never colour alone: the spinner is a moving shape and the
  // label's colour change rides alongside it, not instead of it.
  it("shows a spinner, not just a colour change", () => {
    expect(render(true, <NavItemBody icon={Gauge} label="Overview" />))
      .toContain("animate-spin");
  });
});

describe("NavPendingDot", () => {
  // The dot's colour is ingest freshness. Tinting it for "loading" would
  // overload one indicator with two unrelated meanings, so the spinner
  // replaces it outright.
  it("shows the freshness dot while idle", () => {
    const html = render(false, <NavPendingDot className="bg-up rounded-full" />);
    expect(html).toContain("bg-up");
    expect(html).not.toContain("animate-spin");
  });

  it("replaces the dot with a spinner while pending", () => {
    const html = render(true, <NavPendingDot className="bg-up rounded-full" />);
    expect(html).not.toContain("bg-up");
    expect(html).toContain("animate-spin");
    expect(html).toContain("Loading Alerts");
  });
});
