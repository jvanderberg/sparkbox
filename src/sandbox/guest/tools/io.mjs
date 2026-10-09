// Input and output for the Sparkbox shell tools in .sparkbox/tools.
//
// The sandbox's Node (Edge.js) loses whatever process.stdout.write or
// console.log sends into a shell pipe, and never ends a piped stdin stream,
// so the tools write and read file descriptors directly: that works for
// pipes, files and the terminal alike.
import { readFileSync, writeSync } from "node:fs";
import { basename } from "node:path";

/**
 * Thrown by `exit`. In this runtime process.exit only records the code:
 * the code after it keeps running until the current task ends, so `exit`
 * throws to stop it, and this handler swallows the throw.
 */
class Exit extends Error {}
process.on("uncaughtException", (error) => {
  if (error instanceof Exit) return;
  writeAll(2, `${program}: ${error?.stack ?? error}\n`);
  exit(2);
});

/** Exit now with `code`. Never returns. */
export function exit(code) {
  process.exit(code);
  throw new Exit(`exit ${code}`);
}

/** True for the throw `exit` makes, which top-level catches should pass on. */
export const isExit = (error) => error instanceof Exit;

/** Set once the reader of stdout has gone; later output is dropped. */
let closed = false;

function writeAll(fd, data) {
  if (closed && fd === 1) return;
  const bytes = typeof data === "string" ? Buffer.from(data) : data;
  let offset = 0;
  while (offset < bytes.length) {
    try {
      offset += writeSync(fd, bytes, offset, bytes.length - offset);
    } catch (error) {
      // A non-blocking pipe that is full: try again.
      if (error?.code === "EAGAIN") continue;
      // The reader went away (`| head`): stop quietly, as coreutils do.
      if (error?.code === "EPIPE") {
        closed = true;
        exit(0);
      }
      throw error;
    }
  }
}

/** Write to stdout. */
export const out = (data) => writeAll(1, data);
/** Write to stderr. */
export const err = (data) => writeAll(2, data);

/** All of stdin, or an empty buffer when there is none. */
export function readStdin() {
  try {
    return readFileSync(0);
  } catch {
    return Buffer.alloc(0);
  }
}

/**
 * True when stdout is the Sparkbox Terminal. The runtime reports a
 * terminal for the agent's commands too, so the Terminal also sets
 * SPARKBOX_TERMINAL; paging, colour and the editor depend on both.
 */
export const isTerminal = Boolean(process.stdout.isTTY && process.env.SPARKBOX_TERMINAL);

/** The command's name, for messages: `find: ...`. */
export const program = basename(process.argv[1] ?? "tool").replace(/\.mjs$/, "");

/** Print `program: message` to stderr and exit with `code`. Never returns. */
export function fail(message, code = 1) {
  err(`${program}: ${message}\n`);
  exit(code);
}
