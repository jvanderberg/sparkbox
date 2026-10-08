import { useEffect, useRef, useState } from "react";
import { completeOpenRouterLogin } from "./agent/openrouter-auth.ts";
import type { PreviewController } from "./agent/preview-controller.ts";
import { AgentRunner } from "./agent/runner.ts";
import { isSecretName } from "./agent/secrets.ts";
import { settings } from "./agent/settings.ts";
import { Field, Modal } from "./components.tsx";
import { type HostConfig, hostConfig, relayUrl } from "./config.ts";
import { GitHubConnect } from "./GitHubConnect.tsx";
import { GitHubOpen } from "./GitHubOpen.tsx";
import { githubAccount, useGitHubAccount } from "./github/account.ts";
import type { Repository } from "./github/api.ts";
import { completeGitHubLogin } from "./github/auth.ts";
import { Loading } from "./Loading.tsx";
import { defaultPreviewOrigin, previewPort, usePreview } from "./Preview.tsx";
import { queryPreview } from "./preview-bridge.ts";
import { deleteSnapshot, listSnapshots, saveBaseline, saveSnapshot } from "./sandbox/storage.ts";
import { type SandboxProgress, WasmerSandbox } from "./sandbox/wasmer.ts";
import { starterTemplate } from "./template.ts";
import { Workspace } from "./Workspace.tsx";
import type { FileMap } from "./workspace/changes.ts";
import "./app.css";

type Project = { id: string; name: string };

const projectsKey = "sparkbox:projects";

