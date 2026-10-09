import { FolderGit2, Menu, Plus, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

export type Project = { id: string; name: string };

/** Below this width the sidebar covers the work instead of sitting beside it. */
export const drawerQuery = "(max-width: 899px)";

/** The header button that shows and hides the projects sidebar. */
export function SidebarToggle({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      className="header-icon"
      aria-label={open ? "Hide projects" : "Show projects"}
      title={open ? "Hide projects" : "Show projects"}
      aria-expanded={open}
      aria-controls="project-sidebar"
      onClick={onToggle}
    >
      <Menu size={18} aria-hidden="true" />
    </button>
  );
}

/**
 * A new project, named in place at the end of the list, where it will go. Enter creates it
 * (blank is "Untitled project"), Escape cancels, and leaving the field keeps
 * whatever was typed.
 */
function NewProjectRow({
  onCreate,
  onCancel,
}: {
  onCreate: (name: string) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState("");
  const done = useRef(false);
  function finish(create: boolean) {
    if (done.current) return;
    done.current = true;
    if (create) onCreate(name.trim());
    else onCancel();
  }
  return (
    <li>
      <input
        className="project-sidebar-new"
        aria-label="Project name"
        placeholder="Name your project"
        value={name}
        // biome-ignore lint/a11y/noAutofocus: The row appears because the user asked for a new project.
        autoFocus
        onChange={(event) => setName(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            finish(true);
          } else if (event.key === "Escape") {
            event.stopPropagation();
            finish(false);
          }
        }}
        onBlur={() => finish(name.trim() !== "")}
      />
    </li>
  );
}

/**
 * Every project in this browser. Docked beside the work on wide screens and
 * a drawer over it on narrow ones.
 */
export function ProjectSidebar({
  projects,
  current,
  open,
  onClose,
  onOpen,
  onCreate,
  onDelete,
  onOpenFromGitHub,
}: {
  projects: Project[];
  current: string | null;
  open: boolean;
  onClose: () => void;
  onOpen: (project: Project) => void;
  onCreate: (name: string) => void;
  onDelete: (project: Project) => void;
  onOpenFromGitHub: () => void;
}) {
  const [creating, setCreating] = useState(false);
  useEffect(() => {
    if (!open) setCreating(false);
  }, [open]);
  return (
    <>
      <button
        type="button"
        className="sidebar-backdrop"
        aria-label="Close projects"
        tabIndex={-1}
        data-open={open}
        onClick={onClose}
      />
      <nav
        id="project-sidebar"
        className="project-sidebar"
        aria-label="Projects"
        // Always mounted so it can slide; closed, it is visibility: hidden and out of the tab order.
        data-open={open}
        onKeyDown={(event) => {
          if (event.key === "Escape" && window.matchMedia(drawerQuery).matches) onClose();
        }}
      >
        <div className="project-sidebar-header">
          <h2>Projects</h2>
          <button
            type="button"
            className="header-icon"
            aria-label="New project"
            title="New project"
            onClick={() => setCreating(true)}
          >
            <Plus size={18} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="header-icon"
            aria-label="Open from GitHub"
            title="Open from GitHub"
            onClick={onOpenFromGitHub}
          >
            <FolderGit2 size={17} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="header-icon sidebar-close"
            aria-label="Close projects"
            title="Close"
            onClick={onClose}
          >
            <X size={18} aria-hidden="true" />
          </button>
        </div>
        <ul className="project-sidebar-list">
          {projects.map((project) => (
            <li key={project.id}>
              <button
                type="button"
                className="project-sidebar-open"
                aria-current={project.id === current ? "page" : undefined}
                onClick={() => onOpen(project)}
              >
                {project.name}
              </button>
              <button
                type="button"
                className="project-sidebar-delete"
                aria-label={`Delete ${project.name}`}
                title="Delete project"
                onClick={() => onDelete(project)}
              >
                <X size={14} aria-hidden="true" />
              </button>
            </li>
          ))}
          {creating && (
            <NewProjectRow
              onCreate={(name) => {
                setCreating(false);
                onCreate(name);
              }}
              onCancel={() => setCreating(false)}
            />
          )}
        </ul>
      </nav>
    </>
  );
}
