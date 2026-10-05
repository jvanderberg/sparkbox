// Extracted from T3 Code ChatMarkdown.tsx MarkdownCodeBlock (MIT; see LICENSE.txt).
// Native buttons/title replace application tooltip primitives; language title replaces Pierre icon lookup.
import { WrapTextIcon } from "lucide-react";
import { Children, isValidElement, type ReactNode, useState } from "react";
import { Button } from "./Button.tsx";
import { HighlightedCode } from "./HighlightedCode.tsx";
import { MessageCopyButton } from "./MessageCopyButton.tsx";
export function MarkdownCodeBlock({ children }: { children?: ReactNode }) {
  const [wrapped, setWrapped] = useState(false);
  const codeElement = Children.toArray(children).find(isValidElement);
  const props = codeElement?.props as { className?: string; children?: ReactNode } | undefined;
  const language = /language-([^ ]+)/.exec(props?.className ?? "")?.[1] ?? "text";
  const code = String(props?.children ?? "");
  const wrapLabel = wrapped ? "Disable line wrapping" : "Enable line wrapping";
  return (
    <div
      className="chat-markdown-codeblock my-[0.65rem] overflow-hidden rounded-[var(--radius)] border border-border/70 bg-secondary leading-snug"
      data-language={language}
      data-wrap={wrapped ? "true" : "false"}
    >
      <div className="chat-markdown-codeblock-header flex items-center justify-between gap-2 pt-1.5 pr-1.5 pb-0 pl-3 select-none">
        <span className="inline-flex min-w-0 items-center gap-[0.4rem] [font-family:var(--font-mono,ui-monospace,SFMono-Regular,monospace)] [font-size:0.6875rem]">
          {language}
        </span>
        <span className="flex items-center gap-0.5" role="toolbar" aria-label="Code block actions">
          <Button
            type="button"
            size="icon-xs"
            variant="ghost"
            className="chat-markdown-chrome-action"
            aria-pressed={wrapped}
            aria-label={wrapLabel}
            title={wrapLabel}
            onClick={() => setWrapped(!wrapped)}
          >
            <WrapTextIcon className="size-3" />
          </Button>
          <MessageCopyButton text={code} label="Copy code" />
        </span>
      </div>
      <HighlightedCode code={code} language={language} />
    </div>
  );
}
