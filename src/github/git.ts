/**
 * Pure helpers around publishing: the secret scan a push runs first, how a
 * project becomes a site, and names for repositories and commits.
 */
import type { FileMap } from "../workspace/changes.ts";

const decoder = new TextDecoder();

function isText(data: Uint8Array) {
  const sample = data.subarray(0, 8000);
  for (const byte of sample) if (byte === 0) return false;
  return true;
}

/**
 * Project secrets must never leave this browser. Returns the files that
 * contain a secret's value, so the push can refuse and name them.
 */
export function filesHoldingSecrets(files: FileMap, secrets: Record<string, string>): string[] {
  const values = Object.values(secrets).filter((value) => value.length >= 8);
  if (!values.length) return [];
  const found: string[] = [];
  for (const [path, data] of Object.entries(files)) {
    if (!isText(data)) continue;
    const text = decoder.decode(data);
    if (values.some((value) => text.includes(value))) found.push(path);
  }
  return found.sort();
}

export type ProjectKind = "static" | "vite";

/**
 * How a project becomes a site. A Vite project is built by GitHub Actions
 * (the sandbox cannot run a production build); anything else is served as
 * it is from the main branch.
 */
export function projectKind(files: FileMap): ProjectKind {
  const manifest = files["package.json"];
  if (!manifest) return "static";
  try {
    const parsed = JSON.parse(decoder.decode(manifest)) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    if (parsed.dependencies?.vite || parsed.devDependencies?.vite) return "vite";
  } catch {
    // Not JSON: nothing to build with.
  }
  return "static";
}

export const workflowPath = ".github/workflows/pages.yml";

/** The Actions workflow that builds a Vite project and deploys it to Pages. */
export function pagesWorkflow(options: { pnpm: boolean }): string {
  const install = options.pnpm
    ? `      - run: npm install -g pnpm
      - run: pnpm install`
    : `      - run: npm install`;
  return `# Written by Sparkbox. Builds the app and publishes it to GitHub Pages on every push.
name: Publish to GitHub Pages
on:
  push:
    branches: [main]
  workflow_dispatch:
permissions:
  contents: read
  pages: write
  id-token: write
concurrency:
  group: pages
  cancel-in-progress: true
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
${install}
      - run: node node_modules/vite/bin/vite.js build --base=/\${{ github.event.repository.name }}/
      - uses: actions/upload-pages-artifact@v3
        with:
          path: dist
  deploy:
    needs: build
    runs-on: ubuntu-latest
    environment:
      name: github-pages
      url: \${{ steps.deployment.outputs.page_url }}
    steps:
      - id: deployment
        uses: actions/deploy-pages@v4
`;
}

/** A repository name GitHub accepts, from a project name. */
export function repositoryName(projectName: string): string {
  const slug = projectName
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 80);
  return slug || "sparkbox-project";
}

/** A commit message from the prompt that produced the changes. */
export function commitMessage(prompt: string): string {
  const line = prompt.trim().split("\n")[0]?.trim() ?? "";
  if (!line) return "Update from Sparkbox";
  return line.length > 72 ? `${line.slice(0, 71)}…` : line;
}
