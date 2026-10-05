import type * as Monaco from "monaco-editor";
import { useEffect, useRef, useState } from "react";
import { editorLanguage } from "./editor-language.ts";
import { useSystemTheme } from "./theme.ts";

export function CodeEditor({
  workspace,
  path,
  value,
  readOnly,
  onChange,
  onSave,
}: {
  workspace: string;
  path: string;
  value: string;
  readOnly: boolean;
  onChange: (value: string) => void;
  onSave: () => void;
}) {
  const theme = useSystemTheme();
  const container = useRef<HTMLDivElement>(null);
  const editor = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null);
  const engine = useRef<typeof Monaco | null>(null);
  const programmatic = useRef(false);
  const latest = useRef({ workspace, path, value, readOnly, onChange, onSave, theme });
  latest.current = { workspace, path, value, readOnly, onChange, onSave, theme };
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let cancelled = false;
    let unsubscribe: Monaco.IDisposable | undefined;
    void import("./monaco.ts")
      .then(({ monaco }) => {
        if (cancelled || !container.current) return;
        engine.current = monaco;
        const state = latest.current;
        const model = monaco.editor.createModel(
          state.value,
          editorLanguage(state.path, monaco.languages.getLanguages()),
          monaco.Uri.from({ scheme: "file", path: `/${state.workspace}/${state.path}` }),
        );
        const instance = monaco.editor.create(container.current, {
          model,
          theme: state.theme === "dark" ? "vs-dark" : "vs",
          ariaLabel: "File contents",
          readOnly: state.readOnly,
          automaticLayout: true,
          fontSize: 13,
          lineHeight: 21,
          fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
          minimap: { enabled: false },
          scrollBeyondLastLine: false,
          padding: { top: 10, bottom: 10 },
          lineNumbersMinChars: 3,
          glyphMargin: false,
          folding: true,
          stickyScroll: { enabled: false },
          bracketPairColorization: { enabled: true },
          wordWrap: "off",
          tabSize: 2,
          insertSpaces: true,
          editContext: false,
          accessibilitySupport: "auto",
        });
        editor.current = instance;
        unsubscribe = instance.onDidChangeModelContent(() => {
          if (!programmatic.current) latest.current.onChange(instance.getValue());
        });
        instance.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () =>
          latest.current.onSave(),
        );
        setReady(true);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
      unsubscribe?.dispose();
      const model = editor.current?.getModel();
      editor.current?.dispose();
      model?.dispose();
      editor.current = null;
      engine.current = null;
    };
  }, []);
  useEffect(() => {
    const instance = editor.current;
    const monaco = engine.current;
    if (!instance || !monaco) return;
    programmatic.current = true;
    const model = instance.getModel();
    const uri = monaco.Uri.from({ scheme: "file", path: `/${workspace}/${path}` });
    if (model?.uri.toString() !== uri.toString()) {
      instance.setModel(
        monaco.editor.createModel(
          value,
          editorLanguage(path, monaco.languages.getLanguages()),
          uri,
        ),
      );
      model?.dispose();
    } else if (instance.getValue() !== value) {
      const view = instance.saveViewState();
      instance.setValue(value);
      if (view) instance.restoreViewState(view);
    }
    instance.updateOptions({ readOnly });
    monaco.editor.setTheme(theme === "dark" ? "vs-dark" : "vs");
    programmatic.current = false;
  }, [workspace, path, value, readOnly, theme]);
  return (
    <div
      className="code-editor-host"
      data-language={
        engine.current ? editorLanguage(path, engine.current.languages.getLanguages()) : undefined
      }
    >
      {!ready && !failed && (
        <p className="editor-loading" role="status">
          Loading editor…
        </p>
      )}
      {failed ? (
        <textarea
          className="code-editor-fallback"
          aria-label="File contents"
          spellCheck={false}
          value={value}
          readOnly={readOnly}
          onChange={(event) => onChange(event.target.value)}
        />
      ) : (
        <div ref={container} className="code-editor-mount" />
      )}
    </div>
  );
}
