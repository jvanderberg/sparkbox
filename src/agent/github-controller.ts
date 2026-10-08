/** What the agent's github tool can do; implemented by the workspace UI. */
export interface GitHubController {
  /** Connection, repository, site and last build, as text for the model. */
  status(): Promise<string>;
  /** The latest Actions runs with their outcome. */
  runs(): Promise<string>;
  /** The failing steps and log tail of a run (the latest failed one by default). */
  logs(run?: number): Promise<string>;
}

/** The lines the system prompt carries about GitHub, refreshed every turn. */
export type GitHubState = {
  connected: boolean;
  repository?: string;
  siteUrl?: string;
  /** The last publish or push outcome GitHub reported. */
  lastBuild?: { state: "building" | "live" | "failed"; detail?: string };
  /** Files changed since the last commit. */
  uncommitted?: number;
};
