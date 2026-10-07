/**
 * Parent-side half of the preview bridge. Loads the served app in a hidden
 * iframe at a chosen viewport, asks the injected page script for a text
 * outline, the HTML, the error list or a screenshot, and tears the frame
 * down. Probe frames carry `#sparkbox-probe` so their error reports are not
 * mixed into the visible preview's.
 */
export type PreviewViewport = "phone" | "tablet" | "desktop";
export const previewViewports: Record<PreviewViewport, [number, number]> = {
  phone: [390, 844],
  tablet: [820, 1180],
  desktop: [1280, 800],
};

export type PreviewRequest = {
  format: "text" | "html" | "errors" | "screenshot";
  viewport?: PreviewViewport;
  /** Page path under the preview origin, default `/`. */
  path?: string;
  /** Force a color scheme in the probe frame; default is the system setting. */
  scheme?: "light" | "dark";
  limit?: number;
};

export type PreviewResult =
  | { format: "text"; text: string }
  | { format: "html"; html: string }
  | { format: "errors"; errors: string[] }
  | {
      format: "screenshot";
      image: string;
      mime: "image/jpeg";
      width: number;
      height: number;
      renderer: string;
      /** Images in the page and how many had loaded when the capture ran. */
      images: { total: number; loaded: number };
    };

export async function queryPreview(
  previewUrl: string,
  request: PreviewRequest,
  timeoutMs = request.format === "screenshot" ? 60_000 : 20_000,
): Promise<PreviewResult> {
  const [width, height] = previewViewports[request.viewport ?? "desktop"];
  const target = new URL(request.path ?? "/", previewUrl);
  target.hash = request.scheme ? `sparkbox-probe&scheme=${request.scheme}` : "sparkbox-probe";
  const frame = document.createElement("iframe");
  frame.setAttribute("aria-hidden", "true");
  frame.tabIndex = -1;
  // Kept inside the viewport, behind the app: Chrome stops requestAnimationFrame
  // in offscreen frames, which freezes fade-ins such as map tiles mid-way.
  frame.style.cssText = `position:fixed;left:0;top:0;width:${width}px;height:${height}px;border:0;z-index:-1;pointer-events:none;visibility:visible;`;
  frame.sandbox.add("allow-scripts", "allow-same-origin", "allow-forms");
  const origin = new URL(previewUrl).origin;
  const id = crypto.randomUUID();
  document.body.append(frame);
  try {
    return await new Promise<PreviewResult>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(
        () => finish(new Error(`The preview did not answer within ${timeoutMs / 1000}s.`)),
        timeoutMs,
      );
      const finish = (error: Error | null, result?: PreviewResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        window.removeEventListener("message", listener);
        if (error) reject(error);
        else if (result) resolve(result);
      };
      const listener = (event: MessageEvent) => {
        if (event.origin !== origin || event.source !== frame.contentWindow) return;
        const data = event.data as {
          type?: string;
          id?: string;
          result?: Record<string, unknown>;
          error?: string;
        } | null;
        if (!data) return;
        if (data.type === "sparkbox:page-ready") {
          // Give the page a moment to run its own scripts and layout.
          setTimeout(
            () => {
              frame.contentWindow?.postMessage(
                { type: "sparkbox:request", id, format: request.format, limit: request.limit },
                origin,
              );
            },
            request.format === "screenshot" ? 1500 : 500,
          );
          return;
        }
        if (data.type !== "sparkbox:response" || data.id !== id) return;
        if (data.error) return finish(new Error(data.error));
        const result = data.result ?? {};
        switch (request.format) {
          case "text":
            return finish(null, { format: "text", text: String(result.text ?? "") });
          case "html":
            return finish(null, { format: "html", html: String(result.html ?? "") });
          case "errors":
            return finish(null, {
              format: "errors",
              errors: Array.isArray(result.errors) ? result.errors.map(String) : [],
            });
          case "screenshot": {
            const image = String(result.image ?? "");
            if (!image.startsWith("data:image/jpeg;base64,"))
              return finish(new Error("The page did not return a screenshot."));
            return finish(null, {
              format: "screenshot",
              image: image.slice("data:image/jpeg;base64,".length),
              mime: "image/jpeg",
              width: Number(result.width ?? width),
              height: Number(result.height ?? height),
              renderer: String(result.renderer ?? "unknown"),
              images: {
                total: Number((result.images as { total?: number })?.total ?? 0),
                loaded: Number((result.images as { loaded?: number })?.loaded ?? 0),
              },
            });
          }
        }
      };
      window.addEventListener("message", listener);
      frame.addEventListener("error", () => finish(new Error("The preview page failed to load.")), {
        once: true,
      });
      frame.src = target.href;
    });
  } finally {
    frame.remove();
  }
}
