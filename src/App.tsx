import { useEffect, useState } from "react";
import { completeOpenRouterLogin } from "./agent/openrouter-auth.ts";
import { AgentRunner } from "./agent/runner.ts";
import { settings } from "./agent/settings.ts";
import { Field, Modal } from "./components.tsx";
import { Loading } from "./Loading.tsx";
import { defaultPreviewOrigin, previewPort, usePreview } from "./Preview.tsx";
import { deleteSnapshot, listSnapshots } from "./sandbox/storage.ts";
import { type SandboxProgress, WasmerSandbox } from "./sandbox/wasmer.ts";
import { starterTemplate } from "./template.ts";
import { Workspace } from "./Workspace.tsx";
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
    const id = `${name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")}-${crypto.randomUUID().slice(0, 6)}`;
    const next = [...projects, { id, name }];
    setProjects(next);
    storeProjects(next);
    setNewName("");
    setOpen({ id, name });
  }

  const settingsModal = settingsOpen && (
    <Modal title="Settings" onClose={() => setSettingsOpen(false)}>
      <form
        className="modal-body"
        onSubmit={(event) => {
          event.preventDefault();
          settings.setWispUrl(wisp);
          settings.setPreviewOrigin(previewOrigin);
          setSettingsOpen(false);
          setNotice("Settings saved. They apply the next time a project is opened.");
        }}
      >
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
            placeholder="wss://relay.example.com/"
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
          onClose={() => setOpen(null)}
          onSettings={() => setSettingsOpen(true)}
        />
        {settingsModal}
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
              <button type="button" className="project-open" onClick={() => setOpen(project)}>
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
    </main>
  );
}

function ProjectSession({
  project,
  onClose,
  onSettings,
}: {
  project: Project;
  onClose: () => void;
  onSettings: () => void;
}) {
  const [sandbox, setSandbox] = useState<WasmerSandbox | null>(null);
  const [runner, setRunner] = useState<AgentRunner | null>(null);
  const [progress, setProgress] = useState<SandboxProgress>({ phase: "runtime" });
  const [error, setError] = useState("");
  const origin = settings.previewOrigin() || defaultPreviewOrigin();
  const preview = usePreview(sandbox, origin);

  useEffect(() => {
    let active = true;
    let created: WasmerSandbox | null = null;
    void WasmerSandbox.create({
      workspace: project.id,
      template: starterTemplate(project.name),
      wispUrl: settings.wispUrl() || undefined,
      onProgress: (value) => {
        if (active) setProgress(value);
      },
    })
      .then((instance) => {
        created = instance;
        if (!active) return void instance.close();
        setSandbox(instance);
        setRunner(
          new AgentRunner({
            workspace: project.id,
            sandbox: instance,
            networkEnabled: () => Boolean(settings.wispUrl()),
            previewPort,
          }),
        );
      })
      .catch((cause: Error) => {
        if (active) setError(cause.message);
      });
    const persist = () => void created?.persist();
    window.addEventListener("pagehide", persist);
    return () => {
      active = false;
      window.removeEventListener("pagehide", persist);
      void created?.close();
    };
  }, [project.id, project.name]);

  if (!sandbox || !runner)
    return <Loading title={project.name} progress={progress} error={error} onBack={onClose} />;

  return (
    <Workspace
      name={project.name}
      sandbox={sandbox}
      runner={runner}
      preview={preview}
      onClose={onClose}
      onSettings={onSettings}
    />
  );
}
