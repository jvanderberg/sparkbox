import {
  ChevronDown,
  ChevronRight,
  FileCode2,
  FileText,
  Folder,
  FolderOpen,
  PanelLeftClose,
  PanelLeftOpen,
  Table2,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Changes } from "./workspace/types.ts";

type Entry = { name: string; path: string; directory: boolean; children: Entry[] };
type Row = Entry & { depth: number; position: number; siblings: number };
function buildTree(paths: string[]): Entry[] {
  const root: Entry[] = [];
  const folders = new Map<string, Entry>();
  for (const path of paths) {
    const parts = path.split("/");
    let children = root;
    for (let index = 0; index < parts.length; index++) {
      const name = parts[index];
      if (!name) continue;
      const current = parts.slice(0, index + 1).join("/");
      const directory = index < parts.length - 1;
      if (directory) {
        let folder = folders.get(current);
        if (!folder) {
          folder = { name, path: current, directory, children: [] };
          folders.set(current, folder);
          children.push(folder);
        }
        children = folder.children;
      } else children.push({ name, path: current, directory, children: [] });
    }
  }
  function sort(entries: Entry[]) {
    entries.sort(
      (a, b) =>
        Number(b.directory) - Number(a.directory) ||
        a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }),
    );
    for (const entry of entries) sort(entry.children);
  }
  sort(root);
  return root;
}
function initialPreference(workspace: string): { width: number; collapsed: boolean } {
  try {
    const stored = JSON.parse(
      localStorage.getItem(`sparkbox:workspace:${workspace}:explorer`) ?? "null",
    );
    return {
      width:
        typeof stored?.width === "number" && Number.isFinite(stored.width)
          ? Math.max(96, Math.min(480, stored.width))
          : 220,
      collapsed: stored?.collapsed === true,
    };
  } catch {
    return { width: 220, collapsed: false };
  }
}

