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
 * Changes since the last saved version. Civic Spark's Share pushed to a team
 * repository; here Save version records a new baseline in this browser.
 * Publishing to GitHub is planned.
 */
export function Changes({
  value,
  refresh,
  dirty,
  readOnly,
  onSaveVersion,
  error,
}: {
  value: WorkspaceChanges | null;
  refresh: () => void;
  dirty: boolean;
  readOnly: boolean;
  onSaveVersion: (title: string) => Promise<void>;
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
      await onSaveVersion(title.trim());
      setTitle("");
      setNotice("Version saved.");
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : "Could not save the version.");
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
            className="button small changes-refresh"
            onClick={refresh}
            disabled={busy}
            aria-label="Refresh changes"
          >
            <RefreshCw size={13} aria-hidden="true" />
            Refresh
          </button>
        </div>
        <form
          className="changes-commit"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <label htmlFor={messageId}>Version description</label>
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
              title="Record these changes as the saved version"
              aria-describedby={helpId}
            >
              {busy ? "Saving…" : "Save version"}
            </button>
          </div>
          <span id={helpId} className="sr-only">
            Save version records the current files as the baseline that later changes are compared
            against.
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
        {value && count === 0 && (
          <p className="changes-empty">No changes since the saved version.</p>
        )}
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
