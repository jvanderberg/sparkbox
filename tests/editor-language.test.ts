import { describe, expect, it } from "vitest";
import { editorLanguage } from "../src/editor-language.ts";

const catalog = [
  { id: "html", extensions: [".html", ".htm", ".xhtml"] },
  { id: "typescript", extensions: [".ts", ".tsx"] },
  { id: "javascript", extensions: [".js", ".jsx", ".cjs"] },
  { id: "dockerfile", extensions: [".dockerfile"], filenames: ["Dockerfile"] },
  { id: "ini", extensions: [".ini"], filenames: [".editorconfig"] },
  { id: "xml", extensions: [".xml", ".svg"] },
  { id: "python", extensions: [".py"] },
];

describe("editor language selection", () => {
  it("uses every upstream language association, case-insensitively, on the basename only", () => {
    expect(editorLanguage("web/INDEX.XHTML", catalog)).toBe("html");
    expect(editorLanguage("web\\image.SVG", catalog)).toBe("xml");
    expect(editorLanguage("src/app.cjs", catalog)).toBe("javascript");
    expect(editorLanguage("src/app.tsx", catalog)).toBe("typescript");
    expect(editorLanguage("folder.py/README", catalog)).toBe("plaintext");
    expect(editorLanguage("notes.unknown", catalog)).toBe("plaintext");
    expect(
      editorLanguage("new.lang", [...catalog, { id: "new-language", extensions: [".lang"] }]),
    ).toBe("new-language");
  });
  it("recognizes named configuration files and common missing aliases", () => {
    for (const name of ["Dockerfile", "dockerfile.dev", "Containerfile", "Containerfile.prod"]) {
      expect(editorLanguage(`deploy/${name}`, catalog)).toBe("dockerfile");
    }
    expect(editorLanguage(".editorconfig", catalog)).toBe("ini");
    expect(editorLanguage("analysis.geojson", catalog)).toBe("json");
    expect(editorLanguage("tsconfig.jsonc", catalog)).toBe("json");
    expect(editorLanguage("app.mts", catalog)).toBe("typescript");
    expect(editorLanguage("app.cts", catalog)).toBe("typescript");
    expect(editorLanguage(".zshrc", catalog)).toBe("shell");
    expect(editorLanguage("component.vue", catalog)).toBe("html");
    expect(editorLanguage("component.svelte", catalog)).toBe("html");
  });
  it("prefers exact names and then the longest extension", () => {
    expect(
      editorLanguage("special.html", [...catalog, { id: "special", filenames: ["special.html"] }]),
    ).toBe("special");
    expect(
      editorLanguage("template.blade.php", [
        { id: "php", extensions: [".php"] },
        { id: "blade", extensions: [".blade.php"] },
      ]),
    ).toBe("blade");
    // An upstream exact TOML grammar supersedes our explicitly limited INI fallback.
    expect(
      editorLanguage("pyproject.toml", [...catalog, { id: "toml", extensions: [".toml"] }]),
    ).toBe("toml");
  });
});
