import { describe, expect, it } from "vitest";
import {
  isSecretName,
  redactSecrets,
  substituteSecrets,
  withSecrets,
} from "../src/agent/secrets.ts";
import { MemorySandbox } from "../src/sandbox/memory.ts";

/** Builds a ${NAME} placeholder without tripping the template-literal lint. */
const placeholder = (name: string) => `$\{${name}}`;

describe("secret names", () => {
  it("accepts environment-variable names only", () => {
    for (const name of ["API_KEY", "VITE_CTA_TRAIN_API_KEY", "_x", "a1"])
      expect(isSecretName(name)).toBe(true);
    for (const name of ["", "1abc", "my-key", "has space", "k=v"])
      expect(isSecretName(name)).toBe(false);
  });
});

describe("redactSecrets", () => {
  it("replaces values with the name, longest first, and ignores short values", () => {
    const secrets = { API_KEY: "abcd1234", LONG: "abcd1234-extended", TINY: "ab" };
    expect(redactSecrets("key=abcd1234-extended and abcd1234 and ab", secrets)).toBe(
      "key=[LONG] and [API_KEY] and ab",
    );
  });
});

describe("substituteSecrets", () => {
  it("fills placeholders and leaves unknown ones alone", () => {
    expect(
      substituteSecrets(`https://x/?key=${placeholder("API_KEY")}&id=${placeholder("ID")}`, {
        API_KEY: "s3cret",
      }),
    ).toBe(`https://x/?key=s3cret&id=${placeholder("ID")}`);
  });
});

describe("withSecrets", () => {
  it("redacts command output, live chunks and file reads", async () => {
    const sandbox = new MemorySandbox({}, async (command, options) => {
      const text = `${command.replace(/^echo /, "")}\n`;
      options?.onOutput?.(text, "stdout");
      return { stdout: text, stderr: "", exitCode: 0, timedOut: false };
    });
    await sandbox.writeFile(".env.local", "VITE_KEY=s3cret-value\n");
    const wrapped = withSecrets(sandbox, { VITE_KEY: "s3cret-value" });
    expect(await wrapped.readText(".env.local")).toBe("VITE_KEY=[VITE_KEY]\n");
    const chunks: string[] = [];
    const result = await wrapped.exec("echo s3cret-value", {
      onOutput: (chunk) => chunks.push(chunk),
    });
    expect(result.stdout).not.toContain("s3cret-value");
    expect(result.stdout).toContain("[VITE_KEY]");
    expect(chunks.join("")).not.toContain("s3cret-value");
  });
  it("returns the sandbox itself when there is nothing to redact", () => {
    const sandbox = new MemorySandbox();
    expect(withSecrets(sandbox, {})).toBe(sandbox);
    expect(withSecrets(sandbox, { SHORT: "ab" })).toBe(sandbox);
  });
});
