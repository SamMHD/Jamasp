import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { cls } from "@/lib/format";

export function Markdown({ text, className }: { text: string; className?: string }) {
  // dark:prose-invert, not a hardcoded invert: the light palette must stay
  // legible on the light surface (dark-only was invisible until a light
  // render existed to show it).
  return (
    <div className={cls("prose prose-sm max-w-3xl dark:prose-invert", className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
    </div>
  );
}
