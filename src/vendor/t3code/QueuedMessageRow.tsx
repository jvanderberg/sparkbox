// Copied from T3 Code MessagesTimeline.tsx QueuedMessageTimelineRow, copyright
// (c) 2026 T3 Tools Inc. MIT; see LICENSE.txt. Native titles replace the
// tooltip provider, as elsewhere in this port.
import { ArrowUpIcon, ClockIcon, XIcon } from "lucide-react";
import type { QueuedPrompt } from "../../agents/protocol.ts";
import { Button } from "./Button.tsx";
import { cn } from "./utils.ts";

/** A message waiting for the running turn: a dashed user bubble with icon actions inside it. */
export function QueuedMessageRow({
  message,
  isNext,
  onSendNow,
  onCancel,
}: {
  message: QueuedPrompt;
  isNext: boolean;
  onSendNow: () => void;
  onCancel: () => void;
}) {
  const attachmentCount = message.images?.length ?? 0;
  const text = message.text.trim();
  const statusLabel = isNext
    ? "Sends after the next tool call or when the turn ends"
    : "Sends after the messages above it";
  return (
    <div className="flex flex-col items-end" data-queued-message-id={message.id}>
      <div className="max-w-[80%] rounded-2xl border border-dashed border-border p-3 text-message-foreground/80">
        {text.length > 0 ? (
          <div className="whitespace-pre-wrap break-words text-sm">{text}</div>
        ) : null}
        {attachmentCount > 0 ? (
          <div className={cn("text-secondary-label text-xs", text.length > 0 && "mt-1.5")}>
            {`${attachmentCount} attachment${attachmentCount === 1 ? "" : "s"}`}
          </div>
        ) : null}
        <div className="mt-2 flex items-center gap-4 text-secondary-label text-xs">
          <span className="inline-flex h-6 items-center gap-1" title={statusLabel}>
            <ClockIcon className="size-3.5" aria-hidden />
            {/* Upstream's tooltip label, read out instead of named on a span. */}
            Queued<span className="sr-only">{`. ${statusLabel}.`}</span>
          </span>
          <div className="ml-auto flex items-center gap-0.5">
            <Button
              type="button"
              size="icon-micro"
              variant="ghost-muted"
              className="size-6"
              onPointerDown={(event) => event.preventDefault()}
              onClick={onSendNow}
              aria-label="Send now"
              title="Send now"
            >
              <ArrowUpIcon className="size-3.5" aria-hidden />
            </Button>
            <Button
              type="button"
              size="icon-micro"
              variant="ghost-muted"
              className="size-6"
              onPointerDown={(event) => event.preventDefault()}
              onClick={onCancel}
              aria-label="Cancel and return to the composer"
              title="Cancel and return to the composer"
            >
              <XIcon className="size-3.5" aria-hidden />
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
