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
 */
export function SourceLang({ fallback, messages, children }: {
  fallback: boolean; messages: Messages; children: React.ReactNode;
}) {
  if (!fallback) return <>{children}</>;
  return (
    <>
      <span lang="en" dir="ltr">{children}</span>
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
