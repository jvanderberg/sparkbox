import * as monaco from "monaco-editor";
import EditorWorker from "monaco-editor/editor/editor.worker?worker";
import * as cssGrammar from "monaco-editor/languages/definitions/css/css";
import * as htmlGrammar from "monaco-editor/languages/definitions/html/html";
import * as javascriptGrammar from "monaco-editor/languages/definitions/javascript/javascript";
import * as typescriptGrammar from "monaco-editor/languages/definitions/typescript/typescript";
import CssWorker from "monaco-editor/languages/features/css/css.worker?worker";
import HtmlWorker from "monaco-editor/languages/features/html/html.worker?worker";
import JsonWorker from "monaco-editor/languages/features/json/json.worker?worker";
import TypeScriptWorker from "monaco-editor/languages/features/typescript/ts.worker?worker";

self.MonacoEnvironment = {
  getWorker(_moduleId, label) {
    if (label === "typescript" || label === "javascript") return new TypeScriptWorker();
    if (label === "json") return new JsonWorker();
    if (["css", "scss", "less"].includes(label)) return new CssWorker();
    if (["html", "handlebars", "razor"].includes(label)) return new HtmlWorker();
    return new EditorWorker();
  },
};

// Monaco permanently caches a failed lazy grammar download. Load the small
// common web grammars with this already-lazy editor module and register them
// directly, so a failed secondary HTML chunk cannot leave a working editor gray.
for (const [id, grammar] of [
  ["html", htmlGrammar],
  ["css", cssGrammar],
  ["javascript", javascriptGrammar],
  ["typescript", typescriptGrammar],
] as const) {
  monaco.languages.setMonarchTokensProvider(id, grammar.language);
  monaco.languages.setLanguageConfiguration(id, grammar.conf);
}
// This browser has one file at a time, rather than a complete TS dependency graph.
// Report syntax errors without falsely reporting absent React/project declarations.
monaco.typescript.typescriptDefaults.setDiagnosticsOptions({ noSemanticValidation: true });
monaco.typescript.javascriptDefaults.setDiagnosticsOptions({ noSemanticValidation: true });
monaco.typescript.typescriptDefaults.setCompilerOptions({
  jsx: monaco.typescript.JsxEmit.ReactJSX,
  allowNonTsExtensions: true,
});

export { monaco };
