import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

export function Markdown({ text }: { text: string }) {
  // dark:prose-invert, not a hardcoded invert: the light palette must stay
  // legible on the light surface (dark-only was invisible until a light
  // render existed to show it).
  return (
    <div className="prose prose-sm max-w-3xl dark:prose-invert">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
    </div>
  );
}
