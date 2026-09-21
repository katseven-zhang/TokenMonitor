import { memo, useEffect, useRef, useState, type ComponentPropsWithoutRef, type MouseEvent } from "react";
import { useTranslation } from "react-i18next";
import { writeClipboard } from "@/lib/clipboard";
import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import css from "highlight.js/lib/languages/css";
import diff from "highlight.js/lib/languages/diff";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import markdown from "highlight.js/lib/languages/markdown";
import python from "highlight.js/lib/languages/python";
import rust from "highlight.js/lib/languages/rust";
import sql from "highlight.js/lib/languages/sql";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";
import ReactMarkdown from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import "katex/dist/katex.min.css";

type MarkdownContentProps = {
  content: string;
};

const HIGHLIGHT_LANGUAGES = {
  bash,
  css,
  diff,
  javascript,
  json,
  markdown,
  python,
  rust,
  sql,
  typescript,
  xml,
  yaml,
};

const LANGUAGE_ALIASES: Record<string, keyof typeof HIGHLIGHT_LANGUAGES> = {
  html: "xml",
  js: "javascript",
  jsx: "javascript",
  md: "markdown",
  py: "python",
  rs: "rust",
  sh: "bash",
  shell: "bash",
  ts: "typescript",
  tsx: "typescript",
  yml: "yaml",
  zsh: "bash",
};

for (const [name, language] of Object.entries(HIGHLIGHT_LANGUAGES)) {
  hljs.registerLanguage(name, language);
}

function MarkdownCode({ className, children }: ComponentPropsWithoutRef<"code">) {
  const match = /language-([\w-]+)/.exec(className ?? "");
  if (!match) return <code className={className}>{children}</code>;

  const requestedLanguage = match[1].toLowerCase();
  const language = LANGUAGE_ALIASES[requestedLanguage] ?? requestedLanguage;
  if (!hljs.getLanguage(language)) return <code className={className}>{children}</code>;

  const code = String(children).replace(/\n$/, "");
  return (
    <code
      className={`${className ?? ""} hljs`}
      dangerouslySetInnerHTML={{ __html: hljs.highlight(code, { language }).value }}
    />
  );
}

function MarkdownContentComponent({ content }: MarkdownContentProps) {
  const { t } = useTranslation();
  const [feedback, setFeedback] = useState<{ text: string; failed: boolean } | null>(null);
  const feedbackTimer = useRef<number | null>(null);

  useEffect(() => () => {
    if (feedbackTimer.current !== null) window.clearTimeout(feedbackTimer.current);
  }, []);

  async function copyMarkdownLink(event: MouseEvent<HTMLAnchorElement>) {
    const href = event.currentTarget.href;
    if (!href) return;
    event.preventDefault();
    // Local-only product: display/copy URLs without navigating or making requests.
    const outcome = await writeClipboard(href);
    setFeedback({
      text: outcome.ok ? t("sessions.detail.markdown_link_copied") : t("sessions.detail.markdown_copy_failed"),
      failed: !outcome.ok,
    });
    if (feedbackTimer.current !== null) window.clearTimeout(feedbackTimer.current);
    feedbackTimer.current = window.setTimeout(() => setFeedback(null), 1400);
  }

  return (
    <div className="session-markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[
          [rehypeKatex, { strict: false }],
        ]}
        components={{
          img: ({ alt }) => (
            <span className="text-muted-foreground">
              {t("sessions.detail.markdown_image", {
                alt: alt || t("sessions.detail.markdown_image_without_alt"),
              })}
            </span>
          ),
          a: ({ children, ...props }: ComponentPropsWithoutRef<"a">) => (
            <a {...props} title={t("sessions.detail.markdown_link_title")} onClick={(event) => void copyMarkdownLink(event)}>
              {children}
            </a>
          ),
          table: ({ children, ...props }: ComponentPropsWithoutRef<"table">) => (
            <div className="session-markdown-table">
              <table {...props}>{children}</table>
            </div>
          ),
          code: MarkdownCode,
        }}
      >
        {content}
      </ReactMarkdown>
      {feedback ? (
        <span
          role={feedback.failed ? "alert" : "status"}
          className={feedback.failed ? "block text-xs text-error" : "block text-xs text-muted-foreground"}
        >
          {feedback.text}
        </span>
      ) : null}
    </div>
  );
}

export const MarkdownContent = memo(MarkdownContentComponent);
