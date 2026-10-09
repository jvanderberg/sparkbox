# UI standards

How Sparkbox looks and behaves. New UI follows these rules; changes to existing UI move it toward them. The agent chat is the exception: it stays faithful to the copied T3 Code UI (see `AGENTS.md`).

## Motion

Every change on screen moves. Nothing appears, disappears, opens, closes or changes colour in a single frame. Motion is subtle and quick: it shows where something came from and where it went, then gets out of the way.

**Tokens.** Use the custom properties in `src/shell.css`, never literal durations or easings:

| Token | Value | For |
| --- | --- | --- |
| `--motion-fast` | 120ms | Hover and press colour, icon fades, small menus |
| `--motion-base` | 200ms | Popovers, drawers, panels, the sidebar |
| `--motion-slow` | 280ms | Large surfaces: dialogs, full-screen changes |
| `--ease-out` | `cubic-bezier(0.2, 0.8, 0.2, 1)` | Anything entering or responding to the user |
| `--ease-in` | `cubic-bezier(0.4, 0, 1, 1)` | Anything leaving |

**Rules.**

- Hover, focus and pressed states fade (`--motion-fast`). No colour, background or border snaps.
- Things that open come in from where they belong. Menus fade and drop 4px from their button. Drawers slide from their edge. The sidebar slides in from the left, and the docked layout moves aside with it at the same duration and easing.
- Things that close leave the same way they came, a little faster than they arrived. A close that skips its animation counts as a bug.
- Move with `opacity` and `transform`. Don't animate `width`, `height`, `top` or `margin` unless the layout itself has to move (the docked sidebar pushing the workspace over is the one case so far).
- No bounce, overshoot, spring or attention-seeking loops. Progress indicators may loop, and only while something is actually in progress.
- Nothing animates on first paint. A page loads in its final state; motion is for changes.
- Respect `prefers-reduced-motion: reduce`. The tokens drop to `0.01ms` under it (set once in `src/shell.css`), so code that uses the tokens gets this for free. Don't hard-code durations that bypass it.

**How.** Keep things that open and close mounted, and toggle the `hidden` attribute rather than rendering conditionally. CSS then animates both directions:

```css
.thing {
  transition:
    opacity var(--motion-fast) var(--ease-out),
    transform var(--motion-fast) var(--ease-out),
    display var(--motion-fast) allow-discrete;
}
.thing[hidden] {
  display: none;
  opacity: 0;
  transform: translateY(-4px);
}
@starting-style {
  .thing:not([hidden]) {
    opacity: 0;
    transform: translateY(-4px);
  }
}
```

`@starting-style` gives the enter animation; `transition-behavior: allow-discrete` on `display` holds the element visible until its exit finishes. Browsers without them show and hide instantly, which is acceptable. For a surface that must stay in the accessibility tree's order or keep its scroll position (the sidebar), use `visibility` instead of `hidden`, with the visibility change delayed until the slide-out ends.

**Where it is done (2026-10-08).** The projects sidebar slides, and in the docked layout the workspace moves with it; the phone drawer's backdrop fades. Menus (Publish, the preview's ⋯), the server settings popover and the logs drawer animate both ways. Hover states, the new-project row, toasts, switching views and opening dialogs animate in. Reduced motion turns all of it off.

**Known gaps, to fix:** closing a dialog (the `Modal` is unmounted by its parent, so it cannot play an exit), entering full-screen preview (it fills the window at once so the frame is measured at full size), cancelling the new-project row, adding and removing project rows, the outgoing view when switching tabs, and the parts carried over from Civic Spark and T3 Code (file explorer collapse, the agent's Connection popover, diff sections in Changes).

## Controls

- Secondary and repeated actions are icon buttons with a `title` and an `aria-label`: ✕ to delete or close, + to add, a gear for Settings, ⟳ to reload or refresh, ⋯ for more. Delete in a list is a ✕ that appears on hover, and is always shown where there is no hover.
- Text buttons are for the main call to action in a place: "Create a project", "Publish", "Back up to GitHub", "Commit".
- Things you name are named in place. A new project is a row in the list you type into: Enter creates, Escape cancels.
- Rarely used actions go behind ⋯, not in a row of buttons.
- Controls live with what they control. Preview actions are in the Preview toolbar; backup is in Changes. The workspace header holds only what applies everywhere.
- Don't show status that never changes or that the user can't act on ("Runs in this browser", "Sandbox ready"). Show state when it needs attention: a count, a warning tone, an error.

## Layout and themes

- Follow the system light or dark theme. Use the `--app-*` colour variables from `src/theme.css`; no literal colours in new CSS.
- Work panels fit the viewport and scroll inside themselves.
- Phones are a required layout. Touch targets are at least 44px and inputs 16px, so iOS does not zoom. Check phone width and a short landscape viewport in both themes.

## Checking

The browser smoke (`npm run test:browser`) saves screenshots to `artifacts/`; look at them. Screenshots can't show motion, so open and close every surface you touched by hand, and once more with reduced motion turned on in the OS.
