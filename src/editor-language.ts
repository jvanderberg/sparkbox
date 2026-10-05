import type { languages } from "monaco-editor";

// Use Monaco's own filename/extension catalog, so every bundled lazy grammar is
// reachable. Keep only aliases that the upstream catalog doesn't supply here.
const aliases: Record<string, string> = {
  ".mts": "typescript",
  ".cts": "typescript",
  ".jsonc": "json",
  ".geojson": "json",
  ".jsonl": "json",
  ".ndjson": "json",
  ".zsh": "shell",
  ".ksh": "shell",
  ".bashrc": "shell",
  ".bash_profile": "shell",
  ".zshrc": "shell",
  ".zprofile": "shell",
  ".profile": "shell",
  ".toml": "ini", // Closest bundled grammar; Monaco has no TOML tokenizer.
  ".vue": "html",
  ".svelte": "html",
};

export function editorLanguage(
  path: string,
  catalog: readonly languages.ILanguageExtensionPoint[],
) {
  const filename = path.replaceAll("\\", "/").split("/").pop()?.toLowerCase() ?? "";
  // Exact filenames take precedence over suffixes (Dockerfile, .editorconfig…).
  for (const language of catalog) {
    if (language.filenames?.some((name) => name.toLowerCase() === filename)) return language.id;
  }
  if (/^(dockerfile|containerfile)(\.|$)/.test(filename)) return "dockerfile";
  let match = { id: "plaintext", length: 0 };
  for (const language of catalog) {
    for (const extension of language.extensions ?? []) {
      if (filename.endsWith(extension.toLowerCase()) && extension.length > match.length) {
        match = { id: language.id, length: extension.length };
      }
    }
  }
  for (const [extension, id] of Object.entries(aliases)) {
    if (filename.endsWith(extension) && extension.length > match.length) {
      match = { id, length: extension.length };
    }
  }
  return match.id;
}
