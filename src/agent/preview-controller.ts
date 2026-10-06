import type { PreviewRequest, PreviewResult } from "../preview-bridge.ts";

/** What the agent's preview tool can do; implemented by the workspace UI. */
export interface PreviewController {
  /** Start the preview server if needed and return its URL. */
  ensureRunning(): Promise<string>;
  query(request: PreviewRequest): Promise<PreviewResult>;
  /** Errors the visible preview reported since it was last started. */
  recentErrors(): string[];
}
