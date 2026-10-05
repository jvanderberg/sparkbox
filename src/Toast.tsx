import "./toast.css";
import { X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

type Notification = { id: number; message: string; kind: "success" | "error" };
export function useToast() {
  const [notification, setNotification] = useState<Notification | null>(null);
  const sequence = useRef(0);
  const dismiss = useCallback(() => setNotification(null), []);
  const notify = useCallback((message: string, kind: Notification["kind"] = "success") => {
    setNotification({ id: ++sequence.current, message, kind });
  }, []);
  return {
    notify,
    toast: notification ? (
      <Toast key={notification.id} notification={notification} onDismiss={dismiss} />
    ) : null,
  };
}
function Toast({ notification, onDismiss }: { notification: Notification; onDismiss: () => void }) {
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    if (hovered || focused) return;
    const timeout = setTimeout(onDismiss, notification.kind === "error" ? 12000 : 6000);
    return () => clearTimeout(timeout);
  }, [notification.kind, hovered, focused, onDismiss]);
  return createPortal(
    <section
      className={`workspace-toast toast-${notification.kind}`}
      aria-label="Notification"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false);
      }}
    >
      <p role={notification.kind === "error" ? "alert" : "status"} aria-atomic="true">
        {notification.message}
      </p>
      <button type="button" aria-label="Dismiss notification" onClick={onDismiss}>
        <X size={15} aria-hidden="true" />
      </button>
    </section>,
    document.body,
  );
}
