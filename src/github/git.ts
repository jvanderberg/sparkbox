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

/**
 * Runs after the Pages build, from the repository root with SITE_BASE set to
 * the site's base path. The Vite dev server serves every file in the
 * project, but a build publishes only public/ and imported files, so a
 * fetch("data/x.json") works in the preview and 404s on the site. This finds
 * the quoted paths in the built pages and scripts that name a project file
 * the site lacks, or that start at the domain root instead of the base path.
 * Paths built at runtime are not seen. Kept free of backticks and dollar
 * braces so it can sit inside the workflow template.
 */
export const siteCheckScript = String.raw`
const fs = require("node:fs");
const path = require("node:path");
const base = process.env.SITE_BASE || "/";
const quoted = /["'\x60]([^"'\x60\s<>?#]+\.(?:json|geojson|topojson|csv|tsv|txt|xml|kml|gpx))["'\x60]/g;
const config = /^(package(-lock)?|sparkbox|tsconfig[\w.-]*)\.json$/;
const isFile = (file) => fs.statSync(file, { throwIfNoEntry: false })?.isFile() ?? false;
const built = fs
  .readdirSync("dist", { recursive: true, withFileTypes: true })
  .filter((entry) => entry.isFile() && /\.(m?js|html)$/.test(entry.name))
  .map((entry) => path.join(entry.parentPath, entry.name));
const problems = new Set();
for (const file of built) {
  for (const [, url] of fs.readFileSync(file, "utf8").matchAll(quoted)) {
    if (url.includes("://") || url.startsWith("//") || url.includes("..")) continue;
    const inBase = url.startsWith(base);
    const relative = (inBase ? url.slice(base.length) : url).replace(/^\.?\/+/, "");
    if (!relative || config.test(relative) || relative.startsWith("node_modules/")) continue;
    const inSite = isFile(path.join("dist", relative));
    if (!inSite && !isFile(relative)) continue;
    const fix = 'fetch it with import.meta.env.BASE_URL + "' + relative + '"';
    if (!inSite)
      problems.add(relative + " is fetched by the app but is not on the site: a Vite build publishes only public/ and imported files. Move it to public/" + relative + " and " + fix + ".");
    else if (url.startsWith("/") && !inBase)
      problems.add(url + " points at the domain root, outside the site at " + base + ": " + fix + ".");
  }
}
for (const problem of problems) console.error("::error::" + problem);
process.exit(problems.size ? 1 : 0);
`;

/** The Actions workflow that builds a Vite project and deploys it to Pages. */
export function pagesWorkflow(options: { pnpm: boolean }): string {
  // The sandbox installs with pnpm 10 and never runs build scripts (its
  // runtime cannot spawn them); the runner does the same, so the lockfile
  // and the policies match. Newer pnpm fails outright on esbuild's ignored
  // postinstall, and esbuild works without it through its platform package.
  const install = options.pnpm
    ? `      - run: npm install -g pnpm@10
      - run: pnpm install --ignore-scripts`
    : `      - run: npm install --ignore-scripts`;
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
      - name: Check that the files the app fetches were published
        env:
          SITE_BASE: /\${{ github.event.repository.name }}/
        run: |
          node - <<'SPARKBOX'
${indent(siteCheckScript.trim(), 10)}
          SPARKBOX
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

function indent(text: string, spaces: number) {
  const pad = " ".repeat(spaces);
  return text
    .split("\n")
    .map((line) => (line ? pad + line : line))
    .join("\n");
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
