/**
 * Boots the app in headless Chromium against the dev server, creates a
 * project, waits for the Wasmer sandbox, starts the preview and checks the
 * iframe, the editor and the Changes view. No model calls.
 *
 *   npm run dev    (in another terminal)
 *   npm run test:browser
 */
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, devices, type Page, type Route } from "playwright";
import { startGitServer } from "./git-http-server.ts";

const base = process.env.SPARKBOX_URL ?? "http://127.0.0.1:4320";
// SPARKBOX_RESOLVE="host IP" pins a hostname while its DNS record propagates.
const resolve = process.env.SPARKBOX_RESOLVE;
const launchArgs = resolve
  ? [`--host-resolver-rules=MAP ${resolve.split(" ")[0]} ${resolve.split(" ")[1]}`]
  : [];
mkdirSync("artifacts", { recursive: true });
// Pushes and clones go to a local git server standing in for github.com.
const gitServer = await startGitServer(mkdtempSync(join(tmpdir(), "sparkbox-git-")));

/**
 * Enough of GitHub's API, answered by Playwright, for Back up and Publish to
 * run end to end without a network. Records what was pushed.
 */
function fakeGitHub(page: Page) {
  const state = {
    repos: [] as string[],
    pages: null as null | { build_type: string },
    builds: 0,
  };
  const headers = {
    "content-type": "application/json",
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "*",
    "access-control-allow-methods": "*",
    "cross-origin-resource-policy": "cross-origin",
  };
  const head = (repo: string) => {
    try {
      return gitServer.git("ada", `${repo}.git`, ["rev-parse", "HEAD"]).trim();
    } catch {
      return "";
    }
  };
  const handler = async (route: Route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    if (method === "OPTIONS") return route.fulfill({ status: 204, headers });
    const json = (status: number, body: unknown) =>
      route.fulfill({ status, headers, body: JSON.stringify(body) });
    const body = request.postData() ? JSON.parse(request.postData() ?? "{}") : {};
    const path = url.pathname;
    const repoJson = (name: string) => ({
      owner: { login: "ada" },
      name,
      default_branch: "main",
      html_url: `https://github.com/ada/${name}`,
      description: "A smoke project",
      pushed_at: new Date().toISOString(),
      fork: false,
    });
    if (path === "/user") return json(200, { login: "ada" });
    if (path === "/user/repos" && method === "POST") {
      state.repos.push(body.name);
      return json(201, repoJson(body.name));
    }
    if (path === "/user/repos") return json(200, state.repos.map(repoJson));
    const repo = /^\/repos\/ada\/([^/]+)(.*)$/.exec(path);
    if (!repo) return json(404, { message: "Not Found" });
    const rest = repo[2] ?? "";
    const name = repo[1] ?? "";
    if (rest === "") return json(200, repoJson(name));
    if (rest === "/pages" && method === "POST") {
      state.pages = { build_type: body.build_type };
      return json(201, { html_url: `https://ada.github.io/${name}/` });
    }
    if (rest === "/pages/builds" && method === "POST") {
      state.builds++;
      return json(201, {});
    }
    if (rest === "/pages/builds/latest")
      return json(200, { status: "built", commit: head(name), error: { message: null } });
    if (rest === "/actions/runs") return json(200, { workflow_runs: [] });
    return json(404, { message: `no fake for ${method} ${path}` });
  };
  return {
    state,
    install: async () => {
      await page.route("https://api.github.com/**", handler);
      // The host's git relay, pointed at the local git server.
      await page.route("**/api/git/**", async (route) => {
        const target = new URL(route.request().url());
        target.protocol = "http:";
        target.host = `127.0.0.1:${gitServer.port}`;
        const response = await route.fetch({ url: target.href });
        await route.fulfill({ response });
      });
    },
  };
}

const smokeInvite = "smoke-invite";

/**
 * Make the host ask for an invite whether or not one is running, and answer
 * the invite and relay endpoints: the code is accepted, and the relay stays
 * off so the sandbox runs without a network as the rest of the smoke expects.
 */
