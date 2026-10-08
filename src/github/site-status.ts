/**
 * The last build outcome GitHub reported per project, shared between the
 * header (which watches builds) and the agent (whose prompt and github tool
 * read it).
 */
import type { SiteState } from "./sync.ts";

const states = new Map<string, SiteState>();

export const siteStatus = {
  get(project: string): SiteState | undefined {
    return states.get(project);
  },
  set(project: string, state: SiteState | null) {
    if (state) states.set(project, state);
    else states.delete(project);
  },
};
