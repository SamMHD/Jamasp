import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { ItemRow } from "../lib/db";
import en from "../messages/en.json";
import fa from "../messages/fa.json";

const messages = { en: en as Record<string, string>, fa: fa as Record<string, string> };

/**
 * InboxTable fetches through useSWRInfinite, whose data arrives via an
 * effect — renderToStaticMarkup never runs effects, so an unmocked render
 * always sees `data: undefined` and an empty list, which would make every
 * assertion below trivially (and uselessly) pass. Mocking the hook itself,
 * the same way test/lang-toggle.test.tsx mocks @/lib/actions, is what lets
 * a single static render see real fetched rows.
 */
let mockData: { items: ItemRow[] }[] | undefined;
vi.mock("swr/infinite", () => ({
  default: () => ({
    data: mockData, error: undefined, mutate: vi.fn(), size: 1, setSize: vi.fn(),
  }),
}));

// InboxTable imports markInboxRead from here; the real module pulls in
// next/headers and next/cache (see lib/actions.ts's own "use server"), which
// have no request context under vitest. It is only ever called from the
// "Mark delta read" button's onClick, never during render, so a bare mock is
// enough — same precedent as test/lang-toggle.test.tsx.
vi.mock("@/lib/actions", () => ({ markInboxRead: vi.fn() }));

const { InboxTable, ItemHeadline, ItemLede } = await import("@/components/inbox-table");

function item(over: Partial<ItemRow> = {}): ItemRow {
  return {
    id: "i1", source: "reuters", published_at: "2026-08-10T08:00:00Z",
    headline: "Gold holds 4380", headline_fa: null, lede: null, lede_fa: null,
    fa_source: null, url: "https://example.test/i1", topic: "gold",
    cluster_id: "i1", fetched_at: "2026-08-10T08:05:00Z", read_at: null,
    ...over,
  };
}

function renderTable(items: ItemRow[], locale: "en" | "fa") {
  mockData = [{ items }];
  return renderToStaticMarkup(
    <InboxTable sources={[]} topics={[]} locale={locale} messages={messages[locale]} />);
}

describe("InboxTable list row", () => {
  it("renders the Persian headline when it exists, with no EN marker", () => {
    const html = renderTable(
      [item({ headline_fa: "طلا در ۴۳۸۰ ثابت ماند" })], "fa");
    expect(html).toContain("طلا در ۴۳۸۰ ثابت ماند");
    expect(html).not.toContain("Gold holds 4380");
    expect(html).not.toContain(messages.fa["content.sourceEnglish"]);
  });

  it("translates the unread badge, the filter bar and the mark-delta-read button", () => {
    const html = renderTable([item({ read_at: null })], "fa");
    expect(html).toContain(messages.fa["inboxTable.unreadBadge"]);
    expect(html).toContain(messages.fa["inboxTable.allSources"]);
    expect(html).toContain(messages.fa["inboxTable.allTopics"]);
    expect(html).toContain(messages.fa["inboxTable.unreadOnly"]);
    expect(html).toContain(messages.fa["inboxTable.markDeltaRead"]);
    expect(html).not.toContain(">unread<");
  });

  it("translates the empty-list state", () => {
    const html = renderTable([], "fa");
    expect(html).toContain(messages.fa["inboxTable.nothingHere"]);
  });

  it("falls back to the English headline with the EN marker when untranslated", () => {
    const html = renderTable([item({ headline_fa: null })], "fa");
    expect(html).toContain("Gold holds 4380");
    expect(html).toContain(messages.fa["content.sourceEnglish"]);
  });

  it("leaves the English-locale headline alone even when Persian exists", () => {
    const html = renderTable(
      [item({ headline_fa: "طلا در ۴۳۸۰ ثابت ماند" })], "en");
    expect(html).toContain("Gold holds 4380");
    expect(html).not.toContain("طلا در ۴۳۸۰ ثابت ماند");
    expect(html).not.toContain(messages.en["content.sourceEnglish"]);
  });

  it("renders the Persian lede when it exists, with no EN marker", () => {
    const html = renderTable([item({
      headline_fa: "طلا در ۴۳۸۰ ثابت ماند",
      lede: "Bullion steadied in Asian trade.", lede_fa: "شمش در معاملات آسيا آرام گرفت.",
    })], "fa");
    expect(html).toContain("شمش در معاملات آسيا آرام گرفت.");
    expect(html).not.toContain("Bullion steadied in Asian trade.");
    expect(html).not.toContain(messages.fa["content.sourceEnglish"]);
  });

  it("falls back to the English lede WITH the EN marker when untranslated", () => {
    const html = renderTable([item({
      headline_fa: "طلا در ۴۳۸۰ ثابت ماند",
      lede: "Bullion steadied in Asian trade.", lede_fa: null,
    })], "fa");
    expect(html).toContain("Bullion steadied in Asian trade.");
    // The headline is translated, so the only thing that can be wearing the
    // marker is the lede.
    expect(html).toContain(messages.fa["content.sourceEnglish"]);
  });
});

