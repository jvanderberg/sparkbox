// Extracted from T3 Code MessagesTimeline.tsx SimpleWorkEntryRow (MIT; see LICENSE.txt).
// Structured Civic Spark events are translated before this view; native button supplies keyboard behavior.
import { ChevronRightIcon } from "lucide-react";
import { type ReactNode, useState } from "react";
import { cn } from "./utils.ts";
import { observeVisibleAnimation } from "./visibleAnimation.ts";
export function SimpleWorkEntryRow({
  label,
  body,
  icon,
  failed,
  active = false,
}: {
  label: string;
  body: string;
  icon: ReactNode;
  failed: boolean;
  active?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div
      ref={active ? observeVisibleAnimation : undefined}
      data-active={active || undefined}
      className={cn(
        "chat-tool flex flex-col rounded-md px-0.5 py-0.5 transition-colors",
        expanded && "mb-1",
      )}
    >
      <button
        type="button"
        className="t3-tool-trigger flex w-full select-none items-center gap-1.5 rounded-md text-left hover:bg-accent/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70"
        aria-label={failed ? `${label}, tool call failed` : label}
        aria-expanded={expanded}
        onClick={() => setExpanded(!expanded)}
      >
        <span
          className={cn(
            "flex size-6 shrink-0 items-center justify-center",
            failed ? "text-destructive" : "text-icon-muted",
          )}
        >
          {icon}
        </span>
        <span
          className={cn(
            "min-w-0 flex-1 text-sm leading-relaxed text-secondary-label",
            active && !failed && "live-tool-shine",
            expanded ? "whitespace-pre-wrap break-words" : "truncate",
          )}
        >
          {label}
        </span>
        <span className="flex size-4 shrink-0 items-center justify-center" aria-hidden="true">
          <ChevronRightIcon
            className={cn(
              "size-3 shrink-0 text-icon-muted opacity-70 transition-transform duration-200",
              expanded && "rotate-90",
            )}
          />
        </span>
      </button>
      {expanded && body && (
        <div className="mt-1 ms-7 cursor-default rounded-md bg-muted/40 px-3 py-2">
          <pre className="max-h-64 cursor-text overflow-auto whitespace-pre-wrap break-words font-mono text-secondary-label text-[length:var(--font-size-code,0.6875rem)] leading-relaxed select-text">
            {body}
          </pre>
        </div>
      )}
    </div>
  );
}
