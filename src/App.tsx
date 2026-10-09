import { X } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { completeOpenRouterLogin } from "./agent/openrouter-auth.ts";
import type { PreviewController } from "./agent/preview-controller.ts";
import { AgentRunner } from "./agent/runner.ts";
import { isSecretName } from "./agent/secrets.ts";
import { settings } from "./agent/settings.ts";
import { Field, Modal } from "./components.tsx";
import { type HostConfig, hostConfig, relayUrl } from "./config.ts";
import { GitHubConnect } from "./GitHubConnect.tsx";
import { GitHubOpen } from "./GitHubOpen.tsx";
import { startGitBridge } from "./git/bridge.ts";
import { GitStore } from "./git/fs.ts";
import { Repository as Git } from "./git/repo.ts";
import { githubAccount, useGitHubAccount } from "./github/account.ts";
import type { Repository } from "./github/api.ts";
import { completeGitHubLogin } from "./github/auth.ts";
import { createGitHubController } from "./github/controller.ts";
import { cloneUrl } from "./github/sync.ts";
import { Landing } from "./Landing.tsx";
import { Loading } from "./Loading.tsx";
import { defaultPreviewOrigin, previewPort, usePreview } from "./Preview.tsx";
import { drawerQuery, type Project, ProjectSidebar, SidebarToggle } from "./ProjectSidebar.tsx";
import { queryPreview } from "./preview-bridge.ts";
import {
  deleteSnapshot,
  listSnapshots,
  loadGitStore,
  saveGitStore,
  saveSnapshotNow,
} from "./sandbox/storage.ts";
import { type SandboxProgress, WasmerSandbox } from "./sandbox/wasmer.ts";
import { useToast } from "./Toast.tsx";
import { starterTemplate } from "./template.ts";
import { Workspace } from "./Workspace.tsx";
import "./app.css";

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
    .replace(/^-|-$/g, "")}-${suffix()}`;
}
/** Six hex digits. Not randomUUID, which browsers withhold from plain-http pages. */
function suffix() {
  return [...crypto.getRandomValues(new Uint8Array(3))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
/** A name that is not taken yet: "Untitled project", then "Untitled project 2". */
function untitled(projects: Project[]) {
  const taken = new Set(projects.map((project) => project.name));
  let name = "Untitled project";
  for (let n = 2; taken.has(name); n++) name = `Untitled project ${n}`;
  return name;
}

const lastProjectKey = "sparkbox:last-project";
const sidebarKey = "sparkbox:sidebar";

/** Sessions still shutting down, so a delete or a reopen can wait for their last save. */
const closing = new Map<string, Promise<unknown>>();

/** The project in the address, else the one open last, else the newest. */
function initialProject(): Project | null {
  const projects = loadProjects();
  const id =
    new URLSearchParams(location.hash.slice(1)).get("project") ??
    localStorage.getItem(lastProjectKey);
  return projects.find((project) => project.id === id) ?? projects.at(-1) ?? null;
}

export function App() {
  const [projects, setProjects] = useState<Project[]>(loadProjects);
  const [open, setOpen] = useState<Project | null>(initialProject);
  const { notify, toast } = useToast();
  const [sidebarOpen, setSidebarOpen] = useState(
    () => !window.matchMedia(drawerQuery).matches && localStorage.getItem(sidebarKey) !== "closed",
  );
  // Unsaved editor text in the open project; leaving it asks first.
  const dirty = useRef(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [wisp, setWisp] = useState(settings.wispUrl());
  const [previewOrigin, setPreviewOrigin] = useState(
    settings.previewOrigin() || defaultPreviewOrigin(),
  );
  const [host, setHost] = useState<HostConfig | null>(null);
  useEffect(() => {
    void hostConfig().then(setHost);
  }, []);
  const account = useGitHubAccount();
  // Connecting GitHub on its own, or as the first step of opening a repository.
  const [connecting, setConnecting] = useState<null | "connect" | "open">(null);
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
          notify("OpenRouter is connected.");
        }
      })
      .catch((error: Error) => notify(error.message, "error"));
    // GitHub sends the user back here with a code to exchange: in the popup
    // (which stores the token for the opening tab and closes) or in this tab.
    void completeGitHubLogin()
      .then(async (result) => {
        if (!result) return;
        const login = await githubAccount.connect(result.token);
        if (result.popup) {
          window.close();
          // Still here: the browser would not close the window for us.
          notify(`GitHub is connected as ${login}. You can close this window.`);
          return;
        }
        notify(`GitHub is connected as ${login}.`);
        const id = new URLSearchParams(location.hash.slice(1)).get("project");
        const project = loadProjects().find((entry) => entry.id === id);
        if (project) setOpen(project);
      })
      .catch((error: Error) => notify(error.message, "error"));
  }, [notify]);

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
    if (open) localStorage.setItem(lastProjectKey, open.id);
  }, [open]);

  function toggleSidebar() {
    const next = !sidebarOpen;
    setSidebarOpen(next);
    if (!window.matchMedia(drawerQuery).matches)
      localStorage.setItem(sidebarKey, next ? "open" : "closed");
  }
  /** The drawer gets out of the way once the user has picked something. */
  function closeDrawer() {
    if (window.matchMedia(drawerQuery).matches) setSidebarOpen(false);
  }

  /** Switch to another project, or to the landing page. False when the user kept their edits. */
  function show(project: Project | null) {
    closeDrawer();
    if (project?.id === open?.id) return true;
    if (dirty.current && !window.confirm("Discard unsaved edits in the open file?")) return false;
    dirty.current = false;
    if (project) setSecrets(settings.secrets(project.id));
    setOpen(project);
    return true;
  }

  function addProject(project: Project) {
    setProjects((current) => {
      const next = [...current, project];
      storeProjects(next);
      return next;
    });
  }

  function createProject(input: string) {
    if (dirty.current && !window.confirm("Discard unsaved edits in the open file?")) return;
    dirty.current = false;
    const name = input || untitled(projects);
    const project = { id: projectId(name), name };
    addProject(project);
    show(project);
  }

  async function deleteProject(project: Project) {
    if (!window.confirm(`Delete ${project.name} and its files from this browser?`)) return;
    if (open?.id === project.id) {
      dirty.current = false;
      localStorage.removeItem(lastProjectKey);
      // Unmount now, so the session's closing save is registered before the files go.
      flushSync(() => setOpen(null));
      await new Promise((resolve) => setTimeout(resolve));
    }
    await closing.get(project.id)?.catch(() => {});
    await Promise.all([
      deleteSnapshot(project.id),
      deleteSnapshot(`${project.id}#baseline`),
      deleteSnapshot(`${project.id}#git`),
    ]).catch((error: Error) => notify(`Could not delete every file: ${error.message}`, "error"));
    settings.setGithubLink(project.id, null);
    settings.setPendingClone(project.id, null);
    setProjects((current) => {
      const next = current.filter((entry) => entry.id !== project.id);
      storeProjects(next);
      return next;
    });
  }

  /** A repository becomes a project that clones it on first open and keeps backing up to it. */
  async function openRepository(repo: Repository) {
    if (dirty.current && !window.confirm("Discard unsaved edits in the open file?")) return;
    dirty.current = false;
    const id = projectId(repo.name);
    settings.setPendingClone(id, cloneUrl(repo));
    settings.setGithubLink(id, { ...repo, auto: true, pushedAt: new Date().toISOString() });
    const project = { id, name: repo.name };
    addProject(project);
    setOpening(false);
    show(project);
  }

  function openFromGitHub() {
    closeDrawer();
    if (account) setOpening(true);
    else setConnecting("open");
  }

  const githubModals = (
    <>
      {connecting && (
        <GitHubConnect
          clientId={host?.githubClientId ?? ""}
          reason={
            connecting === "open"
              ? "Sign in to GitHub to choose one of your repositories."
              : "Projects live only in this browser, where storage can be cleared without warning. GitHub keeps a copy of each one and can publish it as a website."
          }
          onConnected={(login) => {
            const then = connecting;
            setConnecting(null);
            notify(`GitHub is connected as ${login}.`);
            if (then === "open") setOpening(true);
          }}
          onClose={() => setConnecting(null)}
        />
      )}
      {opening && (
        <GitHubOpen
          onOpen={openRepository}
          onConnect={() => {
            setOpening(false);
            setConnecting("open");
          }}
          onClose={() => setOpening(false)}
        />
      )}
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
          notify(
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
                  className="header-icon"
                  aria-label={`Remove secret ${index + 1}`}
                  title="Remove secret"
                  onClick={() => setSecretRows((rows) => rows.filter((_, i) => i !== index))}
                >
                  <X size={16} aria-hidden="true" />
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
                  notify("GitHub is disconnected from this browser.");
                }}
              >
                Sign out
              </button>
            </p>
          ) : (
            <>
              <p className="muted">
                Projects live only in this browser, and browsers clear storage without warning.
                GitHub keeps a copy of every project and publishes any of them as a website. A free
                account is enough.
              </p>
              <div className="button-row">
                <button
                  type="button"
                  className="button primary"
                  onClick={() => setConnecting("connect")}
                >
                  Connect GitHub
                </button>
                <a
                  className="button"
                  href="https://github.com/signup"
                  target="_blank"
                  rel="noreferrer"
                >
                  Create an account
                </a>
              </div>
            </>
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
        <details className="settings-about">
          <summary>How Sparkbox works</summary>
          <ul>
            <li>
              Your files live in this browser. Nothing is kept on a Sparkbox server; there is none.
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
        </details>
        <div className="form-actions">
          <button type="submit" className="button primary">
            Save
          </button>
        </div>
      </form>
    </Modal>
  );

  const menu = <SidebarToggle open={sidebarOpen} onToggle={toggleSidebar} />;
  return (
    <div className="app-frame" data-sidebar={sidebarOpen ? "open" : "closed"}>
      <ProjectSidebar
        projects={projects}
        current={open?.id ?? null}
        open={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
        onOpen={show}
        onCreate={createProject}
        onDelete={(project) => void deleteProject(project)}
        onOpenFromGitHub={openFromGitHub}
      />
      {open ? (
        <ProjectSession
          key={open.id}
          project={open}
          secrets={secrets}
          host={host}
          menu={menu}
          onClose={() => show(null)}
          onSettings={() => setSettingsOpen(true)}
          onDirtyChange={(value) => {
            dirty.current = value;
          }}
        />
      ) : (
        <Landing
          menu={menu}
          onSettings={() => setSettingsOpen(true)}
          onCreate={createProject}
          onOpenFromGitHub={openFromGitHub}
        />
      )}
      {settingsModal}
      {githubModals}
      {toast}
    </div>
  );
}