// The dialog title (components/inbox-table.tsx's DialogTitle) only mounts
// after a click sets selectedKey, and this project has no jsdom or
// @testing-library/react to drive that click and read the result back —
// see ItemHeadline's own doc comment. It renders through the identical
// ItemHeadline component the list row above already proved correct, so
// testing that component directly covers the dialog's call site: there is
// no separate localized()/SourceLang call left in the dialog to diverge.
describe("InboxTable dialog title (via the shared ItemHeadline)", () => {
  it("renders the Persian headline when it exists, with no EN marker", () => {
    const html = renderToStaticMarkup(
      <ItemHeadline item={item({ headline_fa: "طلا در ۴۳۸۰ ثابت ماند" })}
        locale="fa" messages={messages.fa} />);
    expect(html).toContain("طلا در ۴۳۸۰ ثابت ماند");
    expect(html).not.toContain("Gold holds 4380");
    expect(html).not.toContain(messages.fa["content.sourceEnglish"]);
  });

  it("falls back to the English headline with the EN marker when untranslated", () => {
    const html = renderToStaticMarkup(
      <ItemHeadline item={item({ headline_fa: null })} locale="fa" messages={messages.fa} />);
    expect(html).toContain("Gold holds 4380");
    expect(html).toContain(messages.fa["content.sourceEnglish"]);
  });

  it("leaves the English-locale headline alone even when Persian exists", () => {
    const html = renderToStaticMarkup(
      <ItemHeadline item={item({ headline_fa: "طلا در ۴۳۸۰ ثابت ماند" })}
        locale="en" messages={messages.en} />);
    expect(html).toContain("Gold holds 4380");
    expect(html).not.toContain("طلا در ۴۳۸۰ ثابت ماند");
    expect(html).not.toContain(messages.en["content.sourceEnglish"]);
  });
});

// The dialog's DialogDescription renders the lede through the same shared
// ItemLede the list row uses, for the same reason ItemHeadline is shared:
// one call site, two surfaces, nothing left to diverge. See ItemHeadline's
// doc comment for why the dialog cannot be driven directly here.
describe("InboxTable lede (via the shared ItemLede)", () => {
  it("renders the Persian lede when it exists, with no EN marker", () => {
    const html = renderToStaticMarkup(
      <ItemLede item={item({ lede: "Bullion steadied.", lede_fa: "شمش آرام گرفت." })}
        locale="fa" messages={messages.fa} />);
    expect(html).toContain("شمش آرام گرفت.");
    expect(html).not.toContain("Bullion steadied.");
    expect(html).not.toContain(messages.fa["content.sourceEnglish"]);
  });

  it("falls back to the English lede WITH the EN marker when untranslated", () => {
    const html = renderToStaticMarkup(
      <ItemLede item={item({ lede: "Bullion steadied.", lede_fa: null })}
        locale="fa" messages={messages.fa} />);
    expect(html).toContain("Bullion steadied.");
    expect(html).toContain(messages.fa["content.sourceEnglish"]);
  });

  it("renders nothing at all when the item has no lede in either language", () => {
    const html = renderToStaticMarkup(
      <ItemLede item={item({ lede: null, lede_fa: null })}
        locale="fa" messages={messages.fa} />);
    expect(html).toBe("");
  });

  it("leaves the English-locale lede alone even when Persian exists", () => {
    const html = renderToStaticMarkup(
      <ItemLede item={item({ lede: "Bullion steadied.", lede_fa: "شمش آرام گرفت." })}
        locale="en" messages={messages.en} />);
    expect(html).toContain("Bullion steadied.");
    expect(html).not.toContain("شمش آرام گرفت.");
    expect(html).not.toContain(messages.en["content.sourceEnglish"]);
  });
});
