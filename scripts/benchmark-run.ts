/**
 * Prompt benchmark: drive the in-page agent through the real UI on a long,
 * multi-turn build task and export everything needed to score the run.
 * Explicit opt-in only; it spends money on the OpenRouter key.
 *
 *   SPARKBOX_OPENROUTER_KEY=sk-or-… SPARKBOX_CTA_KEY=… SPARKBOX_INVITE=friends-2026 \
 *   SPARKBOX_RUN=2026-10-08-haiku npx tsx scripts/benchmark-run.ts
 *
 * Optional: SPARKBOX_MODEL (default anthropic/claude-haiku-5.5), SPARKBOX_BRIEF
 * (default scripts/benchmark-brief.md; "{{CTA_KEY}}" is replaced), SPARKBOX_MAX_TURNS
 * (default 4), SPARKBOX_TURN_TIMEOUT_MIN (default 50), SPARKBOX_URL.
 *
 * Needs `npm run dev` on 127.0.0.1:4320 and `npm run dev:server` for the relay.
 * Output goes to artifacts/benchmark/<run>/: transcript (JSON and Markdown),
 * project files, preview tool output and screenshots, and a summary. Keys are
 * redacted from everything written or printed.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { chromium } from "playwright";

const need = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`Set ${name}`);
  return value;
};
const openrouterKey = need("SPARKBOX_OPENROUTER_KEY").trim();
const ctaKey = need("SPARKBOX_CTA_KEY").trim();
const invite = need("SPARKBOX_INVITE");
const run = need("SPARKBOX_RUN");
const base = process.env.SPARKBOX_URL ?? "http://127.0.0.1:4320";
const model = process.env.SPARKBOX_MODEL ?? "anthropic/claude-haiku-5.5";
const maxTurns = Number(process.env.SPARKBOX_MAX_TURNS ?? 4);
const turnTimeoutMs = Number(process.env.SPARKBOX_TURN_TIMEOUT_MIN ?? 50) * 60_000;
const stallMs = Number(process.env.SPARKBOX_STALL_MIN ?? 10) * 60_000;
/** Driver interventions (stops, reloads) that the report must mention. */
const interventions: string[] = [];
const briefPath = process.env.SPARKBOX_BRIEF ?? "scripts/benchmark-brief.md";
const out = join("artifacts", "benchmark", run);
mkdirSync(out, { recursive: true });

const redact = (text: string) =>
  text.replaceAll(openrouterKey, "[openrouter-key]").replaceAll(ctaKey, "[cta-key]");
const save = (name: string, content: string | Buffer) => {
  const path = join(out, name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof content === "string" ? redact(content) : content);
};
const log = (...parts: unknown[]) =>
  console.log(new Date().toISOString().slice(11, 19), redact(parts.map(String).join(" ")));

const usage = async () => {
  const response = await fetch("https://openrouter.ai/api/v1/auth/key", {
    headers: { authorization: `Bearer ${openrouterKey}` },
  });
  const data = (await response.json()) as { data?: { usage?: number } };
  return data.data?.usage ?? Number.NaN;
};
const usageBefore = await usage();
log(`key usage before: $${usageBefore.toFixed(4)}`);

const token = await fetch(new URL("/api/invite", base), {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ code: invite }),
}).then(async (r) => {
  if (!r.ok) throw new Error(`invite failed: ${r.status}`);
  return ((await r.json()) as { token: string }).token;
});

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const consoleErrors: string[] = [];
page.on("console", (message) => {
  if (message.type() === "error") {
    const text = redact(message.text());
    consoleErrors.push(text);
    if (/wasmer|wisp|Atomics|scheduler|worker/i.test(text))
      log(`page console error: ${text.slice(0, 300)}`);
  }
});
page.on("pageerror", (error) => {
  consoleErrors.push(redact(error.message));
  log(`page error: ${redact(error.message).slice(0, 300)}`);
});

await page.goto(base);
await page.evaluate(
  (values: Record<string, string>) => {
    for (const [key, value] of Object.entries(values)) localStorage.setItem(key, value);
  },
  {
    "sparkbox:key:sparkbox": token,
    "sparkbox:key:openrouter": openrouterKey,
    "sparkbox:model:openrouter": model,
    "sparkbox:provider": "openrouter",
  },
);
await page.reload();
await page.getByLabel("New project name").fill("Oak Park Transit");
await page.getByRole("button", { name: "Create" }).click();
await page.getByText("Sandbox ready").waitFor({ state: "attached", timeout: 240_000 });
log("sandbox ready");

