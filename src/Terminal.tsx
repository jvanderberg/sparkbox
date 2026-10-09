import { FitAddon } from "@xterm/addon-fit";
import { type ITheme, Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { RotateCcw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { terminalPromptCode } from "./sandbox/guest-tools.ts";
import type { TerminalSession, WasmerSandbox } from "./sandbox/wasmer.ts";
import { useSystemTheme } from "./theme.ts";
import "./terminal.css";

/** ANSI colours readable on each theme's background. */
const palettes: Record<"light" | "dark", ITheme> = {
  light: {
    black: "#24292f",
    red: "#cf222e",
    green: "#116329",
    yellow: "#7d4e00",
    blue: "#0969da",
    magenta: "#8250df",
    cyan: "#1b7c83",
    white: "#6e7781",
    brightBlack: "#57606a",
    brightRed: "#a40e26",
    brightGreen: "#1a7f37",
    brightYellow: "#633c01",
    brightBlue: "#218bff",
    brightMagenta: "#a475f9",
    brightCyan: "#3192aa",
    brightWhite: "#8c959f",
  },
  dark: {
    black: "#484f58",
    red: "#ff7b72",
    green: "#3fb950",
    yellow: "#d29922",
    blue: "#58a6ff",
    magenta: "#bc8cff",
    cyan: "#39c5cf",
    white: "#b1bac4",
    brightBlack: "#6e7681",
    brightRed: "#ffa198",
    brightGreen: "#56d364",
    brightYellow: "#e3b341",
    brightBlue: "#79c0ff",
    brightMagenta: "#d2a8ff",
    brightCyan: "#56d4dd",
    brightWhite: "#ffffff",
  },
};

function themeFor(scheme: "light" | "dark"): ITheme {
  const style = getComputedStyle(document.documentElement);
  const color = (name: string) => style.getPropertyValue(name).trim();
  return {
    ...palettes[scheme],
    background: color("--app-background"),
    foreground: color("--app-text"),
    cursor: color("--app-text"),
    cursorAccent: color("--app-background"),
    selectionBackground: color("--app-border"),
  };
}

/** Keys a phone keyboard lacks, sent as the bytes a terminal would. */
const touchKeys = [
  ["Esc", "\x1b", "Escape"],
  ["Tab", "\t", "Tab"],
  ["^C", "\x03", "Control-C"],
  ["↑", "\x1b[A", "Up"],
  ["↓", "\x1b[B", "Down"],
  ["←", "\x1b[D", "Left"],
  ["→", "\x1b[C", "Right"],
] as const;

/** On phones focusing would raise the keyboard; a tap does that. */
const focusOnShow = () => window.matchMedia("(pointer: fine)").matches;

type Control = {
  fit: () => void;
  focus: () => void;
  send: (data: string) => void;
  restart: () => void;
};

/**
 * An interactive bash in the project's sandbox. The shell starts the first
 * time the view is shown and lives as long as the project is open; switching
 * views keeps it running.
 */
export function TerminalPanel({
  sandbox,
  visible,
  onOpenFile,
}: {
  sandbox: WasmerSandbox;
  visible: boolean;
  /** The edit command (and its vi, nano and code names) asks for a file. */
  onOpenFile: (path: string) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const openFile = useRef(onOpenFile);
  openFile.current = onOpenFile;
  const control = useRef<Control | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const [started, setStarted] = useState(false);
  const scheme = useSystemTheme();

  useEffect(() => {
    if (visible) setStarted(true);
  }, [visible]);

  useEffect(() => {
    const element = host.current;
    if (!started || !element) return;
    const terminal = new Terminal({
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
      fontSize: 13,
      cursorBlink: true,
      // The sandbox terminal sends bare line feeds.
      convertEol: true,
      scrollback: 5000,
      theme: themeFor(window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"),
    });
    const fitter = new FitAddon();
    terminal.loadAddon(fitter);
    terminal.open(element);
    const fitToPanel = () => {
      // A hidden panel has no size to fit to.
      if (element.clientWidth && element.clientHeight) fitter.fit();
    };
    fitToPanel();
    if (focusOnShow()) terminal.focus();
    terminalRef.current = terminal;

    let session: TerminalSession | null = null;
    /** Each shell's number; output from a replaced shell is dropped. */
    let generation = 0;
    let waitingForEnter = false;
    let disposed = false;

    // Commands the shell runs change files the page has not seen; check
    // after each one, one check at a time.
    let syncing = false;
    let syncAgain = false;
    const sync = () => {
      if (syncing) {
        syncAgain = true;
        return;
      }
      syncing = true;
      void sandbox.commandFinished().finally(() => {
        syncing = false;
        if (syncAgain && !disposed) {
          syncAgain = false;
          sync();
        }
      });
    };
    terminal.parser.registerOscHandler(terminalPromptCode, (data) => {
      if (data.startsWith("open;")) openFile.current(data.slice(5));
      else sync();
      return true;
    });

    const start = async () => {
      const mine = ++generation;
      waitingForEnter = false;
      try {
        const next = await sandbox.openTerminal(
          { columns: terminal.cols, rows: terminal.rows },
          (data) => {
            if (mine === generation && !disposed) terminal.write(data);
          },
        );
        if (disposed || mine !== generation) {
          void next.kill();
          return;
        }
        session = next;
        void next.done.then((code) => {
          if (disposed || mine !== generation) return;
          session = null;
          waitingForEnter = true;
          terminal.write(
            `\r\n\x1b[2m[${code === null ? "The sandbox was restarted" : `Shell exited with code ${code}`}. Press Enter for a new shell.]\x1b[0m\r\n`,
          );
          sync();
        });
      } catch (error) {
        if (disposed || mine !== generation) return;
        waitingForEnter = true;
        const message = error instanceof Error ? error.message : String(error);
        terminal.write(
          `\x1b[31m${message}\x1b[0m\r\n\x1b[2m[Press Enter to try again.]\x1b[0m\r\n`,
        );
      }
    };

    terminal.onData((data) => {
      if (session) session.write(data);
      else if (waitingForEnter && data === "\r") void start();
    });
    terminal.onResize(({ cols, rows }) => session?.resize(cols, rows));
    const observer = new ResizeObserver(fitToPanel);
    observer.observe(element);
    control.current = {
      fit: fitToPanel,
      focus: () => terminal.focus(),
      send: (data) => {
        if (session) session.write(data);
        else if (waitingForEnter && data === "\r") void start();
      },
      restart: () => {
        const previous = session;
        session = null;
        terminal.reset();
        void previous?.kill();
        void start();
        terminal.focus();
      },
    };
    void start();
    return () => {
      disposed = true;
      observer.disconnect();
      void session?.kill();
      terminal.dispose();
      terminalRef.current = null;
      control.current = null;
    };
  }, [started, sandbox]);

  useEffect(() => {
    if (terminalRef.current) terminalRef.current.options.theme = themeFor(scheme);
  }, [scheme]);

  useEffect(() => {
    if (!visible) return;
    const frame = requestAnimationFrame(() => {
      control.current?.fit();
      if (focusOnShow()) control.current?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [visible]);

  return (
    <section className="workspace-panel terminal-panel" aria-label="Terminal" hidden={!visible}>
      <div className="terminal-toolbar" role="toolbar" aria-label="Terminal controls">
        <span className="terminal-title">bash</span>
        <button
          type="button"
          className="header-icon"
          aria-label="New shell"
          title="New shell"
          onClick={() => control.current?.restart()}
        >
          <RotateCcw size={16} aria-hidden="true" />
        </button>
      </div>
      <div className="terminal-host" ref={host} />
      <div className="terminal-keys" role="toolbar" aria-label="Terminal keys">
        {touchKeys.map(([label, data, name]) => (
          <button
            type="button"
            key={name}
            aria-label={name}
            // Keep the terminal focused so the keyboard stays up.
            onPointerDown={(event) => event.preventDefault()}
            onClick={() => control.current?.send(data)}
          >
            {label}
          </button>
        ))}
      </div>
    </section>
  );
}
