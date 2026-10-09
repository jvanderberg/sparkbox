import { Settings } from "lucide-react";
import { type ReactNode, useState } from "react";

/** What shows when no project is open: on first load, or after one is deleted. */
export function Landing({
  menu,
  onSettings,
  onCreate,
  onOpenFromGitHub,
}: {
  /** The sidebar toggle. */
  menu: ReactNode;
  onSettings: () => void;
  onCreate: (name: string) => void;
  onOpenFromGitHub: () => void;
}) {
  // Blank is fine: the project is then called "Untitled project".
  const [name, setName] = useState("");
  return (
    <main className="landing">
      <header className="landing-header">
        {menu}
        <button type="button" className="header-icon" aria-label="Settings" onClick={onSettings}>
          <Settings size={18} aria-hidden="true" />
        </button>
      </header>
      <section className="landing-body">
        <h1>Sparkbox</h1>
        <p>Describe an app and an AI agent builds it, with a live preview as it goes.</p>
        <form
          className="project-create"
          onSubmit={(event) => {
            event.preventDefault();
            onCreate(name.trim());
          }}
        >
          <input
            aria-label="Project name"
            placeholder="Project name"
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
          <button type="submit" className="button primary">
            Create a project
          </button>
        </form>
        <p className="landing-alternative">
          Or{" "}
          <button type="button" className="link-button" onClick={onOpenFromGitHub}>
            open a project from GitHub
          </button>
          .
        </p>
      </section>
    </main>
  );
}
