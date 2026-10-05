// Adapted from T3 Code MessageCopyButton.tsx (MIT; see LICENSE.txt).
// Native clipboard and title replace T3's clipboard/toast and tooltip providers.
import { CheckIcon, CopyIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "./Button.tsx";

export function MessageCopyButton({
  text,
  label = "Copy message",
}: {
  text: string;
  label?: string;
}) {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  return (
    <Button
      type="button"
      size="icon-xs"
      variant="ghost"
      className="text-muted-foreground hover:text-foreground"
      aria-label={label}
      title={
        failed
          ? "Could not copy. Select the text to copy it."
          : copied
            ? "Copied"
            : "Copy to clipboard"
      }
      disabled={copied}
      onClick={() => {
        void navigator.clipboard
          .writeText(text)
          .then(() => {
            setCopied(true);
            setFailed(false);
            timer.current = setTimeout(() => setCopied(false), 2000);
          })
          .catch(() => setFailed(true));
      }}
    >
      {copied ? <CheckIcon className="size-3 text-primary" /> : <CopyIcon className="size-3" />}
      <span className="sr-only">
        {failed ? "Copy failed" : copied ? "Copied" : "Copy to clipboard"}
      </span>
    </Button>
  );
}
