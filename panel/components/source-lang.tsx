import { t, type Messages } from "@/lib/i18n";

/**
 * Content shown in its English source because no translation exists yet.
 *
 * A quiet marker rather than a silent fallback: a translate job that dies
 * would otherwise look exactly like an English panel, and this is the
 * surface where somebody would notice. It is also why the skeleton option
 * was rejected — withholding a breaking headline for ten minutes to protect
 * a language rule is a bad trade on a trading panel.
 *
 * CONTENT ONLY. Chrome is hand-translated and complete by construction, so a
 * chrome string falling back to English is a dictionary bug, not a pending
 * translation, and must never wear a marker implying the job will fix it.
 *
 * `block`: the wrapped English text is inline (a headline, a title) far more
 * often than not, hence the `<span>` default — but a `<Markdown>` render is
 * a `<div class="prose">` containing `<p>`/`<ul>`/`<table>`, and `<span>` is
 * phrasing-only content, so wrapping one in a `<span>` is invalid nesting
 * (harmless in every browser today, but a fragile base for future styling
 * and a fail on any HTML validator). Pass `block` at a call site wrapping
 * `<Markdown>` to swap the wrapper to a `<div>` instead; the badge stays a
 * `<span>` regardless, since it never contains block content.
 */
export function SourceLang({ fallback, messages, children, block = false }: {
  fallback: boolean; messages: Messages; children: React.ReactNode; block?: boolean;
}) {
  if (!fallback) return <>{children}</>;
  const Wrapper = block ? "div" : "span";
  return (
    <>
      <Wrapper lang="en" dir="ltr">{children}</Wrapper>
      <span
        className="ms-1 align-middle rounded border border-border px-1 text-[0.65em]
                   leading-none text-muted-foreground"
        title={t(messages, "content.sourceEnglishTitle")}
      >
        {t(messages, "content.sourceEnglish")}
      </span>
    </>
  );
}
