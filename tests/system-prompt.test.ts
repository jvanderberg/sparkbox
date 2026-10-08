import { describe, expect, it } from "vitest";
import { systemPrompt } from "../src/agent/system-prompt.ts";
import { starterTemplate } from "../src/template.ts";

const base = { provider: "anthropic" as const, files: ["PROJECT.md"], previewPort: 8080 };

describe("starter template", () => {
  it("seeds only the brief, leaving the stack to the agent", () => {
    expect(Object.keys(starterTemplate("Demo"))).toEqual(["PROJECT.md"]);
    expect(starterTemplate("Demo")["PROJECT.md"]).toContain("# Demo");
  });
});

describe("system prompt stack rule", () => {
  it("requires React, TypeScript, Vite and Tailwind when installs can run", () => {
    const prompt = systemPrompt({ ...base, networkEnabled: true });
    expect(prompt).toContain("Stack: React + TypeScript 5 + Vite 7 + Tailwind CSS v3");
    expect(prompt).toContain("This is a rule, not a preference");
    expect(prompt).toContain("A new project holds only PROJECT.md");
    expect(prompt).not.toMatch(/default stack/i);
  });
  it("keeps to plain HTML when nothing can be installed", () => {
    const prompt = systemPrompt({ ...base, networkEnabled: false });
    expect(prompt).toContain("Stack: plain HTML, CSS and JavaScript ES modules");
    expect(prompt).not.toContain("Stack: React");
  });
});

describe("system prompt sharing", () => {
  it("explains git, nudges once toward GitHub when not connected, and warns about the Pages base path", () => {
    const prompt = systemPrompt({ ...base, networkEnabled: true });
    expect(prompt).toContain("git works here");
    expect(prompt).toContain("GitHub: not connected");
    expect(prompt).toContain('"Back up to GitHub"');
    expect(prompt).toContain("import.meta.env.BASE_URL");
    expect(prompt).not.toContain("Save version");
  });
  it("reports the repository, site and last build when connected", () => {
    const prompt = systemPrompt({
      ...base,
      networkEnabled: true,
      github: {
        connected: true,
        repository: "ada/demo",
        siteUrl: "https://ada.github.io/demo/",
        lastBuild: { state: "failed", detail: "tsc exit 2" },
      },
    });
    expect(prompt).toContain("backs up to ada/demo");
    expect(prompt).toContain("Published at https://ada.github.io/demo/");
    expect(prompt).toContain("FAILED: tsc exit 2");
    expect(prompt).not.toContain("GitHub: not connected");
  });
});