function ProjectSession({
  project,
  host,
  menu,
  onClose,
  onSettings,
  onDirtyChange,
  secrets,
}: {
  project: Project;
  host: HostConfig | null;
  menu: ReactNode;
  onClose: () => void;
  onSettings: () => void;
  onDirtyChange: (dirty: boolean) => void;
  secrets: Record<string, string>;
}) {
  const [sandbox, setSandbox] = useState<WasmerSandbox | null>(null);
  // Secrets reach every command and the preview server as environment variables.
  useEffect(() => {
    sandbox?.setEnvironment(secrets);
  }, [sandbox, secrets]);
  const [runner, setRunner] = useState<AgentRunner | null>(null);
  const [git, setGit] = useState<Git | null>(null);
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
    // A project opened from GitHub starts empty and is cloned on first boot.
    const pendingClone = settings.pendingClone(project.id);
    let repo: Git | null = null;
    let store: GitStore | null = null;
    let bridge: { stop: () => Promise<void> } | null = null;
    // The git objects are persisted whenever they changed; cheap when they did not.
    const persistGit = () => {
      if (!store?.dirty) return Promise.resolve();
      store.dirty = false;
      return saveGitStore(project.id, store.toRecord()).catch((error) =>
        console.warn("git store save failed", error),
      );
    };
    const gitTimer = setInterval(persistGit, 1500);
    // A session of this project that was just closed may still be saving.
    const previous = closing.get(project.id) ?? Promise.resolve();
    Promise.all([relay, previous])
      .then(([url]) => {
        wispUrl = url;
        return WasmerSandbox.create({
          workspace: project.id,
          template: pendingClone ? {} : starterTemplate(project.name),
          wispUrl: wispUrl || undefined,
          onProgress: (value) => {
            if (active) setProgress(value);
          },
        });
      })
      .then(async (instance) => {
        if (!active) return void instance.close({ persist: false });
        created = instance;
        instance.setEnvironment(settings.secrets(project.id));
        // The repository: restored from IndexedDB, cloned, or created with a first commit.
        store = new GitStore((await loadGitStore(project.id))?.files ?? {});
        const author = () => {
          const login = githubAccount.get()?.login;
          return login
            ? { name: login, email: `${login}@users.noreply.github.com` }
            : { name: "Sparkbox", email: "sparkbox@localhost" };
        };
        repo = new Git(instance, store, {
          author,
          proxyUrl: () => host.gitProxyUrl,
          token: () => githubAccount.get()?.token ?? "",
        });
        if (pendingClone && !repo.initialized()) {
          if (active) setProgress({ phase: "cloning" });
          await repo.clone(pendingClone);
          settings.setPendingClone(project.id, null);
          await instance.flush();
        } else {
          const fresh = await repo.ensure();
          if (fresh || !(await repo.head())) await repo.commitAll("Start project");
        }
        const link = settings.githubLink(project.id);
        if (link && (await repo.remote()) !== cloneUrl(link)) await repo.setRemote(cloneUrl(link));
        persistGit();
        if (!active) return;
        const current = repo;
        bridge = startGitBridge(instance, () => current);
        const github = createGitHubController({
          project: project.id,
          git: () => current,
          relayUrl: () => host.gitProxyUrl,
        });
        setGit(current);
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
            contextLimit: () => host.contextLimit,
            preview: controller,
            github: github.controller,
            githubState: github.state,
          }),
        );
      })
      .catch((cause: Error) => {
        if (active) setError(cause.message);
      });
    // Nothing asynchronous runs once the page is hidden or unloading, so
    // the save is issued synchronously from the page's copy of the files.
    const persist = () => {
      created?.persistNow();
      if (store?.dirty) {
        store.dirty = false;
        saveSnapshotNow(`${project.id}#git`, store.toRecord());
      }
    };
    const hidden = () => {
      if (document.visibilityState === "hidden") persist();
    };
    window.addEventListener("pagehide", persist);
    document.addEventListener("visibilitychange", hidden);
    return () => {
      active = false;
      clearInterval(gitTimer);
      window.removeEventListener("pagehide", persist);
      document.removeEventListener("visibilitychange", hidden);
      void bridge?.stop();
      const saved = Promise.all([persistGit(), created?.close()]);
      closing.set(project.id, saved);
      void saved.finally(() => {
        if (closing.get(project.id) === saved) closing.delete(project.id);
      });
    };
  }, [project.id, project.name, controller, host]);

  if (!sandbox || !runner || !git)
    return (
      <Loading
        title={project.name}
        menu={menu}
        progress={progress}
        error={error}
        onBack={onClose}
      />
    );

  return (
    <Workspace
      name={project.name}
      sandbox={sandbox}
      runner={runner}
      preview={preview}
      git={git}
      githubClientId={host?.githubClientId ?? ""}
      menu={menu}
      onSettings={onSettings}
      onDirtyChange={onDirtyChange}
    />
  );
}
