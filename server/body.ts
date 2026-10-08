/**
 * Request body reader with a size cap. An oversized body is drained and
 * refused with `BodyTooLargeError` rather than cut off: destroying the socket
 * would leave the client (and Fly's proxy in front of the host) with no
 * response at all, which surfaces as a bodiless 502 that nobody can diagnose.
 */
import type { IncomingMessage } from "node:http";

export class BodyTooLargeError extends Error {
  readonly limit: number;
  constructor(limit: number) {
    super(`body larger than ${limit} bytes`);
    this.name = "BodyTooLargeError";
    this.limit = limit;
  }
}

export function readBody(request: IncomingMessage, limit = 2 * 1024 * 1024): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let refused = false;
    request.on("data", (chunk: Buffer) => {
      if (refused) return;
      size += chunk.length;
      if (size > limit) {
        refused = true;
        chunks.length = 0;
        // Keep draining so the refusal can be sent and read before the
        // connection closes.
        reject(new BodyTooLargeError(limit));
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (!refused) resolve(Buffer.concat(chunks));
    });
    request.on("error", reject);
  });
}