type Exec = (c: string) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
type Write = (p: string, c: string) => Promise<void>;
const rawExec = (c: string) =>
  page.evaluate((c) => (window as unknown as { sparkboxExec: Exec }).sparkboxExec(c), c);
const withTimeout = <T>(work: Promise<T>, ms: number, label: string) =>
  Promise.race([
    work,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} did not return within ${ms / 1000}s`)), ms),
    ),
  ]);
let reloads = 0;
/** The sandbox rebuilds from IndexedDB on reload; dependencies are not kept. */
async function reloadWorkspace(reason: string) {
  reloads += 1;
  log(`reloading the page: ${reason}`);
  // The app can keep loading sandbox assets for a while; do not wait for "load".
  await page.reload({ waitUntil: "domcontentloaded", timeout: 120_000 }).catch((error: Error) => {
    log(`reload did not settle: ${error.message.split("\n")[0]}`);
  });
  await page.getByText("Sandbox ready").waitFor({ state: "attached", timeout: 240_000 });
  await page.locator("nav.workspace-tabs").getByRole("button", { name: "Agent" }).click();
  await page.getByLabel("Message to agent").waitFor({ timeout: 30_000 });
  await installRpcTracer();
}
async function exec(c: string) {
  try {
    return await withTimeout(rawExec(c), 200_000, "sandbox command");
  } catch (error) {
    log(`exec failed: ${(error as Error).message}`);
    await reloadWorkspace("the sandbox stopped answering");
    return withTimeout(rawExec(c), 200_000, "sandbox command after reload");
  }
}
const write = (p: string, c: string) =>
  page.evaluate(
    (args: { p: string; c: string }) =>
      (window as unknown as { sparkboxWrite: Write }).sparkboxWrite(args.p, args.c),
    { p, c },
  );
const previewTool = (request: Record<string, unknown>) =>
  withTimeout(
    page.evaluate(
      (request) =>
        (
          window as unknown as {
            sparkboxPreviewTool: (r: unknown) => Promise<Record<string, unknown>>;
          }
        ).sparkboxPreviewTool(request),
      request,
    ),
    120_000,
    `preview ${String(request.format)}`,
  );

/**
 * Diagnostics for sandbox hangs: every guest network call is an RPC to the page
 * that blocks a runtime worker until answered. Wrap the SDK's handler to see
 * which calls stay unanswered.
 */
async function installRpcTracer() {
  await page.evaluate(() => {
    type Rpc = { method: string; args: string; at: number; control: Int32Array };
    const g = window as unknown as {
      __wasmerHandleNetworkRpc?: (value: unknown) => boolean;
      __rpcStats?: () => unknown;
      __rpcLog: Rpc[];
      __rpcTotal: number;
    };
    g.__rpcLog = [];
    g.__rpcTotal = 0;
    const original = g.__wasmerHandleNetworkRpc;
    g.__wasmerHandleNetworkRpc = (value: unknown) => {
      const request = value as {
        type?: string;
        method?: string;
        args?: unknown[];
        response?: SharedArrayBuffer;
      };
      if (request?.type === "wasmer-network-rpc" && request.response) {
        g.__rpcTotal += 1;
        g.__rpcLog.push({
          method: String(request.method),
          args: JSON.stringify(request.args ?? []).slice(0, 120),
          at: Date.now(),
          control: new Int32Array(request.response, 0, 4),
        });
        if (g.__rpcLog.length > 2000) g.__rpcLog.splice(0, 1000);
      }
      return original ? original(value) : false;
    };
    g.__rpcStats = () => {
      const now = Date.now();
      const pending = g.__rpcLog.filter((rpc) => Atomics.load(rpc.control, 0) === 0);
      return {
        total: g.__rpcTotal,
        pending: pending.length,
        stuck: pending
          .filter((rpc) => now - rpc.at > 10_000)
          .map((rpc) => `${rpc.method} ${rpc.args} (${Math.round((now - rpc.at) / 1000)}s)`)
          .slice(0, 12),
        wrapped: Boolean(original),
      };
    };
  });
}
const rpcStats = () =>
  withTimeout(
    page.evaluate(
      () => (window as unknown as { __rpcStats?: () => unknown }).__rpcStats?.() ?? null,
    ),
    10_000,
    "rpc stats",
  ).catch((e: Error) => ({ error: e.message }));
await installRpcTracer();
log(`rpc tracer: ${JSON.stringify(await rpcStats())}`);

const providerValue = await page.getByLabel("Agent provider").inputValue();
log(`provider select: ${providerValue}`);
if (providerValue !== "openrouter") {
  await page.getByLabel("Agent provider").selectOption("openrouter");
}
const networkCheck = await exec("pnpm view vite@7 version 2>&1 | tail -1");
log(`relay check (pnpm view): exit ${networkCheck.exitCode} ${networkCheck.stdout.trim()}`);

await write(
  "PROJECT.md",
  `# Oak Park Transit

A live transit dashboard and map for Oak Park, Illinois: CTA Green and Blue Line stations, CTA and Pace bus routes, and the Metra UP-West station, with arrivals.
`,
);

type AgentEvent = {
  type: string;
  id: string;
  text: string;
  details?: string;
  outcome?: string;
};
const readTranscript = () =>
  page.evaluate(
    () =>
      new Promise<AgentEvent[]>((resolve, reject) => {
        const request = indexedDB.open("sparkbox", 2);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result;
          const store = db.transaction("transcripts", "readonly").objectStore("transcripts");
          const all = store.getAll();
          all.onsuccess = () => resolve((all.result as AgentEvent[][]).flat());
          all.onerror = () => reject(all.error);
        };
      }),
  );

const brief = readFileSync(briefPath, "utf8").replaceAll("{{CTA_KEY}}", ctaKey);
const followUp =
  "Continue with the remaining requirements. Do not wait for my input; make reasonable decisions and report when everything is done or blocked.";

type TurnStats = {
  turn: number;
  minutes: number;
  toolCalls: number;
  toolErrors: number;
  byTool: Record<string, number>;
  outcome: string;
  lastText: string;
};
const stats: TurnStats[] = [];
let eventsSeen = 0;

async function sendTurn(turn: number, text: string) {
  const started = Date.now();
  await page.getByLabel("Message to agent").fill(text);
  await page.getByLabel("Message to agent").press("Enter");
  const stop = page.getByRole("button", { name: "Stop generation" });
  await stop.waitFor({ timeout: 60_000 });
  log(`turn ${turn} started`);
  // Progress while we wait: the number of tool rows and the latest status line.
  let lastReport = Date.now();
  let lastToolKey = "";
  let lastToolChange = Date.now();
  const stopTurn = async (why: string) => {
    log(`turn ${turn}: ${why}; stopping`);
    log(`rpc stats at stop: ${JSON.stringify(await rpcStats())}`);
    interventions.push(`turn ${turn}: ${why}`);
    await stop.click().catch(() => {});
    const detached = await stop
      .waitFor({ state: "detached", timeout: 90_000 })
      .then(() => true)
      .catch(() => false);
    if (!detached) await reloadWorkspace("Stop did not end the turn");
  };
  while (await stop.isVisible()) {
    if (Date.now() - started > turnTimeoutMs) {
      await stopTurn(`timeout after ${turnTimeoutMs / 60_000} min`);
      break;
    }
    if (Date.now() - lastToolChange > stallMs) {
      await stopTurn(`no tool progress for ${stallMs / 60_000} min (${lastToolKey.slice(0, 80)})`);
      break;
    }
    if (Date.now() - lastReport > 60_000) {
      lastReport = Date.now();
      const events = await readTranscript().catch(() => [] as AgentEvent[]);
      save("transcript.json", JSON.stringify(events, null, 2));
      const tools = events.filter((e) => e.type === "tool");
      const latest = tools.at(-1);
      const key = latest ? `${tools.length}:${latest.id}:${latest.details?.length ?? 0}` : "";
      if (key !== lastToolKey) {
        lastToolKey = key;
        lastToolChange = Date.now();
      }
      let latestName = "";
      try {
        const details = latest?.details ? JSON.parse(latest.details) : null;
        latestName = latest
          ? `${latest.text} ${JSON.stringify(details?.input ?? {}).slice(0, 120)}`
          : "";
      } catch {
        latestName = latest?.text ?? "";
      }
      const stats = (await rpcStats()) as {
        total?: number;
        pending?: number;
        stuck?: string[];
      } | null;
      log(
        `turn ${turn}: ${Math.round((Date.now() - started) / 60_000)} min, ${tools.length} tool events; rpc ${stats?.total ?? "?"}/${stats?.pending ?? "?"} pending${stats?.stuck?.length ? ` STUCK ${JSON.stringify(stats.stuck)}` : ""}; latest: ${latestName}`,
      );
    }
    await page.waitForTimeout(5_000);
  }
  await page.waitForTimeout(5_000);
  const events = await readTranscript();
  const fresh = events.slice(eventsSeen);
  eventsSeen = events.length;
  const tools = fresh.filter((e) => e.type === "tool");
  const byTool: Record<string, number> = {};
  let toolErrors = 0;
  for (const event of tools) {
    byTool[event.text] = (byTool[event.text] ?? 0) + 1;
    try {
      const details = JSON.parse(event.details ?? "{}");
      if (details.status === "error") toolErrors += 1;
    } catch {
      // ignore
    }
  }
  const done = fresh.filter((e) => e.type === "done").at(-1);
  const errors = fresh.filter((e) => e.type === "error");
  const lastText = fresh.filter((e) => e.type === "text").at(-1)?.text ?? "";
  const entry: TurnStats = {
    turn,
    minutes: Math.round(((Date.now() - started) / 60_000) * 10) / 10,
    toolCalls: tools.length,
    toolErrors,
    byTool,
    outcome:
      done?.outcome ??
      (errors.length ? `error: ${errors.map((e) => e.text).join("; ")}` : "unknown"),
    lastText,
  };
  stats.push(entry);
  log(`turn ${turn} finished: ${JSON.stringify({ ...entry, lastText: lastText.slice(0, 300) })}`);
  return entry;
}

async function checklist() {
  const result = await exec(
    [
      "for f in data/SOURCES.md README.md BUILD_LOG.md sparkbox.json package.json index.html; do",
      '  if [ -f "$f" ]; then echo "have $f"; else echo "missing $f"; fi;',
      "done",
    ].join("\n"),
  );
  return result.stdout;
}

const looksUnfinished = (text: string) =>
  /\?\s*$/.test(text.trim()) ||
  /\b(should I|would you like|let me know|do you want|shall I)\b/i.test(text.slice(-600));

let turn = 1;
let entry = await sendTurn(turn, brief);
while (turn < maxTurns) {
  const list = await checklist();
  log(`checklist after turn ${turn}:\n${list.trim()}`);
  const missing = list.includes("missing data/SOURCES.md") || list.includes("missing BUILD_LOG.md");
  const errored = entry.outcome.startsWith("error");
  if (!missing && !looksUnfinished(entry.lastText) && !errored && entry.outcome !== "stopped")
    break;
  turn += 1;
  entry = await sendTurn(turn, followUp);
}

// Export the transcript as JSON and readable Markdown.
const events = await readTranscript();
save("transcript.json", JSON.stringify(events, null, 2));
const lines: string[] = [];
for (const event of events) {
  if (event.type === "user") lines.push(`## User\n\n${event.text}\n`);
  else if (event.type === "text") lines.push(`## Assistant\n\n${event.text}\n`);
  else if (event.type === "tool") {
    let details: { status?: string; input?: unknown; output?: string } = {};
    try {
      details = JSON.parse(event.details ?? "{}");
    } catch {
      // ignore
    }
    const input = JSON.stringify(details.input ?? {});
    const output = (details.output ?? "").slice(0, 2500);
    lines.push(
      `### tool ${event.text} (${details.status ?? "?"})\n\n\`\`\`\n${input.slice(0, 2500)}\n\`\`\`\n\n\`\`\`\n${output}${(details.output ?? "").length > 2500 ? "\n…" : ""}\n\`\`\`\n`,
    );
  } else if (event.type === "done") lines.push(`_done: ${event.outcome}_\n`);
  else if (event.type === "error") lines.push(`_error: ${event.text}_\n`);
}
save("transcript.md", lines.join("\n"));
save("chat-dom.txt", await page.locator(".chat-thread").innerText());

