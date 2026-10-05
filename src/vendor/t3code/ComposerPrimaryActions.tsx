// Adapted from T3 Code, copyright (c) 2026 T3 Tools Inc. MIT; see LICENSE.txt.
import { LoaderCircle as Spinner } from "lucide-react";
import { cn } from "./utils.ts";
export function ComposerPrimaryActions({
  isRunning,
  hasSendableContent,
  isConnecting,
  isSendBusy,
  isEnvironmentUnavailable,
  sendDisabledReason,
  onInterrupt,
}: {
  isRunning: boolean;
  hasSendableContent: boolean;
  isConnecting: boolean;
  isSendBusy: boolean;
  isEnvironmentUnavailable: boolean;
  sendDisabledReason: string | null;
  onInterrupt: () => void;
}) {
  const isSendDisabled = sendDisabledReason !== null;
  const renderStopGenerationButton = (insidePendingAction: boolean) => (
    <button
      type="button"
      className={cn(
        "flex cursor-pointer items-center justify-center rounded-full bg-destructive/90 text-white shadow-xs shadow-destructive/24 inset-shadow-[0_1px_--theme(--color-white/16%)] transition-all duration-150 hover:bg-destructive hover:scale-105 active:inset-shadow-[0_1px_--theme(--color-black/8%)] active:shadow-none",
        insidePendingAction
          ? "size-8 sm:size-7"
          : hasSendableContent
            ? "size-9 sm:size-8"
            : "size-8 sm:h-8 sm:w-8",
      )}
      onClick={onInterrupt}
      aria-label="Stop generation"
    >
      <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor" aria-hidden="true">
        <rect x="2" y="2" width="8" height="8" rx="1.5" />
      </svg>
    </button>
  );
  const sendButton = (
    <button
      type="submit"
      className={cn(
        "relative isolate flex h-9 w-9 items-center justify-center overflow-hidden rounded-full shadow-xs transition-all duration-150 enabled:cursor-pointer enabled:inset-shadow-[0_1px_--theme(--color-white/16%)] hover:scale-105 active:inset-shadow-[0_1px_--theme(--color-black/8%)] active:shadow-none disabled:pointer-events-none disabled:opacity-30 disabled:shadow-none disabled:hover:scale-100 sm:h-8 sm:w-8",
        "bg-message-action text-message-action-foreground enabled:shadow-message-action/24 hover:bg-message-action-hover",
      )}
      disabled={
        isSendBusy ||
        isSendDisabled ||
        isConnecting ||
        isEnvironmentUnavailable ||
        !hasSendableContent
      }
      aria-label={
        isEnvironmentUnavailable
          ? "Environment disconnected"
          : sendDisabledReason
            ? sendDisabledReason
            : isConnecting
              ? "Connecting"
              : isSendBusy
                ? "Sending"
                : isRunning
                  ? "Queue message"
                  : "Send message"
      }
    >
      {isConnecting || isSendBusy ? (
        <Spinner className="size-3.5" aria-hidden="true" />
      ) : (
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
          <path
            d="M7 11.5V2.5M7 2.5L3 6.5M7 2.5L11 6.5"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      )}
    </button>
  );

  if (!isRunning) {
    return sendButton;
  }

  // While a turn runs, a sendable draft queues for the next turn, so the send
  // button stays next to Stop on every viewport. The wrapper keeps the pair
  // together in Civic Spark's space-between footer.
  return (
    <div className="flex items-center justify-end gap-1.5">
      {renderStopGenerationButton(false)}
      {hasSendableContent ? sendButton : null}
    </div>
  );
}
