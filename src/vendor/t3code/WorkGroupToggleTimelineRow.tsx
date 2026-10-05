// Adapted from T3 Code, copyright (c) 2026 T3 Tools Inc. MIT; see LICENSE.txt.
import type { ReactNode } from "react";
export function WorkGroupToggleTimelineRow({
  row,
  icon,
  onToggle,
}: {
  row: { summary: string; hasFailure?: boolean; expanded: boolean };
  icon: ReactNode;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      className="group/tool-group flex min-h-6 w-full cursor-pointer items-center gap-1.5 rounded-md px-0.5 py-0.5 text-left text-sm leading-relaxed transition-colors duration-150 hover:bg-accent/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70"
      aria-label={row.hasFailure ? `${row.summary}, tool call failed` : undefined}
      aria-expanded={row.expanded}
      onClick={onToggle}
    >
      <span className="flex size-6 shrink-0 items-center justify-center text-icon-muted">
        {icon}
      </span>
      <span className="min-w-0 flex-1 truncate text-secondary-label">{row.summary}</span>
    </button>
  );
}
