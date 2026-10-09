import "./changes.css";
import { ChevronRight, RefreshCw } from "lucide-react";
import { useId, useState } from "react";
import type { Changes as WorkspaceChanges } from "./workspace/types.ts";

function diffLines(diff: string) {
  const lines = diff.split("\n");
  const firstHunk = lines.findIndex((line) => line.startsWith("@@"));
  return firstHunk > 0 ? lines.slice(firstHunk) : lines;
}

/**
 * Uncommitted changes, as git sees them against HEAD. Civic Spark's Share
 * pushed to a team repository; here Commit records them in the project's
 * own repository and, once the project is on GitHub, pushes too.
 */
export function Changes({
  value,
  refresh,
  dirty,
  readOnly,
  pushes,
  onCommit,
  error,
}: {
  value: WorkspaceChanges | null;
  refresh: () => void;
  dirty: boolean;
  readOnly: boolean;
  /** True when a commit also pushes to GitHub. */
  pushes: boolean;
  onCommit: (title: string) => Promise<void>;
  error: string;
}) {
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const messageId = useId();
  const helpId = useId();
  const count = value?.files.length ?? 0;
  const canSave = Boolean(!busy && !dirty && !readOnly && count && !error && title.trim());
  async function save() {
    if (!canSave) return;
    setBusy(true);
    setNotice("");
    try {
      await onCommit(title.trim());
      setTitle("");
      setNotice(pushes ? "Committed and backed up to GitHub." : "Committed.");
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : "Could not commit.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="workspace-panel changes-panel" aria-label="Workspace changes">
      <div className="changes-controls">
        <div className="changes-toolbar">
          <span>
            {count} {count === 1 ? "file" : "files"} changed
          </span>
          <button
            type="button"
            className="header-icon"
            onClick={refresh}
            disabled={busy}
            aria-label="Refresh changes"
            title="Refresh changes"
          >
            <RefreshCw size={15} aria-hidden="true" />
          </button>
        </div>
        <form
          className="changes-commit"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <label htmlFor={messageId}>Commit message</label>
          <div className="changes-commit-row">
            <input
              id={messageId}
              placeholder="Summarize your changes"
              value={title}
              maxLength={160}
              onChange={(event) => setTitle(event.target.value)}
              disabled={busy || readOnly}
              autoComplete="off"
              aria-describedby={helpId}
            />
            <button
              type="submit"
              className="button primary"
              disabled={!canSave}
              title={
                pushes
                  ? "Commit these changes and push them to GitHub"
                  : "Record these changes as a commit in the project's repository"
              }
              aria-describedby={helpId}
            >
              {busy ? "Committing…" : pushes ? "Commit and back up" : "Commit"}
            </button>
          </div>
          <span id={helpId} className="sr-only">
            {pushes
              ? "Commit records the current files in the project's git repository and pushes them to GitHub."
              : "Commit records the current files in the project's git repository; later changes are compared against it."}
          </span>
        </form>
        {dirty ? (
          <p className="changes-blocker">Save your open file first.</p>
        ) : readOnly ? (
          <p className="changes-blocker">The workspace is not ready.</p>
        ) : null}
        {notice && (
          <p className="changes-blocker" role="status">
            {notice}
          </p>
        )}
        {error && (
          <p className="changes-blocker changes-error" role="alert">
            {error}
          </p>
        )}
      </div>
      <div className="changes-files">
        {!value && !error && (
          <p className="changes-empty" role="status">
            Loading changes…
          </p>
        )}
        {value && count === 0 && <p className="changes-empty">No changes since the last commit.</p>}
        {value?.files.map((file) => (
          <details className="file-diff" key={file.path} open>
            <summary>
              <ChevronRight className="diff-chevron" size={14} aria-hidden="true" />
              <code title={file.path}>{file.path}</code>
              <span className={`change-kind ${file.status}`} title={file.status}>
                <span aria-hidden="true">{file.status[0]?.toUpperCase()}</span>
                <span className="sr-only">{file.status}</span>
              </span>
            </summary>
            {file.binary ? (
              <p className="changes-empty">Binary file</p>
            ) : (
              <pre className="live-diff">
                {diffLines(file.diff).map((line, index) => (
                  <span
                    // biome-ignore lint/suspicious/noArrayIndexKey: Diff lines are stateless, including repeated blank lines.
                    key={index}
                    className={
                      line.startsWith("+")
                        ? "diff-add"
                        : line.startsWith("-")
                          ? "diff-remove"
                          : line.startsWith("@@")
                            ? "diff-hunk"
                            : ""
                    }
                  >
                    {line || " "}
                  </span>
                ))}
              </pre>
            )}
          </details>
        ))}
      </div>
    </section>
  );
}
