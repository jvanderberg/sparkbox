import { Download, FilePlus2, RefreshCw, Save, Trash2, Upload } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Agent } from "./Agent.tsx";
import type { AgentRunner } from "./agent/runner.ts";
import { Changes } from "./Changes.tsx";
import { CodeEditor } from "./CodeEditor.tsx";
import { Badge } from "./components.tsx";
import { FileExplorer } from "./FileExplorer.tsx";
import { MobileMenu } from "./MobileMenu.tsx";
import { PreviewControls, PreviewPanel, type usePreview } from "./Preview.tsx";
import { loadBaseline, saveBaseline } from "./sandbox/storage.ts";
import type { WasmerSandbox } from "./sandbox/wasmer.ts";
import { useWorkspaceViewport } from "./use-workspace-viewport.ts";
import { computeChanges, type FileMap } from "./workspace/changes.ts";
import { FILE_LIMIT, type Changes as WorkspaceChanges } from "./workspace/types.ts";

type WorkspaceView = "files" | "changes" | "agent" | "preview";
type FileContent = { path: string; content: string; revision: string };

const encoder = new TextEncoder();
const decoder = new TextDecoder();

async function revisionOf(data: Uint8Array) {
  const digest = await crypto.subtle.digest("SHA-256", data as BufferSource);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * The project workspace: files and editor, changes, agent chat and preview.
 * Civic Spark's layout and panels, with the sandbox in the page instead of a
 * Sprite behind an API.
 */
export function Workspace({
  name,
  sandbox,
  runner,
  preview,
  onClose,
  onSettings,
}: {
  name: string;
  sandbox: WasmerSandbox;
  runner: AgentRunner;
  preview: ReturnType<typeof usePreview>;
  onClose: () => void;
  onSettings: () => void;
}) {
  const workspace = sandbox.workspace;
  const [view, setView] = useState<WorkspaceView>(() => {
    try {
      const saved = localStorage.getItem(`sparkbox:workspace:${workspace}:tab`);
      if (saved && ["files", "changes", "agent", "preview"].includes(saved))
        return saved as WorkspaceView;
    } catch {
      // Preferences are optional.
    }
    return "agent";
  });
  useEffect(() => {
    try {
      localStorage.setItem(`sparkbox:workspace:${workspace}:tab`, view);
    } catch {
      // Preferences contain no files, messages, or credentials.
    }
  }, [workspace, view]);
  const screen = useWorkspaceViewport();
  const [agentWorking, setAgentWorking] = useState(false);
  const uploadInput = useRef<HTMLInputElement>(null);
  const [changes, setChanges] = useState<WorkspaceChanges | null>(null);
  const [changesError, setChangesError] = useState("");
  const [externalChange, setExternalChange] = useState(false);
  const [files, setFiles] = useState<string[]>([]);
  const [file, setFile] = useState<FileContent | null>(null);
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const dirty = file !== null && text !== file.content;
  const readOnly = loading;
  const current = useRef({ file, text });
  current.current = { file, text };
  const baseline = useRef<FileMap | null>(null);
  const openSequence = useRef(0);
  const refreshing = useRef<Promise<void> | null>(null);
  const refreshQueued = useRef(false);

  const readFile = useCallback(
    async (path: string): Promise<FileContent> => {
      const data = await sandbox.readFile(path);
      return { path, content: decoder.decode(data), revision: await revisionOf(data) };
    },
    [sandbox],
  );

  const refreshFiles = useCallback(async () => {
    if (refreshing.current) {
      refreshQueued.current = true;
      await refreshing.current;
      return;
    }
    const once = async () => {
      const sequence = openSequence.current;
      const paths = await sandbox.listFiles();
      setFiles(paths);
      try {
        if (!baseline.current) {
          const saved = await loadBaseline(workspace);
          baseline.current = saved?.files ?? (await sandbox.snapshot());
          if (!saved) await saveBaseline(workspace, baseline.current);
        }
        setChanges(computeChanges(baseline.current, await sandbox.snapshot()));
        setChangesError("");
      } catch (cause) {
        setChangesError(cause instanceof Error ? cause.message : "Could not compute changes.");
      }
      const snapshot = current.current;
      if (snapshot.file && paths.includes(snapshot.file.path)) {
        const next = await readFile(snapshot.file.path);
        if (openSequence.current !== sequence) return;
        if (current.current.file?.path !== snapshot.file.path) return;
        if (
          current.current.text !== snapshot.file.content ||
          current.current.file.revision !== snapshot.file.revision
        ) {
          setExternalChange(next.revision !== current.current.file.revision);
        } else {
          setFile(next);
          setText(next.content);
          setExternalChange(false);
        }
      } else if (snapshot.file) setExternalChange(true);
    };
    refreshing.current = (async () => {
      try {
        do {
          refreshQueued.current = false;
          await once();
        } while (refreshQueued.current);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Refresh failed");
      } finally {
        refreshing.current = null;
      }
    })();
    await refreshing.current;
  }, [sandbox, workspace, readFile]);

  // The sandbox reports every write, whether from the editor, the agent's
  // tools or a command. Coalesce bursts into one refresh.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const unsubscribe = sandbox.subscribe(() => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void refreshFiles(), 400);
    });
    return () => {
      unsubscribe();
      if (timer) clearTimeout(timer);
    };
  }, [sandbox, refreshFiles]);

  async function open(path: string) {
    if (dirty && !window.confirm("Discard unsaved edits and open another file?")) return false;
    const sequence = ++openSequence.current;
    setLoading(true);
    try {
      const next = await readFile(path);
      if (openSequence.current !== sequence) return false;
      setFile(next);
      setText(next.content);
      setExternalChange(false);
      setError("");
      setMessage("");
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      return false;
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    let active = true;
    setLoading(true);
    void (async () => {
      await refreshFiles();
      const paths = await sandbox.listFiles();
      const path = paths.includes("index.html") ? "index.html" : paths[0];
      if (path && active && !current.current.file) {
        const next = await readFile(path);
        if (active) {
          setFile(next);
          setText(next.content);
        }
      }
    })()
      .catch((cause: Error) => {
        if (active) setError(cause.message);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [sandbox, readFile, refreshFiles]);

  useEffect(() => {
    const listener = (event: BeforeUnloadEvent) => {
      if (dirty) event.preventDefault();
    };
    window.addEventListener("beforeunload", listener);
    return () => window.removeEventListener("beforeunload", listener);
  }, [dirty]);

  async function action(fn: () => Promise<void>) {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await fn();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Operation failed");
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    if (!file) return;
    // Compare revisions before writing so an agent edit is never overwritten silently.
    const latest = await readFile(file.path).catch(() => null);
    if (latest && latest.revision !== file.revision) {
      setExternalChange(true);
      throw new Error("This file changed outside the editor. Reload it before saving.");
    }
    const data = encoder.encode(text);
    await sandbox.writeFile(file.path, data);
    setFile({ path: file.path, content: text, revision: await revisionOf(data) });
    setMessage("Saved.");
    setExternalChange(false);
    await refreshFiles();
  }

  async function saveVersion(title: string) {
    const snapshot = await sandbox.snapshot();
    await saveBaseline(workspace, snapshot);
    baseline.current = snapshot;
    setMessage(`Saved version: ${title}`);
    await refreshFiles();
  }

  return (
    <main ref={screen} className="workspace-screen">
      <header className="workspace-header">
        <h1>{name}</h1>
        <MobileMenu label="Workspace controls">
          <button
            type="button"
            className="button small"
            onClick={() => {
              if (!dirty || window.confirm("Discard unsaved edits and close?")) onClose();
            }}
          >
            ← Projects
          </button>
          <span className="workspace-privacy">Runs in this browser</span>
          <Badge tone="green">Sandbox ready</Badge>
          <PreviewControls preview={preview} disabled={busy} onShow={() => setView("preview")} />
          <button type="button" className="button small" onClick={onSettings}>
            Settings
          </button>
        </MobileMenu>
      </header>
      <nav className="workspace-tabs" aria-label="Workspace views">
        {(
          [
            ["agent", "Agent"],
            ["preview", "Preview"],
            ["files", "Files"],
            ["changes", "Changes"],
          ] as const
        ).map(([id, label]) => (
          <button type="button" key={id} aria-pressed={view === id} onClick={() => setView(id)}>
            {label}
            {id === "changes" && changes?.files.length ? ` (${changes.files.length})` : ""}
          </button>
        ))}
      </nav>
      <section
        className="workspace-changes-view"
        aria-label="Changes view"
        // biome-ignore lint/a11y/noNoninteractiveTabindex: The scroll region must support keyboard PageDown/End navigation.
        tabIndex={0}
        hidden={view !== "changes"}
      >
        <Changes
          value={changes}
          refresh={() => void refreshFiles()}
          dirty={dirty}
          readOnly={readOnly || busy}
          onSaveVersion={saveVersion}
          error={changesError}
        />
      </section>
      <Agent
        runner={runner}
        visible={view === "agent"}
        dirty={dirty}
        onWorkingChange={setAgentWorking}
        onUpdated={() => void refreshFiles()}
        onReview={() => setView("changes")}
        onOpenFile={(path) => {
          setView("files");
          void open(path);
        }}
      />
      <PreviewPanel preview={preview} visible={view === "preview"} />
      <div className="workspace-files" hidden={view !== "files"}>
        {externalChange && (
          <p className="auth-pending" role="status">
            This file changed outside the editor. Your text is preserved. Copy any unsaved work,
            then use Reload to get the current version.
          </p>
        )}
        <div className="file-actions" role="toolbar" aria-label="File actions">
          <button
            type="button"
            className="file-action"
            title="New file"
            aria-label="New file"
            disabled={readOnly || busy || dirty}
            onClick={() =>
              void action(async () => {
                const path = window.prompt("New file path, for example src/chart.js");
                if (!path) return;
                if (await sandbox.exists(path)) throw new Error("That file already exists.");
                await sandbox.writeFile(path, "");
                await refreshFiles();
                await open(path);
              })
            }
          >
            <FilePlus2 size={16} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="file-action"
            title="Upload file"
            aria-label="Upload file"
            disabled={readOnly || busy}
            onClick={() => uploadInput.current?.click()}
          >
            <Upload size={16} aria-hidden="true" />
          </button>
          <label className="sr-only" htmlFor={`workspace-upload-${workspace}`}>
            Upload file
          </label>
          <input
            ref={uploadInput}
            id={`workspace-upload-${workspace}`}
            type="file"
            hidden
            disabled={readOnly || busy}
            onChange={(event) => {
              const picked = event.target.files?.[0];
              event.target.value = "";
              if (!picked) return;
              void action(async () => {
                if (picked.size > FILE_LIMIT) throw new Error("File exceeds 25 MiB");
                await sandbox.writeFile(picked.name, new Uint8Array(await picked.arrayBuffer()));
                await refreshFiles();
              });
            }}
          />
          <button
            type="button"
            className="file-action"
            title="Download file"
            aria-label="Download file"
            disabled={!file || busy}
            onClick={() =>
              void action(async () => {
                if (!file) return;
                const data = await sandbox.readFile(file.path);
                const url = URL.createObjectURL(new Blob([data as Uint8Array<ArrayBuffer>]));
                const link = document.createElement("a");
                link.href = url;
                link.download = file.path.split("/").pop() ?? "file";
                link.click();
                setTimeout(() => URL.revokeObjectURL(url), 1000);
              })
            }
          >
            <Download size={16} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="file-action"
            title="Reload"
            aria-label="Reload"
            disabled={!file || busy || loading}
            onClick={() => file && void open(file.path)}
          >
            <RefreshCw size={16} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="file-action file-action-save"
            title="Save (⌘S / Ctrl+S)"
            aria-label="Save"
            disabled={!dirty || busy || readOnly}
            onClick={() => void action(save)}
          >
            <Save size={16} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="file-action file-action-delete"
            title={dirty ? "Save or discard edits before deleting" : "Delete file"}
            aria-label="Delete file"
            disabled={!file || readOnly || busy || dirty}
            onClick={() => {
              const selected = file;
              if (!selected || dirty || !window.confirm(`Delete ${selected.path}?`)) return;
              void action(async () => {
                await sandbox.deleteFile(selected.path);
                setFiles((paths) => paths.filter((path) => path !== selected.path));
                if (current.current.file?.path === selected.path) {
                  current.current = { file: null, text: "" };
                  setFile(null);
                  setText("");
                  setExternalChange(false);
                }
                setMessage(`Deleted ${selected.path}.`);
                await refreshFiles();
              });
            }}
          >
            <Trash2 size={16} aria-hidden="true" />
          </button>
        </div>
        <div className="workspace-layout">
          <FileExplorer
            workspace={workspace}
            files={files}
            selected={file?.path}
            changes={changes}
            disabled={busy || loading}
            onOpen={open}
          />
          <section className="editor-area">
            <div className="editor-toolbar">
              <span>
                {file?.path ?? (loading ? "Loading…" : "No file selected")}
                {dirty && <span className="unsaved"> · Unsaved</span>}
              </span>
              <div className="button-row">
                {agentWorking && <Badge tone="amber">Agent working</Badge>}
              </div>
            </div>
            <CodeEditor
              workspace={workspace}
              path={file?.path ?? "untitled.txt"}
              value={text}
              readOnly={readOnly || busy || !file}
              onChange={setText}
              onSave={() => {
                if (dirty && !busy && !readOnly) void action(save);
              }}
            />
          </section>
        </div>
      </div>
      {(error || message) && (
        <div className="workspace-status" role={error ? "alert" : "status"}>
          {error || message}
        </div>
      )}
    </main>
  );
}