export function FileExplorer({
  workspace,
  files,
  selected,
  changes,
  disabled,
  onOpen,
}: {
  workspace: string;
  files: string[];
  selected?: string;
  changes: Changes | null;
  disabled: boolean;
  onOpen: (path: string) => Promise<boolean>;
}) {
  const [preference, setPreference] = useState(() => initialPreference(workspace));
  const [mobile, setMobile] = useState(() => matchMedia("(max-width: 650px)").matches);
  const [mobileCollapsed, setMobileCollapsed] = useState(true);
  const collapsed = mobile ? mobileCollapsed : preference.collapsed;
  useEffect(() => {
    const query = matchMedia("(max-width: 650px)");
    const update = () => setMobile(query.matches);
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  const [containerWidth, setContainerWidth] = useState(window.innerWidth);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [focused, setFocused] = useState<string>();
  const [resizing, setResizing] = useState(false);
  const aside = useRef<HTMLElement>(null);
  const elements = useRef(new Map<string, HTMLButtonElement>());
  const drag = useRef<{ x: number; width: number } | null>(null);
  const tree = useMemo(() => buildTree(files), [files]);
  const rows = useMemo(() => {
    const visible: Row[] = [];
    function append(entries: Entry[], depth: number) {
      entries.forEach((entry, index) => {
        visible.push({ ...entry, depth, position: index + 1, siblings: entries.length });
        if (entry.directory && expanded.has(entry.path)) append(entry.children, depth + 1);
      });
    }
    append(tree, 0);
    return visible;
  }, [tree, expanded]);
  const maximum = Math.max(96, Math.min(480, Math.min(containerWidth, window.innerWidth) - 220));
  const minimum = Math.min(144, maximum);
  const width = Math.max(minimum, Math.min(maximum, preference.width));
  const tabStop = rows.some((row) => row.path === focused) ? focused : rows[0]?.path;
  const fileChanges = new Map(changes?.files.map((file) => [file.path, file.status]));
  useEffect(() => {
    const container = aside.current?.parentElement;
    if (!container) return;
    const observer = new ResizeObserver(() => {
      if (container.clientWidth > 0) setContainerWidth(container.clientWidth);
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    try {
      localStorage.setItem(`sparkbox:workspace:${workspace}:explorer`, JSON.stringify(preference));
    } catch {
      // Only layout preferences are stored; browsing never depends on storage.
    }
  }, [workspace, preference]);
  useEffect(() => {
    if (!selected) return;
    setFocused(selected);
    const parts = selected.split("/");
    setExpanded((previous) => {
      const next = new Set(previous);
      for (let index = 1; index < parts.length; index++) next.add(parts.slice(0, index).join("/"));
      return next;
    });
  }, [selected]);
  function toggle(path: string) {
    setExpanded((previous) => {
      const next = new Set(previous);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }
  function focus(path: string | undefined) {
    if (!path) return;
    setFocused(path);
    elements.current.get(path)?.focus();
  }
  function resize(next: number) {
    setPreference((previous) => ({
      ...previous,
      width: Math.max(minimum, Math.min(maximum, next)),
    }));
  }
  return (
    <>
      <aside
        ref={aside}
        className={`file-explorer${collapsed ? " collapsed" : ""}`}
        style={{
          width: collapsed
            ? mobile
              ? 44
              : 32
            : mobile
              ? Math.min(300, containerWidth - 44)
              : width,
        }}
        aria-label="File explorer"
      >
        <header className="explorer-heading">
          {!collapsed && <span>EXPLORER</span>}
          <button
            type="button"
            aria-label={collapsed ? "Show file explorer" : "Collapse file explorer"}
            title={collapsed ? "Show file explorer" : "Collapse file explorer"}
            aria-expanded={!collapsed}
            onClick={() => {
              if (mobile) setMobileCollapsed(!mobileCollapsed);
              else setPreference((previous) => ({ ...previous, collapsed: !previous.collapsed }));
            }}
          >
            {collapsed ? <PanelLeftOpen size={15} /> : <PanelLeftClose size={15} />}
          </button>
        </header>
        {!collapsed && (
          <div
            id={`explorer-${workspace}`}
            className="explorer-tree"
            role="tree"
            aria-label="Project files"
          >
            {rows.map((row, index) => {
              const isOpen = expanded.has(row.path);
              const isCode = /\.(tsx?|jsx?|json|html|css|py|sql|sh|ya?ml)$/i.test(row.name);
              const isData = /\.(csv|tsv|parquet)$/i.test(row.name);
              const Icon = row.directory
                ? isOpen
                  ? FolderOpen
                  : Folder
                : isData
                  ? Table2
                  : isCode
                    ? FileCode2
                    : FileText;
              const status = fileChanges.get(row.path);
              return (
                <button
                  ref={(element) => {
                    if (element) elements.current.set(row.path, element);
                    else elements.current.delete(row.path);
                  }}
                  key={row.path}
                  type="button"
                  role="treeitem"
                  aria-label={row.path}
                  aria-level={row.depth + 1}
                  aria-posinset={row.position}
                  aria-setsize={row.siblings}
                  aria-expanded={row.directory ? isOpen : undefined}
                  aria-selected={!row.directory && selected === row.path}
                  aria-disabled={!row.directory && disabled}
                  tabIndex={row.path === tabStop ? 0 : -1}
                  className={`explorer-item${selected === row.path ? " selected" : ""}`}
                  title={row.path}
                  style={{ paddingLeft: 6 + row.depth * 16 }}
                  onFocus={() => setFocused(row.path)}
                  onClick={() => {
                    if (row.directory) toggle(row.path);
                    else if (!disabled)
                      void onOpen(row.path).then((opened) => {
                        if (opened && mobile) {
                          setMobileCollapsed(true);
                          aside.current?.querySelector("button")?.focus();
                        }
                      });
                  }}
                  onKeyDown={(event) => {
                    switch (event.key) {
                      case "ArrowDown":
                        event.preventDefault();
                        focus(rows[index + 1]?.path);
                        break;
                      case "ArrowUp":
                        event.preventDefault();
                        focus(rows[index - 1]?.path);
                        break;
                      case "Home":
                        event.preventDefault();
                        focus(rows[0]?.path);
                        break;
                      case "End":
                        event.preventDefault();
                        focus(rows.at(-1)?.path);
                        break;
                      case "ArrowRight":
                        event.preventDefault();
                        if (row.directory && !isOpen) toggle(row.path);
                        else if (row.directory) focus(rows[index + 1]?.path);
                        break;
                      case "ArrowLeft":
                        event.preventDefault();
                        if (row.directory && isOpen) toggle(row.path);
                        else
                          focus(
                            row.path.includes("/")
                              ? row.path.slice(0, row.path.lastIndexOf("/"))
                              : undefined,
                          );
                        break;
                    }
                  }}
                >
                  <span className="explorer-chevron">
                    {row.directory &&
                      (isOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />)}
                  </span>
                  <Icon
                    size={14}
                    className={`explorer-icon ${row.directory ? "folder" : isData ? "data" : isCode ? "code" : "document"}`}
                  />
                  <span className="explorer-name">{row.name}</span>
                  {status && (
                    <span className={`explorer-change ${status}`} title={status} aria-hidden="true">
                      {status === "added" ? "A" : "M"}
                    </span>
                  )}
                </button>
              );
            })}
            {!rows.length && <p className="explorer-empty">No project files</p>}
          </div>
        )}
      </aside>
      {!collapsed && !mobile && (
        <hr
          className={`explorer-resizer${resizing ? " resizing" : ""}`}
          tabIndex={0}
          aria-label="Resize file explorer"
          aria-orientation="vertical"
          aria-valuemin={minimum}
          aria-valuemax={maximum}
          aria-valuenow={Math.round(width)}
          aria-controls={`explorer-${workspace}`}
          title="Drag to resize · arrow keys adjust width"
          onPointerDown={(event) => {
            event.preventDefault();
            event.currentTarget.focus();
            event.currentTarget.setPointerCapture(event.pointerId);
            drag.current = { x: event.clientX, width };
            setResizing(true);
          }}
          onPointerMove={(event) => {
            if (drag.current) resize(drag.current.width + event.clientX - drag.current.x);
          }}
          onPointerUp={(event) => {
            drag.current = null;
            setResizing(false);
            event.currentTarget.releasePointerCapture(event.pointerId);
          }}
          onLostPointerCapture={() => {
            drag.current = null;
            setResizing(false);
          }}
          onKeyDown={(event) => {
            if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
              event.preventDefault();
              resize(width + (event.key === "ArrowLeft" ? -16 : 16));
            }
            if (event.key === "Home" || event.key === "End") {
              event.preventDefault();
              resize(event.key === "Home" ? minimum : maximum);
            }
          }}
        />
      )}
    </>
  );
}