// Preview: the agent's own tool, then a native capture of the preview frame.
const status = await previewTool({ format: "status" }).catch((e: Error) => ({ error: e.message }));
log(`preview status: ${JSON.stringify(status)}`);
const previewOut: Record<string, unknown> = { status };
for (const format of ["errors", "text"] as const) {
  for (const viewport of format === "text"
    ? (["phone", "desktop"] as const)
    : (["desktop"] as const)) {
    const result = await previewTool({ format, viewport }).catch((e: Error) => ({
      error: e.message,
    }));
    previewOut[`${format}-${viewport}`] = result;
  }
}
for (const viewport of ["phone", "desktop"] as const) {
  for (const scheme of ["light", "dark"] as const) {
    const result = (await previewTool({ format: "screenshot", viewport, scheme }).catch(
      (e: Error) => ({
        error: e.message,
      }),
    )) as { image?: string; mime?: string; error?: string; renderer?: string };
    if (result.image) {
      save(`${viewport}-${scheme}.jpg`, Buffer.from(result.image, "base64"));
      log(`screenshot ${viewport} ${scheme}: ${result.renderer}`);
    } else log(`screenshot ${viewport} ${scheme} failed: ${result.error}`);
  }
}
save("preview-tool.json", JSON.stringify(previewOut, null, 2));

