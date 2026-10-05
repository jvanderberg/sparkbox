/**
 * Codex "V4A" patch format, as used by the OpenAI Responses API `apply_patch`
 * tool. The grammar (from openai/codex, codex-rs/apply-patch/src/parser.rs):
 *
 *   start: "*** Begin Patch" hunk+ "*** End Patch"
 *   add_hunk:    "*** Add File: " filename ("+" line)+
 *   delete_hunk: "*** Delete File: " filename
 *   update_hunk: "*** Update File: " filename ("*** Move to: " filename)? change
 *   change: (("@@" | "@@ " context) | ("+" | "-" | " ") line)+ ("*** End of File")?
 *
 * The Responses API hands each hunk over separately as an `operation`, so
 * `applyUpdate` takes just the change body of one update hunk.
 */

export type UpdateChunk = {
  context: string | null;
  oldLines: string[];
  newLines: string[];
  endOfFile: boolean;
};

export type PatchHunk =
  | { type: "add"; path: string; contents: string }
  | { type: "delete"; path: string }
  | { type: "update"; path: string; movePath: string | null; chunks: UpdateChunk[] };

const BEGIN = "*** Begin Patch";
const END = "*** End Patch";
const ADD = "*** Add File: ";
const DELETE = "*** Delete File: ";
const UPDATE = "*** Update File: ";
const MOVE = "*** Move to: ";
const EOF_MARK = "*** End of File";

/** Parse the change body of one update hunk into chunks. */
export function parseUpdateBody(body: string): UpdateChunk[] {
  const lines = body.split("\n");
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  const chunks: UpdateChunk[] = [];
  const open = (context: string | null) => {
    const chunk: UpdateChunk = { context, oldLines: [], newLines: [], endOfFile: false };
    chunks.push(chunk);
    return chunk;
  };
  let current: UpdateChunk | undefined;
  for (const [index, line] of lines.entries()) {
    if (line === "@@" || line.startsWith("@@ ")) {
      current = open(line === "@@" ? null : line.slice(3));
      continue;
    }
    if (line.trim() === EOF_MARK) {
      current ??= open(null);
      current.endOfFile = true;
      continue;
    }
    if (line === END || line === BEGIN) continue;
    current ??= open(null);
    const marker = line[0];
    const text = line.slice(1);
    if (marker === "+") current.newLines.push(text);
    else if (marker === "-") current.oldLines.push(text);
    else if (marker === " ") {
      current.oldLines.push(text);
      current.newLines.push(text);
    } else if (line === "") {
      // Lenient: a blank line stands for an empty context line.
      current.oldLines.push("");
      current.newLines.push("");
    } else throw new Error(`Invalid patch line ${index + 1}: ${line}`);
  }
  return chunks.filter((chunk) => chunk.oldLines.length || chunk.newLines.length || chunk.context);
}

/** Parse a full `*** Begin Patch` envelope into hunks. */
export function parsePatch(patch: string): PatchHunk[] {
  const lines = patch.replace(/\r\n/g, "\n").split("\n");
  let index = 0;
  while (index < lines.length && lines[index]?.trim() === "") index++;
  if (lines[index]?.trim() !== BEGIN) throw new Error("Patch must start with *** Begin Patch");
  index++;
  const hunks: PatchHunk[] = [];
  const isHeader = (line: string) =>
    line.startsWith(ADD) ||
    line.startsWith(DELETE) ||
    line.startsWith(UPDATE) ||
    line.trim() === END;
  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (line.trim() === END) break;
    if (line.startsWith(ADD)) {
      const path = line.slice(ADD.length).trim();
      index++;
      const content: string[] = [];
      while (index < lines.length && !isHeader(lines[index] ?? "")) {
        const added = lines[index] ?? "";
        if (!added.startsWith("+")) throw new Error(`Invalid add line ${index + 1}: ${added}`);
        content.push(added.slice(1));
        index++;
      }
      hunks.push({ type: "add", path, contents: content.length ? `${content.join("\n")}\n` : "" });
      continue;
    }
    if (line.startsWith(DELETE)) {
      hunks.push({ type: "delete", path: line.slice(DELETE.length).trim() });
      index++;
      continue;
    }
    if (line.startsWith(UPDATE)) {
      const path = line.slice(UPDATE.length).trim();
      index++;
      let movePath: string | null = null;
      if (lines[index]?.startsWith(MOVE)) {
        movePath = (lines[index] ?? "").slice(MOVE.length).trim();
        index++;
      }
      const body: string[] = [];
      while (index < lines.length && !isHeader(lines[index] ?? "")) {
        body.push(lines[index] ?? "");
        index++;
      }
      hunks.push({ type: "update", path, movePath, chunks: parseUpdateBody(body.join("\n")) });
      continue;
    }
    if (line.trim() === "") {
      index++;
      continue;
    }
    throw new Error(`Unexpected patch line ${index + 1}: ${line}`);
  }
  return hunks;
}

function findSequence(haystack: string[], needle: string[], start: number, end = false): number {
  if (!needle.length) return start;
  if (end) {
    const at = haystack.length - needle.length;
    return at >= start && needle.every((line, i) => haystack[at + i] === line) ? at : -1;
  }
  const normalize = (line: string) => line.trimEnd();
  const loose = (line: string) => line.trim();
  for (const compare of [(a: string) => a, normalize, loose]) {
    for (let at = start; at + needle.length <= haystack.length; at++) {
      let matched = true;
      for (let i = 0; i < needle.length; i++) {
        if (compare(haystack[at + i] ?? "") !== compare(needle[i] ?? "")) {
          matched = false;
          break;
        }
      }
      if (matched) return at;
    }
  }
  return -1;
}

/** Apply update chunks to file text. Throws when context cannot be located. */
export function applyUpdate(original: string, chunks: UpdateChunk[]): string {
  const lines = original.split("\n");
  const trailingNewline = original.endsWith("\n");
  if (trailingNewline) lines.pop();
  const output: string[] = [];
  let cursor = 0;
  for (const chunk of chunks) {
    let searchFrom = cursor;
    if (chunk.context !== null) {
      const at = findSequence(lines, [chunk.context], cursor);
      if (at < 0) throw new Error(`Could not find context line: ${chunk.context}`);
      searchFrom = at + 1;
    }
    const at = findSequence(lines, chunk.oldLines, searchFrom, chunk.endOfFile);
    if (at < 0)
      throw new Error(
        `Could not find the lines to replace${chunk.context ? ` after "${chunk.context}"` : ""}:\n${chunk.oldLines.join("\n")}`,
      );
    output.push(...lines.slice(cursor, at), ...chunk.newLines);
    cursor = at + chunk.oldLines.length;
  }
  output.push(...lines.slice(cursor));
  return output.join("\n") + (trailingNewline || !original ? "\n" : "");
}
