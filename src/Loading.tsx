import { useEffect, useState } from "react";
import type { SandboxProgress } from "./sandbox/wasmer.ts";
import "./loading.css";

const steps: { phase: SandboxProgress["phase"][]; label: string }[] = [
  { phase: ["runtime"], label: "Starting the runtime" },
  { phase: ["resolving", "downloading", "loading"], label: "Fetching the sandbox" },
  { phase: ["restoring"], label: "Restoring your files" },
  { phase: ["cloning"], label: "Fetching the repository from GitHub" },
  { phase: ["ready"], label: "Ready" },
];

function megabytes(bytes: number) {
  return `${(bytes / 1_000_000).toFixed(bytes < 10_000_000 ? 1 : 0)} MB`;
}

/** Full-screen progress while the sandbox boots. */
export function Loading({
  title,
  progress,
  error,
  onBack,
}: {
  title: string;
  progress: SandboxProgress;
  error?: string;
  onBack: () => void;
}) {
  const [started] = useState(() => Date.now());
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [started]);
  const current = steps.findIndex((step) => step.phase.includes(progress.phase));
  const downloading = progress.phase === "downloading" || progress.phase === "resolving";
  const percent =
    progress.phase === "ready"
      ? 100
      : progress.phase === "restoring" || progress.phase === "loading"
        ? 95
        : progress.phase === "cloning"
          ? 97
          : typeof progress.percent === "number"
            ? Math.min(94, Math.max(2, progress.percent * 0.9))
            : null;
  const detail = error
    ? ""
    : progress.phase === "downloading" && progress.downloadedBytes !== undefined
      ? `${megabytes(progress.downloadedBytes)}${progress.totalBytes ? ` of ${megabytes(progress.totalBytes)}` : ""}`
      : progress.cached && downloading
        ? "Using the cached sandbox"
        : "";
  return (
    <main className="loading" aria-busy={!error}>
      <section className="loading-card" role={error ? "alert" : "status"} aria-live="polite">
        <p className="loading-kicker">Opening</p>
        <h1>{title}</h1>
        <div
          className="loading-bar"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent ?? undefined}
          aria-label="Sandbox start progress"
          data-indeterminate={percent === null && !error}
        >
          <span style={{ width: percent === null ? "40%" : `${percent}%` }} />
        </div>
        <ol className="loading-steps">
          {steps.map((step, index) => (
            <li
              key={step.label}
              data-state={
                error && index === current
                  ? "error"
                  : index < current || progress.phase === "ready"
                    ? "done"
                    : index === current
                      ? "active"
                      : "pending"
              }
            >
              <span className="loading-dot" aria-hidden="true" />
              <span>{step.label}</span>
              {index === current && detail && <small>{detail}</small>}
            </li>
          ))}
        </ol>
        {error ? (
          <>
            <p className="loading-error">{error}</p>
            <div className="form-actions">
              <button type="button" className="button" onClick={onBack}>
                Back to projects
              </button>
            </div>
          </>
        ) : (
          <p className="loading-note">
            {elapsed >= 20
              ? `Still working (${elapsed}s). The first open downloads the sandbox once; later opens use the cache.`
              : "The first open downloads the sandbox once. Later opens use the cache."}
          </p>
        )}
      </section>
    </main>
  );
}