function loadProjects(): Project[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(projectsKey) ?? "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
function storeProjects(projects: Project[]) {
  localStorage.setItem(projectsKey, JSON.stringify(projects));
}
function projectId(name: string) {
  return `${name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")}-${crypto.randomUUID().slice(0, 6)}`;
}

export function App() {
  const [projects, setProjects] = useState<Project[]>(loadProjects);
  const [open, setOpen] = useState<Project | null>(() => {
    const id = new URLSearchParams(location.hash.slice(1)).get("project");
    return loadProjects().find((project) => project.id === id) ?? null;
  });
  const [notice, setNotice] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [wisp, setWisp] = useState(settings.wispUrl());
  const [previewOrigin, setPreviewOrigin] = useState(
    settings.previewOrigin() || defaultPreviewOrigin(),
  );
  const [newName, setNewName] = useState("");
  const [host, setHost] = useState<HostConfig | null>(null);
  useEffect(() => {
    void hostConfig().then(setHost);
  }, []);
  const account = useGitHubAccount();
  const [connecting, setConnecting] = useState(false);
  const [opening, setOpening] = useState(false);
  // The open project's repository link, re-read when Settings opens.
  const [link, setLink] = useState(() => (open ? settings.githubLink(open.id) : null));
  // Project secrets edited in Settings; the open session re-reads them on save.
  const [secretRows, setSecretRows] = useState<{ id: number; name: string; value: string }[]>([]);
  const nextRowId = useRef(1);
  const [secrets, setSecrets] = useState<Record<string, string>>(() =>
    open ? settings.secrets(open.id) : {},
  );
  const [secretsError, setSecretsError] = useState("");
  useEffect(() => {
    if (!settingsOpen) return;
    setSecretsError("");
    setLink(open ? settings.githubLink(open.id) : null);
    setSecretRows(
      open
        ? Object.entries(settings.secrets(open.id)).map(([name, value]) => ({
            id: nextRowId.current++,
            name,
            value,
          }))
        : [],
    );
  }, [settingsOpen, open]);

  useEffect(() => {
    void completeOpenRouterLogin()
      .then((key) => {
        if (key) {
          settings.setKey("openrouter", key);
          settings.setProvider("openrouter");
          setNotice("OpenRouter is connected.");
        }
      })
      .catch((error: Error) => setNotice(error.message));
    // GitHub sends the user back here with a code to exchange: in the popup
    // (which stores the token for the opening tab and closes) or in this tab.
    void completeGitHubLogin()
      .then(async (result) => {
        if (!result) return;
        const login = await githubAccount.connect(result.token);
        if (result.popup) {
          window.close();
          // Still here: the browser would not close the window for us.
          setNotice(`GitHub is connected as ${login}. You can close this window.`);
          return;
        }
        setNotice(`GitHub is connected as ${login}.`);
        const id = new URLSearchParams(location.hash.slice(1)).get("project");
        const project = loadProjects().find((entry) => entry.id === id);
        if (project) setOpen(project);
      })
      .catch((error: Error) => setNotice(error.message));
  }, []);

  useEffect(() => {
    // Recover projects whose files exist but whose name entry was lost.
    void listSnapshots().then((ids) => {
      const known = new Set(projects.map((project) => project.id));
      const missing = ids.filter((id) => !known.has(id));
      if (missing.length) {
        const next = [...projects, ...missing.map((id) => ({ id, name: id }))];
        setProjects(next);
        storeProjects(next);
      }
    });
  }, [projects]);

  useEffect(() => {
    location.hash = open ? `project=${encodeURIComponent(open.id)}` : "";
  }, [open]);

  function createProject() {
    const name = newName.trim();
    if (!name) return;
    const id = projectId(name);
    const next = [...projects, { id, name }];
    setProjects(next);
    storeProjects(next);
    setNewName("");
    setSecrets(settings.secrets(id));
    setOpen({ id, name });
  }

  /** A repository's files become a project that keeps backing up to it. */
  async function openRepository(repo: Repository, files: FileMap) {
    const id = projectId(repo.name);
    await saveSnapshot(id, files);
    await saveBaseline(id, files);
    settings.setGithubLink(id, { ...repo, auto: true, pushedAt: new Date().toISOString() });
    const next = [...projects, { id, name: repo.name }];
    setProjects(next);
    storeProjects(next);
    setOpening(false);
    setSecrets(settings.secrets(id));
    setOpen({ id, name: repo.name });
  }

  const githubModals = (
    <>
      {connecting && (
        <GitHubConnect
          clientId={host?.githubClientId ?? ""}
          reason="Projects live only in this browser, where storage can be cleared without warning. GitHub keeps a copy of each one and can publish it as a website."
          onConnected={(login) => {
            setConnecting(false);
            setNotice(`GitHub is connected as ${login}.`);
          }}
          onClose={() => setConnecting(false)}
        />
      )}
      {opening && <GitHubOpen onOpen={openRepository} onClose={() => setOpening(false)} />}
    </>
  );

  const settingsModal = settingsOpen && (
    <Modal title="Settings" onClose={() => setSettingsOpen(false)}>
      <form
        className="modal-body"
        onSubmit={(event) => {
          event.preventDefault();
          if (open) {
            const rows = secretRows
              .map((row) => ({ name: row.name.trim(), value: row.value }))
              .filter((row) => row.name || row.value);
            const invalid = rows.find((row) => !isSecretName(row.name));
            if (invalid) {
              setSecretsError(
                `"${invalid.name || "(empty)"}" is not a valid name: use letters, digits and underscores, like API_KEY.`,
              );
              return;
            }
            if (rows.some((row) => !row.value)) {
              setSecretsError("Every secret needs a value.");
              return;
            }
            const saved = Object.fromEntries(rows.map((r) => [r.name, r.value]));
            settings.setSecrets(open.id, saved);
            setSecrets(saved);
          }
          settings.setWispUrl(wisp);
          settings.setPreviewOrigin(previewOrigin);
          setSettingsOpen(false);
          setNotice(
            open
              ? "Settings saved. Secrets apply to new commands now; the preview origin and relay apply the next time a project is opened."
              : "Settings saved. They apply the next time a project is opened.",
          );
        }}
      >
        {open && (
          <fieldset className="secrets">
            <legend>Secrets for {open.name}</legend>
            <p className="muted">
              API keys and tokens the app needs. They stay in this browser, reach every command and
              the preview server as environment variables, can be written as {`$\{NAME}`} in
              download URLs, and are redacted from what the agent sees. Tell the agent the name,
              never the value.
            </p>
            {secretRows.map((row, index) => (
              <div className="secret-row" key={row.id}>
                <input
                  aria-label={`Secret ${index + 1} name`}
                  placeholder="VITE_API_KEY"
                  value={row.name}
                  onChange={(event) =>
                    setSecretRows((rows) =>
                      rows.map((r, i) => (i === index ? { ...r, name: event.target.value } : r)),
                    )
                  }
                />
                <input
                  aria-label={`Secret ${index + 1} value`}
                  type="password"
                  autoComplete="off"
                  placeholder="value"
                  value={row.value}
                  onChange={(event) =>
                    setSecretRows((rows) =>
                      rows.map((r, i) => (i === index ? { ...r, value: event.target.value } : r)),
                    )
                  }
                />
                <button
                  type="button"
                  className="button small"
                  aria-label={`Remove secret ${index + 1}`}
                  onClick={() => setSecretRows((rows) => rows.filter((_, i) => i !== index))}
                >
                  Remove
                </button>
              </div>
            ))}
            <button
              type="button"
              className="button small"
              onClick={() =>
                setSecretRows((rows) => [...rows, { id: nextRowId.current++, name: "", value: "" }])
              }
            >
              Add secret
            </button>
            {secretsError && (
              <p className="form-error" role="alert">
                {secretsError}
              </p>
            )}
          </fieldset>
        )}
        <fieldset className="secrets github-settings">
          <legend>GitHub</legend>
          {account ? (
            <p className="muted">
              Connected as <strong>{account.login}</strong>.{" "}
              <button
                type="button"
                className="link-button"
                onClick={() => {
                  githubAccount.disconnect();
                  setNotice("GitHub is disconnected from this browser.");
                }}
              >
                Sign out
              </button>
            </p>
          ) : (
            <p className="muted">
              Not connected.{" "}
              <button type="button" className="link-button" onClick={() => setConnecting(true)}>
                Connect GitHub
              </button>{" "}
              to back up and publish projects.
            </p>
          )}
          {open && link && (
            <>
              <p className="muted">
                This project backs up to{" "}
                <a href={link.htmlUrl} target="_blank" rel="noreferrer">
                  {link.owner}/{link.name}
                </a>
                {link.siteUrl && (
                  <>
                    {" "}
                    and is published at{" "}
                    <a href={link.siteUrl} target="_blank" rel="noreferrer">
                      {link.siteUrl}
                    </a>
                  </>
                )}
                .{" "}
                <button
                  type="button"
                  className="link-button"
                  onClick={() => {
                    settings.setGithubLink(open.id, null);
                    setLink(null);
                  }}
                >
                  Forget this repository
                </button>
              </p>
              <label className="checkbox-row">
                <input
                  type="checkbox"
                  checked={link.auto}
                  onChange={(event) => {
                    const next = { ...link, auto: event.target.checked };
                    settings.setGithubLink(open.id, next);
                    setLink(next);
                  }}
                />
                Back up after every agent turn
              </label>
            </>
          )}
        </fieldset>
        <Field label="Preview origin">
          <input
            value={previewOrigin}
            onChange={(event) => setPreviewOrigin(event.target.value)}
            placeholder="https://preview.example.com"
          />
        </Field>
        <p className="muted">
          The preview loads from a second origin that serves the Wasmer service worker. Locally,
          127.0.0.1 and localhost on the same port serve as two origins.
        </p>
        <Field label="Network relay (WISP URL)">
          <input
            value={wisp}
            onChange={(event) => setWisp(event.target.value)}
            placeholder="wss://relay.example.com/ (must end with a slash)"
          />
        </Field>
        <p className="muted">
          Optional. Without a relay the sandbox has no internet access, so package installs do not
          work. Model requests go straight from this page to the provider either way.
        </p>
        <div className="form-actions">
          <button type="submit" className="button primary">
            Save
          </button>
        </div>
      </form>
    </Modal>
  );

  if (open)
    return (
      <>
        <ProjectSession
          key={open.id}
          project={open}
          secrets={secrets}
          host={host}
          onClose={() => setOpen(null)}
          onSettings={() => setSettingsOpen(true)}
        />
        {settingsModal}
        {githubModals}
      </>
    );

  return (
    <main className="home">
      <header className="home-header">
        <div>
          <h1>Sparkbox</h1>
          <p>An AI coding agent, a Linux sandbox and a live preview, all in your browser.</p>
        </div>
        <button type="button" className="button" onClick={() => setSettingsOpen(true)}>
          Settings
        </button>
      </header>
      {notice && (
        <p className="home-notice" role="status">
          {notice}
        </p>
      )}
      <section className="home-card">
        <h2>Projects</h2>
        {projects.length === 0 && <p className="muted">No projects yet.</p>}
        <ul className="project-list">
          {projects.map((project) => (
            <li key={project.id}>
              <button
                type="button"
                className="project-open"
                onClick={() => {
                  setSecrets(settings.secrets(project.id));
                  setOpen(project);
                }}
              >
                {project.name}
              </button>
              <button
                type="button"
                className="button small"
                aria-label={`Delete ${project.name}`}
                onClick={() => {
                  if (!window.confirm(`Delete ${project.name} and its files from this browser?`))
                    return;
                  const next = projects.filter((entry) => entry.id !== project.id);
                  setProjects(next);
                  storeProjects(next);
                  void deleteSnapshot(project.id);
                  void deleteSnapshot(`${project.id}#baseline`);
                  settings.setGithubLink(project.id, null);
                }}
              >
                Delete
              </button>
            </li>
          ))}
        </ul>
        <form
          className="project-create"
          onSubmit={(event) => {
            event.preventDefault();
            createProject();
          }}
        >
          <input
            aria-label="New project name"
            placeholder="New project name"
            value={newName}
            onChange={(event) => setNewName(event.target.value)}
          />
          <button type="submit" className="button primary" disabled={!newName.trim()}>
            Create
          </button>
        </form>
      </section>
      <section className="home-card github-card">
        <h2>Back up and publish</h2>
        {account ? (
          <>
            <p>
              GitHub is connected as <strong>{account.login}</strong>. Each project has a Back up
              button that pushes it to a repository, and Publish puts it online with GitHub Pages.
            </p>
            <div className="button-row">
              <button type="button" className="button" onClick={() => setOpening(true)}>
                Open from GitHub
              </button>
            </div>
          </>
        ) : (
          <>
            <p>
              Projects live only in this browser, and browsers clear storage without warning.
              Connect a GitHub account to keep a copy of every project and to publish any of them as
              a website in one click. A free account is enough.
            </p>
            <div className="button-row">
              <button type="button" className="button primary" onClick={() => setConnecting(true)}>
                Connect GitHub
              </button>
              <a
                className="button"
                href="https://github.com/signup"
                target="_blank"
                rel="noreferrer"
              >
                Create a GitHub account
              </a>
            </div>
          </>
        )}
      </section>
      <section className="home-card">
        <h2>How it works</h2>
        <ul className="home-list">
          <li>
            Your files live in this browser. Nothing is sent to a Sparkbox server; there is none.
          </li>
          <li>
            Add an API key for Claude, OpenAI or OpenRouter in the Agent panel. Keys stay in this
            browser.
          </li>
          <li>
            The agent runs commands in a WebAssembly sandbox on this page. Preview serves the
            project from it.
          </li>
        </ul>
      </section>
      {settingsModal}
      {githubModals}
    </main>
  );
}

function ProjectSession({
  project,
  host,
  onClose,
  onSettings,
  secrets,
}: {
  project: Project;
  host: HostConfig | null;
  onClose: () => void;
  onSettings: () => void;
  secrets: Record<string, string>;
}) {
  const [sandbox, setSandbox] = useState<WasmerSandbox | null>(null);
  // Secrets reach every command and the preview server as environment variables.
  useEffect(() => {
    sandbox?.setEnvironment(secrets);
  }, [sandbox, secrets]);
  const [runner, setRunner] = useState<AgentRunner | null>(null);
  const [progress, setProgress] = useState<SandboxProgress>({ phase: "runtime" });
  const [error, setError] = useState("");
  const origin = settings.previewOrigin() || host?.previewOrigin || defaultPreviewOrigin();
  const preview = usePreview(sandbox, origin);
  const previewRef = useRef(preview);
  previewRef.current = preview;
  // The agent's preview tool. A stable object that always reaches the latest hook state.
  const [controller] = useState<PreviewController>(() => ({
    ensureRunning: () => previewRef.current.ensureRunning(),
    query: async (request) => queryPreview(await previewRef.current.ensureRunning(), request),
    recentErrors: () => previewRef.current.recentPageErrors(),
    logs: () => previewRef.current.recentLogs(),
    configure: (config) => previewRef.current.configure(config),
    status: () => ({
      config: previewRef.current.currentConfig(),
      running: previewRef.current.running,
      url: previewRef.current.url,
    }),
    restart: () => previewRef.current.restart(),
  }));
  useEffect(() => {
    // Exposed for browser checks; it is the same object the agent uses.
    const globals = window as unknown as {
      sparkboxPreviewTool?: unknown;
      sparkboxExec?: unknown;
      sparkboxWrite?: unknown;
      sparkboxSandbox?: unknown;
    };
    globals.sparkboxPreviewTool = (request: Parameters<PreviewController["query"]>[0]) =>
      controller.query(request);
    globals.sparkboxExec = (command: string) => sandbox?.exec(command, { timeoutMs: 180_000 });
    globals.sparkboxWrite = (path: string, content: string) => sandbox?.writeFile(path, content);
    globals.sparkboxSandbox = sandbox;
    return () => {
      globals.sparkboxPreviewTool = undefined;
      globals.sparkboxExec = undefined;
      globals.sparkboxWrite = undefined;
      globals.sparkboxSandbox = undefined;
    };
  }, [controller, sandbox]);

  useEffect(() => {
    if (!host) return;
    let active = true;
    let created: WasmerSandbox | null = null;
    // Outbound network: a relay the user configured, or the host's relay
    // through a short-lived ticket when this browser holds an invite token.
    const token = settings.key("sparkbox");
    const relay = settings.wispUrl()
      ? Promise.resolve(settings.wispUrl())
      : host.wispUrl && token
        ? relayUrl(token).catch((cause: Error) => {
            console.warn(`Network relay unavailable: ${cause.message}`);
            return "";
          })
        : Promise.resolve("");
    let wispUrl = "";
    relay
      .then((url) => {
        wispUrl = url;
        return WasmerSandbox.create({
          workspace: project.id,
          template: starterTemplate(project.name),
          wispUrl: wispUrl || undefined,
          onProgress: (value) => {
            if (active) setProgress(value);
          },
        });
      })
      .then((instance) => {
        if (!active) return void instance.close({ persist: false });
        created = instance;
        instance.setEnvironment(settings.secrets(project.id));
        setSandbox(instance);
        setRunner(
          new AgentRunner({
            workspace: project.id,
            sandbox: instance,
            networkEnabled: () => Boolean(wispUrl),
            fetchProxy: () => {
              const token = settings.key("sparkbox");
              return host.fetchUrl && token ? { url: host.fetchUrl, token } : undefined;
            },
            secrets: () => settings.secrets(project.id),
            previewPort,
            previewErrors: () => controller.recentErrors(),
            preview: controller,
          }),
        );
      })
      .catch((cause: Error) => {
        if (active) setError(cause.message);
      });
    // Nothing asynchronous runs once the page is hidden or unloading, so
    // the save is issued synchronously from the page's copy of the files.
    const persist = () => created?.persistNow();
    const hidden = () => {
      if (document.visibilityState === "hidden") persist();
    };
    window.addEventListener("pagehide", persist);
    document.addEventListener("visibilitychange", hidden);
    return () => {
      active = false;
      window.removeEventListener("pagehide", persist);
      document.removeEventListener("visibilitychange", hidden);
      void created?.close();
    };
  }, [project.id, project.name, controller, host]);

  if (!sandbox || !runner)
    return <Loading title={project.name} progress={progress} error={error} onBack={onClose} />;

  return (
    <Workspace
      name={project.name}
      sandbox={sandbox}
      runner={runner}
      preview={preview}
      githubClientId={host?.githubClientId ?? ""}
      onClose={onClose}
      onSettings={onSettings}
    />
  );
}
