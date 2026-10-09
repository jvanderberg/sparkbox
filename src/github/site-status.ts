/**
 * The last build outcome GitHub reported per project, shared between the
 * header (which watches builds) and the agent (whose prompt and github tool
 * read it).
 */
import type { SiteState } from "./sync.ts";

const states = new Map<string, SiteState>();
const backups = new Map<string, { ok: boolean; at: string; error?: string }>();

export const siteStatus = {
  get(project: string): SiteState | undefined {
    return states.get(project);
  },
  set(project: string, state: SiteState | null) {
    if (state) states.set(project, state);
    else states.delete(project);
  },
  /** The last automatic backup's outcome, for the agent. */
  lastBackup(project: string) {
    return backups.get(project);
  },
  recordBackup(project: string, result: { ok: boolean; error?: string }) {
    backups.set(project, { ...result, at: new Date().toISOString() });
  },
};