async function requireInvite(page: Page) {
  await page.route("**/config.json", async (route) => {
    const response = await route.fetch().catch(() => null);
    const config = response?.ok() ? await response.json() : {};
    await route.fulfill({ json: { ...config, invites: true } });
  });
  await page.route("**/api/invite", async (route) => {
    const { code } = route.request().postDataJSON() as { code: string };
    if (code !== smokeInvite)
      return route.fulfill({ status: 403, json: { error: "That invite code is not valid." } });
    // The client reads only the expiry in the middle.
    await route.fulfill({ json: { token: `smoke.${Date.now() + 86_400_000}.signature` } });
  });
  await page.route("**/api/relay", (route) =>
    route.fulfill({ status: 503, json: { error: "The relay is not enabled." } }),
  );
}

async function run(label: string, options: { mobile?: boolean; dark?: boolean }) {
  const browser = await chromium.launch({ headless: true, args: launchArgs });
  const context = await browser.newContext({
    ...(options.mobile ? devices["Pixel 7"] : { viewport: { width: 1280, height: 800 } }),
    colorScheme: options.dark ? "dark" : "light",
  });
  // A GitHub sign-in that is already in this browser; the API is faked below.
  await context.addInitScript(() => {
    localStorage.setItem("sparkbox:github-token", "smoke-token");
    localStorage.setItem("sparkbox:github-login", "ada");
  });
  const page = await context.newPage();
  const github = fakeGitHub(page);
  await github.install();
  await requireInvite(page);
  const errors: string[] = [];
  page.on("console", (message) => {
    // The wrong invite code and the relay that stays off fail on purpose.
    if (/\/api\/(invite|relay)$/.test(message.location().url)) return;
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(base);
  const isolated = await page.evaluate(() => globalThis.crossOriginIsolated);
  if (!isolated) throw new Error("page is not cross-origin isolated");
  // A host that hands out invites asks for one before anything else.
  const inviteCode = page.getByLabel("Invite code", { exact: true });
  await inviteCode.fill("wrong-code");
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByText("That invite code is not valid.").waitFor({ timeout: 10_000 });
  await page.screenshot({ path: `artifacts/${label}-invite.png` });
  await inviteCode.fill(smokeInvite);
  await page.getByRole("button", { name: "Continue" }).click();
  console.log(`${label} invite gate passed`);
  // A first visit lands on "Create a project".
  await page.getByLabel("Project name", { exact: true }).fill(`Smoke ${label}`);
  await page.getByRole("button", { name: "Create a project" }).click();
  // The workspace appears once the sandbox, the agent and git are ready; the
  // header names the project that is open.
  const ready = (name = `Smoke ${label}`) =>
    page
      .locator(".workspace-header h1", { hasText: name })
      .waitFor({ state: "attached", timeout: 180_000 });
  await ready();
  const exec = (command: string) =>
    page.evaluate(
      (command) =>
        (
          window as unknown as {
            sparkboxExec: (
              c: string,
            ) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
          }
        ).sparkboxExec(command),
      command,
    );
  const write = (path: string, content: string) =>
    page.evaluate(
      ({ path, content }) =>
        (
          window as unknown as { sparkboxWrite: (p: string, c: string) => Promise<void> }
        ).sparkboxWrite(path, content),
      { path, content },
    );
  // Edits survive a reload that follows them at once: the last write and a
  // file created by a shell command are both back after the sandbox restarts.
  await write("kept.txt", "first");
  await exec("echo via-shell > shell.txt");
  await write("kept.txt", "second");
  await page.reload();
  await ready();
  const restored = await exec("cat kept.txt shell.txt");
  if (restored.stdout !== "secondvia-shell\n")
    throw new Error(`edits were lost over a reload: ${JSON.stringify(restored)}`);
  console.log(`${label} edits survive an immediate reload`);
  const tabs = page.locator("nav.workspace-tabs");
  if (!options.mobile) {
    // Project secrets: added in Settings, they reach commands as environment
    // variables as soon as they are saved.
    await page
      .locator(".workspace-header")
      .getByRole("button", { name: "Settings", exact: true })
      .click();
    await page.getByRole("button", { name: "Add secret" }).click();
    await page.getByLabel("Secret 1 name").fill("SMOKE_SECRET");
    await page.getByLabel("Secret 1 value").fill("smoke-secret-value");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await page.getByRole("button", { name: "Add secret" }).waitFor({ state: "detached" });
    const secret = await page.evaluate(() =>
      (
        window as unknown as { sparkboxExec: (c: string) => Promise<{ stdout: string }> }
      ).sparkboxExec("echo secret=$SMOKE_SECRET"),
    );
    if (!secret.stdout.includes("secret=smoke-secret-value"))
      throw new Error(`secret did not reach the command environment: ${secret.stdout}`);
    console.log(`${label} project secret reaches the environment`);
  }
  // A large photo-sized PNG attaches without a size complaint: it is downscaled.
  const bigImage = await page.evaluate(async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 4000;
    canvas.height = 3000;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("no canvas");
    const pixels = context.createImageData(4000, 3000);
    for (let i = 0; i < pixels.data.length; i++) pixels.data[i] = (Math.random() * 256) | 0;
    context.putImageData(pixels, 0, 0);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
    if (!blob) throw new Error("no blob");
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = "";
    for (let i = 0; i < bytes.length; i += 8192)
      binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
    return { base64: btoa(binary), size: bytes.length };
  });
  console.log(`${label} attaching a ${(bigImage.size / 1e6).toFixed(1)} MB PNG`);
  await page.getByLabel("Choose images").setInputFiles({
    name: "photo.png",
    mimeType: "image/png",
    buffer: Buffer.from(bigImage.base64, "base64"),
  });
  await page.getByRole("button", { name: /Remove photo\.png/ }).waitFor({ timeout: 60_000 });
  if (await page.locator(".chat-feedback.error").count())
    throw new Error(
      `attaching a large image showed an error: ${await page.locator(".chat-feedback.error").innerText()}`,
    );
  await page.getByRole("button", { name: /Remove photo\.png/ }).click();
  await page.screenshot({ path: `artifacts/smoke-${label}-agent.png` });
  // A new project is only PROJECT.md: the preview says so instead of serving a 404.
  await tabs.getByRole("button", { name: "Preview" }).click();
  await page.locator(".preview-panel").getByRole("button", { name: "Start preview" }).click();
  await page.getByRole("alert").filter({ hasText: "Nothing to preview yet" }).waitFor();
  console.log(`${label} empty project refuses to preview`);
  // The page an agent would have written: the rest of the smoke drives it.
  await write(
    "index.html",
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Smoke ${label}</title><link rel="stylesheet" href="./styles.css"></head><body><main><h1>Smoke ${label}</h1><button id="count" type="button">Clicked 0 times</button></main><script type="module" src="./app.js"></script></body></html>`,
  );
  await write(
    "styles.css",
    ":root{color-scheme:light dark;font-family:system-ui,sans-serif}body{margin:0;display:grid;place-items:center;min-height:100vh}",
  );
  await write(
    "app.js",
    `const button = document.querySelector("#count");
let clicks = 0;
button.addEventListener("click", () => {
  clicks += 1;
  button.textContent = \`Clicked \${clicks} times\`;
});
`,
  );
  // A project with dependencies but no node_modules: the preview installs
  // them itself when it can; without a network relay it says so and stops.
  await write(
    "package.json",
    JSON.stringify({ name: "smoke", dependencies: { "left-pad": "1.3.0" } }),
  );
  await page.locator(".preview-panel").getByRole("button", { name: "Start preview" }).click();
  await page
    .getByRole("alert")
    .filter({ hasText: "cannot be reinstalled here" })
    .waitFor({ timeout: 30_000 });
  await exec("rm package.json");
  console.log(`${label} missing node_modules without a relay is explained`);
  await tabs.getByRole("button", { name: "Files" }).click();
  // Phones start with the explorer collapsed to a rail.
  const expand = page.getByRole("button", { name: "Show file explorer" });
  if (await expand.isVisible()) await expand.click();
  await page.getByRole("treeitem", { name: /index\.html/ }).waitFor({ timeout: 20_000 });
  await page.screenshot({ path: `artifacts/smoke-${label}-files.png` });
  // The preview command backgrounds a second server, the shape of a Vite app
  // with an API: stopping the preview has to take that one down too.
  await write(
    "bg.js",
    'require("http").createServer((q, s) => s.end("bg")).listen(3999, "0.0.0.0");',
  );
  await write(
    "probe.mjs",
    `const net = await import("node:net");
const out = [];
for (const port of process.argv.slice(2).map(Number))
  out.push(port + "=" + await new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve("busy"));
    server.listen(port, "0.0.0.0", () => { server.close(); resolve("free"); });
  }));
console.log(out.join(" "));`,
  );
  await write(
    "sparkbox.json",
    JSON.stringify({
      preview: {
        command: "node bg.js & node .sparkbox/serve.mjs 8080 .",
        port: 8080,
        directory: ".",
      },
    }),
  );
  await tabs.getByRole("button", { name: "Preview" }).click();
  await page.locator(".preview-panel").getByRole("button", { name: "Start preview" }).click();
  const frame = page.locator("iframe.preview-frame");
  await frame.waitFor({ timeout: 180_000 });
  const content = frame.contentFrame();
  await content.getByRole("heading", { name: `Smoke ${label}` }).waitFor({ timeout: 60_000 });
  await content.getByRole("button", { name: /Clicked 0 times/ }).click();
  await content.getByRole("button", { name: /Clicked 1 times/ }).waitFor();
  // Cross-origin requests must leave the sandbox and reach the internet, and
  // the preview document must not be cross-origin isolated, or CDN scripts and
  // map tiles would be blocked.
  const innerFrame = await (await frame.elementHandle())?.contentFrame();
  if (!innerFrame) throw new Error("preview frame missing");
  const network = await innerFrame.evaluate(async () => {
    const results: Record<string, string> = {
      isolated: String(globalThis.crossOriginIsolated),
    };
    try {
      const response = await fetch("https://esm.sh/leaflet@1.9.4", { mode: "cors" });
      results.fetch = `${response.status} ${response.headers.get("content-type") ?? ""}`;
    } catch (error) {
      results.fetch = `error ${error instanceof Error ? error.message : String(error)}`;
    }
    try {
      const url = "https://esm.sh/leaflet@1.9.4";
      const module = (await import(url)) as { default?: { map?: unknown } };
      results.import = typeof module.default?.map === "function" ? "ok" : "no map()";
    } catch (error) {
      results.import = `error ${error instanceof Error ? error.message : String(error)}`;
    }
    results.script = await new Promise<string>((resolve) => {
      const script = document.createElement("script");
      script.src = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js";
      script.onload = () => resolve("ok");
      script.onerror = () => resolve("error");
      document.head.append(script);
    });
    return results;
  });
  console.log(`${label} preview network:`, JSON.stringify(network));
  if (
    network.isolated !== "false" ||
    !network.fetch?.startsWith("200") ||
    network.import !== "ok" ||
    network.script !== "ok"
  )
    throw new Error(`preview cannot reach CDNs: ${JSON.stringify(network)}`);
  // Page errors reach the Preview panel and the agent.
  await innerFrame.evaluate(() => {
    setTimeout(() => {
      throw new Error("smoke page error");
    }, 0);
  });
  const logs = page.getByRole("button", { name: /^Logs/ });
  await page.getByRole("button", { name: "Logs, 1 page error" }).waitFor({ timeout: 10_000 });
  // Full-screen preview hides the chrome and fills the window; Esc exits.
  const fullScreen = page.getByRole("button", { name: "Full screen" });
  if (await fullScreen.isVisible()) {
    await fullScreen.click();
    await page.getByRole("button", { name: "Exit full screen" }).waitFor();
    const frameBox = await frame.boundingBox();
    const viewport = page.viewportSize();
    if (
      !frameBox ||
      !viewport ||
      frameBox.width < viewport.width - 4 ||
      frameBox.height < viewport.height * 0.9
    )
      throw new Error(`full-screen preview does not fill the window: ${JSON.stringify(frameBox)}`);
    await page.screenshot({ path: `artifacts/smoke-${label}-preview-full.png` });
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Exit full screen" }).waitFor({ state: "detached" });
  }
  await page.screenshot({ path: `artifacts/smoke-${label}-preview.png` });
  await logs.click();
  await page.getByRole("log", { name: "Preview server logs" }).waitFor();
  await page.getByRole("button", { name: "Clear page errors" }).click();
  await page.getByRole("button", { name: "Close logs" }).click();
  // Live reload: a file written through the sandbox shows up in the frame on its own.
  await page.evaluate(
    ([title]) =>
      (
        window as unknown as { sparkboxWrite: (p: string, c: string) => Promise<void> }
      ).sparkboxWrite(
        "index.html",
        `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title><link rel="stylesheet" href="./styles.css"></head><body><main><h1>Reloaded ${title}</h1><button id="count" type="button">Clicked 0 times</button></main><script type="module" src="./app.js"></script></body></html>`,
      ),
    [`Smoke ${label}`],
  );
  await content
    .getByRole("heading", { name: `Reloaded Smoke ${label}` })
    .waitFor({ timeout: 15_000 });
  console.log(`${label} live reload ok`);
  // A stylesheet with a dark media rule, so the forced schemes can be checked on
  // the rendering rather than on the outline's label.
  await page.evaluate(() =>
    (window as unknown as { sparkboxWrite: (p: string, c: string) => Promise<void> }).sparkboxWrite(
      "styles.css",
      ":root{color-scheme:light dark}body{background:rgb(250,250,250)}@media (prefers-color-scheme: dark){body{background:rgb(17,19,24)}}",
    ),
  );
  await page.waitForTimeout(2000);
  // The agent's preview tool: a text outline, the error list and a phone screenshot
  // captured through hidden probe frames.
  const tool = await page.evaluate(async () => {
    const query = (
      window as unknown as {
        sparkboxPreviewTool: (request: {
          format: string;
          viewport?: string;
          scheme?: string;
        }) => Promise<unknown>;
      }
    ).sparkboxPreviewTool;
    const text = (await query({ format: "text", viewport: "phone", scheme: "dark" })) as {
      text: string;
    };
    const light = (await query({ format: "text", viewport: "phone", scheme: "light" })) as {
      text: string;
    };
    const errors = (await query({ format: "errors" })) as { errors: string[] };
    const shot = (await query({ format: "screenshot", viewport: "phone" })) as {
      image: string;
      width: number;
      height: number;
    };
    return {
      text: text.text.slice(0, 400),
      light: light.text.slice(0, 400),
      errors: errors.errors,
      width: shot.width,
      height: shot.height,
      bytes: shot.image.length,
    };
  });
  console.log(`${label} preview tool:`, JSON.stringify({ ...tool, text: tool.text.slice(0, 120) }));
  if (
    !tool.text.includes(`# Reloaded Smoke ${label}`) ||
    !tool.text.includes("[button] Clicked") ||
    !tool.text.includes("\nColor scheme: dark (forced)\nBackground: rgb(17, 19, 24)\n")
  )
    throw new Error(`preview text outline is wrong: ${tool.text}`);
  if (!tool.light.includes("\nColor scheme: light (forced)\nBackground: rgb(250, 250, 250)\n"))
    throw new Error(`forced light scheme did not apply: ${tool.light}`);
  if (tool.errors.length) throw new Error(`fresh load reported errors: ${tool.errors.join(", ")}`);
  if (tool.width !== 390 || tool.height !== 844 || tool.bytes < 2000)
    throw new Error(`screenshot is wrong: ${JSON.stringify(tool)}`);
  // The probe frames must not have added errors to the user's preview view.
  if ((await logs.getAttribute("aria-label")) !== "Logs")
    throw new Error("probe frames leaked page errors into the panel");
  const running = await exec("node probe.mjs 3999 8080");
  if (running.stdout.trim() !== "3999=busy 8080=busy")
    throw new Error(`preview servers are not listening: ${JSON.stringify(running)}`);
  // The preview's server actions sit in its toolbar's menu.
  await page.getByRole("button", { name: "More preview actions" }).click();
  await page.getByRole("button", { name: "Stop server" }).click();
  const stoppedAt = Date.now();
  let freed = "";
  while (Date.now() - stoppedAt < 60_000) {
    freed = (await exec("node probe.mjs 3999 8080")).stdout.trim();
    if (freed === "3999=free 8080=free") break;
    await page.waitForTimeout(500);
  }
  if (freed !== "3999=free 8080=free")
    throw new Error(`stopping the preview left a server running: ${freed}`);
  console.log(`${label} stopping the preview frees both ports (${Date.now() - stoppedAt} ms)`);
  await tabs.getByRole("button", { name: "Files" }).click();
  if (await expand.isVisible()) await expand.click();
  await page.getByRole("treeitem", { name: /app\.js/ }).click();
  await page.locator(".monaco-editor").first().waitFor({ timeout: 30_000 });
  await page.screenshot({ path: `artifacts/smoke-${label}-editor.png` });
  await tabs.getByRole("button", { name: "Changes" }).click();
  // The live-reload edit above is the one change since the saved version.
  await page
    .locator(".file-diff summary code", { hasText: "index.html" })
    .waitFor({ timeout: 20_000 });
  // Back up: one click creates the repository, commits everything and pushes
  // (through the git relay to the local git server); Changes is then clean.
  await page.getByRole("button", { name: "Back up to GitHub" }).click();
  await page.getByText(/Backed up to https:\/\/github\.com\/ada\//).waitFor({ timeout: 60_000 });
  await page.getByText("No changes since the last commit.").waitFor({ timeout: 20_000 });
  const repoName = github.state.repos[0] ?? "";
  if (!repoName) throw new Error("no repository was created");
  const pushed = gitServer
    .git("ada", `${repoName}.git`, ["ls-tree", "--name-only", "-r", "HEAD"])
    .split("\n")
    .filter(Boolean);
  for (const path of [
    "PROJECT.md",
    ".gitignore",
    "index.html",
    "app.js",
    "styles.css",
    "sparkbox.json",
  ])
    if (!pushed.includes(path)) throw new Error(`backup is missing ${path}: ${pushed.join(", ")}`);
  if (pushed.some((path) => path.startsWith(".sparkbox/") || path.startsWith("node_modules/")))
    throw new Error(`backup includes sandbox files: ${pushed.join(", ")}`);
  const history = gitServer.git("ada", `${repoName}.git`, ["log", "--oneline"]).trim().split("\n");
  if (history.length !== 2 || !history[1]?.includes("Start project"))
    throw new Error(`unexpected history on the remote: ${history.join(" | ")}`);
  console.log(`${label} backed up ${pushed.length} files to ada/${repoName}`);
  // The agent's git command runs in the sandbox and is answered by the page.
  const gitLog = await exec("git log --oneline -n 3");
  if (!gitLog.stdout.includes("Start project") || gitLog.exitCode !== 0)
    throw new Error(`git in the sandbox did not answer: ${JSON.stringify(gitLog)}`);
  const gitStatus = await exec(
    "echo // more >> app.js && git status --short && git diff --name-only",
  );
  if (!gitStatus.stdout.includes(" M app.js"))
    throw new Error(`git status missed an edit: ${JSON.stringify(gitStatus)}`);
  const gitCommit = await exec('git commit -am "Agent edit" && git push');
  if (!gitCommit.stdout.includes("[main ") || !gitCommit.stdout.includes("Pushed main to origin"))
    throw new Error(`git commit and push from the sandbox failed: ${JSON.stringify(gitCommit)}`);
  if (!gitServer.git("ada", `${repoName}.git`, ["log", "-1", "--format=%s"]).includes("Agent edit"))
    throw new Error("the agent's push did not reach the remote");
  console.log(`${label} git works from the sandbox`);
  // Publish: a static project gets Pages from the main branch and a .nojekyll.
  await page.getByRole("button", { name: "Publish", exact: true }).click();
  await page.getByText(/Published: https:\/\/ada\.github\.io\//).waitFor({ timeout: 60_000 });
  // Once published, the button opens a menu with the site and Republish.
  await page.locator(".workspace-header .header-menu > button").click();
  await page.getByRole("link", { name: "Open site" }).waitFor();
  if (github.state.pages?.build_type !== "legacy")
    throw new Error(
      `pages were not enabled from the branch: ${JSON.stringify(github.state.pages)}`,
    );
  const published = gitServer.git("ada", `${repoName}.git`, [
    "ls-tree",
    "--name-only",
    "-r",
    "HEAD",
  ]);
  if (!published.includes(".nojekyll")) throw new Error("publish did not add .nojekyll");
  await page.screenshot({ path: `artifacts/smoke-${label}-published.png` });
  console.log(`${label} published at a Pages URL`);
  if (!options.mobile) {
    await page.keyboard.press("Escape");
    // Open from GitHub, in the projects sidebar, clones the repository into a new project.
    await page.getByRole("button", { name: "Open from GitHub" }).click();
    await page.getByRole("button", { name: new RegExp(`^${repoName}`) }).click();
    await ready(repoName);
    const cloned = await exec("cat index.html && git log --oneline -n 1");
    if (
      !cloned.stdout.includes(`Smoke ${label}`) ||
      !cloned.stdout.includes("Publish to GitHub Pages")
    )
      throw new Error(`the clone is not the repository: ${JSON.stringify(cloned)}`);
    console.log(`${label} opened the repository from GitHub`);
    await page
      .getByRole("navigation", { name: "Projects" })
      .getByRole("button", { name: `Smoke ${label}`, exact: true })
      .click();
    await ready();
  }
  if (!options.mobile) {
    // A reloaded page must be able to expose the preview again. The preview
    // origin's service worker outlives the page and still holds the route the
    // old page registered; it has to notice that owner is gone rather than
    // refuse with "already exposes another guest server".
    await page.reload();
    await ready();
    await tabs.getByRole("button", { name: "Preview" }).click();
    await page.locator(".preview-panel").getByRole("button", { name: "Start preview" }).click();
    const alert = page.locator(".preview-error");
    await Promise.race([
      frame.waitFor({ timeout: 180_000 }),
      alert.waitFor({ timeout: 180_000 }).then(async () => {
        throw new Error(`preview after reload failed: ${await alert.textContent()}`);
      }),
    ]);
    await frame
      .contentFrame()
      .getByRole("heading", { name: `Smoke ${label}` })
      .waitFor({ timeout: 60_000 });
    console.log(`${label} preview survives a reload`);
  }
  await context.close();
  await browser.close();
  const real = errors.filter((text) => !/favicon|DevTools|smoke page error/.test(text));
  if (real.length) throw new Error(`console errors (${label}):\n${real.join("\n")}`);
  console.log(`ok ${label}`);
}

try {
  await run("desktop", {});
  await run("mobile", { mobile: true, dark: true });
} finally {
  gitServer.close();
}
