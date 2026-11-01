"use client";
import { memo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

type Props = {
  content: string;
};

export const MarkdownViewer = memo(function MarkdownViewer({ content }: Props) {
  return (
    <div className="prompt-markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ node, ...props }) => <a target="_blank" rel="noopener noreferrer" {...props} />,
          code: ({ node, className, children, ...props }) => {
            const hasNewline = String(children).includes("\n");
            if (!className && !hasNewline) {
              return <code className="md-inline-code" {...props}>{children}</code>;
            }
            const match = /language-(\w+)/.exec(className || "");
            return (
              <div className="md-code-wrap">
                {match && <div className="md-code-head"><span className="md-code-lang">{match[1]}</span></div>}
                <pre className="md-code-block"><code className={className} {...props}>{children}</code></pre>
              </div>
            );
          },
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
});
