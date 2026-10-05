// Adapted from T3 Code MessagesTimeline.tsx WorkingTimelineRow, WorkingTimer,
// ThinkingTimelineRow and LiveActivityRow (MIT; see LICENSE.txt and README.md).
import { BrainIcon } from "lucide-react";
import { useEffect, useRef } from "react";
import { observeVisibleAnimation } from "./visibleAnimation.ts";

export function formatWorkingTime(startedAt: string, now = Date.now()): string {
  const seconds = Math.max(0, Math.floor((now - Date.parse(startedAt)) / 1000));
  if (!Number.isFinite(seconds)) return "0s";
  if (seconds < 60) return `${seconds}s`;
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return [hours && `${hours}h`, minutes && `${minutes}m`, seconds % 60 && `${seconds % 60}s`]
    .filter(Boolean)
    .join(" ");
}

function WorkingTimer({ startedAt }: { startedAt: string }) {
  const textRef = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const updateText = () => {
      if (textRef.current) textRef.current.textContent = formatWorkingTime(startedAt);
    };
    updateText();
    const id = setInterval(updateText, 1000);
    return () => clearInterval(id);
  }, [startedAt]);
  return (
    <span ref={textRef} className="tabular-nums">
      {formatWorkingTime(startedAt)}
    </span>
  );
}

export function WorkingIndicator({ startedAt }: { startedAt?: string }) {
  return (
    <div className="chat-working border-b border-border/60 pb-2 pt-1" aria-live="off">
      <div className="flex h-6 min-w-0 items-baseline px-1 text-sm leading-relaxed text-muted-foreground tabular-nums">
        <span className="relative shrink-0 overflow-hidden whitespace-nowrap transition-opacity duration-150 starting:opacity-0 motion-reduce:transition-none">
          {startedAt ? (
            <>
              Working for <WorkingTimer startedAt={startedAt} />
            </>
          ) : (
            "Working..."
          )}
        </span>
      </div>
    </div>
  );
}

function ThinkingContent({ highlighted = false }: { highlighted?: boolean }) {
  return (
    <span
      className={`flex min-h-6 min-w-0 items-center gap-1.5 py-0.5 px-0.5 ${highlighted ? "text-foreground" : "text-secondary-label"}`}
    >
      <span
        className={`flex size-6 shrink-0 items-center justify-center ${highlighted ? "text-foreground" : "text-icon-muted"}`}
      >
        <BrainIcon aria-hidden="true" className="block size-4 shrink-0 stroke-[1.8]" />
      </span>
      <span className="min-w-0 flex-1 truncate">Thinking</span>
    </span>
  );
}

export function ThinkingIndicator() {
  return (
    <div className="chat-thinking min-h-7" aria-hidden="true">
      <div
        ref={observeVisibleAnimation}
        className="relative min-h-6 w-fit max-w-full min-w-0 overflow-hidden rounded-md text-sm leading-relaxed"
      >
        <ThinkingContent />
        <span className="live-activity-focus pointer-events-none absolute inset-y-0 select-none">
          <span className="live-activity-focus-counter block">
            <span className="live-activity-focus-aligned block text-foreground">
              <ThinkingContent highlighted />
            </span>
          </span>
        </span>
      </div>
    </div>
  );
}
