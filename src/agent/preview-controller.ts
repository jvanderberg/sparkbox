import type { PreviewRequest, PreviewResult } from "../preview-bridge.ts";
import type { PreviewConfig } from "../preview-config.ts";

/** What the agent's preview tool can do; implemented by the workspace UI. */
export interface PreviewController {
  /** Start the preview server if needed and return its URL. */
  ensureRunning(): Promise<string>;
  query(request: PreviewRequest): Promise<PreviewResult>;
  /** Errors the visible preview reported since it was last started. */
  recentErrors(): string[];
  /** Output of the preview server process since it was started. */
  logs(): string;
  /** Change the preview command, port or directory; restarts if running. */
  configure(config: Partial<PreviewConfig>): Promise<PreviewConfig>;
  /** The current preview settings and whether the server is running. */
  status(): { config: PreviewConfig; running: boolean; url: string };
  restart(): Promise<string>;
}
