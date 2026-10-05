// Adapted from T3 Code ChatMarkdown.tsx UncachedShikiCodeBlock, MIT; see LICENSE.txt.
// Keep the source incremental WASM highlighter and Pierre palettes; render a plain
// code fallback during loading or if a grammar/engine fails instead of suspending the thread.
import type { DiffsHighlighter } from "@pierre/diffs";
import { useEffect, useMemo, useState } from "react";
import { useSystemTheme } from "../../theme.ts";
import { resolveDiffThemeName } from "./diffTheme.ts";
import { HighlightedCodeLines } from "./HighlightedCodeLines.tsx";
import { createIncrementalHighlightedDocument } from "./incrementalHighlighting.ts";
import { getSyntaxHighlighterPromise } from "./syntaxHighlighting.ts";

export function HighlightedCode({ code, language }: { code: string; language: string }) {
  const themeName = resolveDiffThemeName(useSystemTheme());
  const [highlighter, setHighlighter] = useState<DiffsHighlighter | null>(null);
  useEffect(() => {
    let current = true;
    void getSyntaxHighlighterPromise(language)
      .then((value) => {
        if (current) setHighlighter(value);
      })
      .catch(() => {
        if (current) setHighlighter(null);
      });
    return () => {
      current = false;
    };
  }, [language]);
  const incremental = useMemo(
    () =>
      highlighter ? createIncrementalHighlightedDocument(highlighter, language, themeName) : null,
    [highlighter, language, themeName],
  );
  const highlighted = useMemo(() => {
    if (!incremental || !highlighter) return null;
    try {
      return incremental(code);
    } catch {
      try {
        return highlighter.codeToHast(code, { lang: "text", theme: themeName });
      } catch {
        return null;
      }
    }
  }, [incremental, highlighter, code, themeName]);
  return (
    <div
      className="chat-markdown-shiki"
      data-highlight-theme={themeName}
      data-highlighted={highlighted ? "true" : "false"}
    >
      {highlighted ? (
        <HighlightedCodeLines root={highlighted} />
      ) : (
        <pre>
          <code className={`language-${language}`}>{code}</code>
        </pre>
      )}
    </div>
  );
}