const tabs = page.locator("nav.workspace-tabs");
await tabs.getByRole("button", { name: "Preview" }).click();
const frame = page.locator("iframe.preview-frame");
if (!(await frame.count()))
  await page
    .locator(".preview-panel")
    .getByRole("button", { name: "Preview" })
    .click()
    .catch(() => {});
await frame.waitFor({ timeout: 120_000 }).catch(() => log("no preview frame"));
await page.waitForTimeout(8_000);
await page.screenshot({ path: join(out, "workspace-preview.png") });
await frame
  .screenshot({ path: join(out, "native-preview-frame.png") })
  .catch((e: Error) => log(`native frame screenshot failed: ${e.message}`));
await tabs.getByRole("button", { name: "Agent" }).click();
await page.screenshot({ path: join(out, "workspace-chat.png"), fullPage: true });

// Export the project files (no dependencies or build output).
// GNU find is not in the sandbox; walk with Node and read the list from a file
// (Node output into a pipe is lost there).
const listing = await exec(
  `node -e '${[
    'const fs=require("fs"),p=require("path");',
    'const skip=new Set(["node_modules",".sparkbox","dist",".pnpm",".cache",".npm",".tmp-old"]);',
    "const out=[];",
    "(function walk(d){for(const e of fs.readdirSync(d,{withFileTypes:true})){",
    "if(skip.has(e.name))continue;const f=p.join(d,e.name);",
    'if(e.isDirectory())walk(f);else if(fs.statSync(f).size<524288&&!/\\.(png|jpe?g|zip)$/.test(f))out.push(f);}})(".");',
    'fs.writeFileSync("/workspace/.sparkbox-files.txt",out.sort().join("\\n"));',
  ].join("")}'; cat /workspace/.sparkbox-files.txt; rm -f /workspace/.sparkbox-files.txt`,
);
const files = listing.stdout.split("\n").filter(Boolean);
log(`exporting ${files.length} project files`);
for (const file of files) {
  const content = await exec(`cat '${file.replace(/'/g, "'\\''")}'`);
  save(join("project", file), content.stdout);
}
save("project-files.txt", files.join("\n"));
const installed = await exec(
  "ls node_modules 2>/dev/null | head -80; cat pnpm-lock.yaml 2>/dev/null | head -5",
);
save("node_modules.txt", installed.stdout);

const usageAfter = await usage();
const summary = {
  run,
  model,
  turns: stats,
  totalMinutes: stats.reduce((sum, s) => sum + s.minutes, 0),
  totalToolCalls: stats.reduce((sum, s) => sum + s.toolCalls, 0),
  totalToolErrors: stats.reduce((sum, s) => sum + s.toolErrors, 0),
  cost: Math.round((usageAfter - usageBefore) * 10000) / 10000,
  usageBefore,
  usageAfter,
  interventions,
  reloads,
  consoleErrors: consoleErrors.slice(0, 50),
  files,
};
save("summary.json", JSON.stringify(summary, null, 2));
log(
  `done. cost $${summary.cost} over ${summary.totalMinutes} min, ${summary.totalToolCalls} tool calls`,
);
await browser.close();
