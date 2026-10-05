import { Menu, X } from "lucide-react";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";

// Contents stay mounted. Opening a menu must not recreate a workspace or socket.
export function MobileMenu({
  label,
  children,
  closeOnNavigate = false,
}: {
  label: string;
  children: ReactNode;
  closeOnNavigate?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false);
    };
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        button.current?.focus();
      }
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", handleEscape);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", handleEscape);
    };
  }, [open]);
  return (
    <div className="mobile-menu" ref={root} data-open={open}>
      <button
        ref={button}
        type="button"
        className="button mobile-menu-toggle"
        aria-label={label}
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen(!open)}
      >
        {open ? <X size={18} /> : <Menu size={18} />} Menu
      </button>
      <div
        className="mobile-menu-content"
        id={id}
        onClickCapture={(event) => {
          if (
            closeOnNavigate &&
            event.target instanceof Element &&
            event.target.closest("nav button") &&
            !event.target.closest("nav button[aria-expanded]")
          ) {
            setOpen(false);
            if (button.current?.offsetParent) button.current.focus();
          }
        }}
      >
        {children}
      </div>
    </div>
  );
}
