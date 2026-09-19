// Renders assistant markdown text with GitHub-flavored syntax support.
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

// Render the given markdown inside the shared styling wrapper.
export function Markdown({ text }: { text: string }) {
  return <div className="markdown"><ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown></div>;
}
