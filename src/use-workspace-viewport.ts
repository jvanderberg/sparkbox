import { useLayoutEffect, useState } from "react";

// Keyboard and browser chrome can pan the visual viewport without resizing the
// layout viewport. Follow both dimensions and offsets; never fight pinch zoom.
export function useWorkspaceViewport() {
  const [frame, setFrame] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => {
    if (!frame) return;
    const viewport = window.visualViewport;
    let scheduled = 0;
    const update = () => {
      scheduled = 0;
      if (viewport && viewport.scale !== 1) return;
      frame.style.setProperty("--workspace-height", `${viewport?.height ?? innerHeight}px`);
      frame.style.setProperty("--workspace-top", `${Math.max(0, viewport?.offsetTop ?? 0)}px`);
    };
    const schedule = () => {
      if (!scheduled) scheduled = requestAnimationFrame(update);
    };
    update();
    viewport?.addEventListener("resize", schedule);
    viewport?.addEventListener("scroll", schedule);
    window.addEventListener("resize", schedule);
    window.addEventListener("scroll", schedule);
    frame.addEventListener("focusin", schedule);
    frame.addEventListener("focusout", schedule);
    return () => {
      cancelAnimationFrame(scheduled);
      viewport?.removeEventListener("resize", schedule);
      viewport?.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      window.removeEventListener("scroll", schedule);
      frame.removeEventListener("focusin", schedule);
      frame.removeEventListener("focusout", schedule);
    };
  }, [frame]);
  return setFrame;
}
