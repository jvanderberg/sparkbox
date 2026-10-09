// Preloaded into Node programs started from the Terminal (NODE_OPTIONS).
// This runtime loses what Node's stdout and stderr streams write into a
// shell pipe (`node x.js | head` printed nothing), while direct writes to
// the file descriptor arrive, so when they are not the terminal the
// streams write synchronously instead.
const { writeSync } = require("node:fs");

for (const [stream, fd] of [
  [process.stdout, 1],
  [process.stderr, 2],
]) {
  if (stream.isTTY) continue;
  stream.write = (chunk, encoding, callback) => {
    if (typeof encoding === "function") {
      callback = encoding;
      encoding = undefined;
    }
    const data = typeof chunk === "string" ? Buffer.from(chunk, encoding) : Buffer.from(chunk);
    let offset = 0;
    while (offset < data.length) {
      try {
        offset += writeSync(fd, data, offset, data.length - offset);
      } catch (error) {
        if (error?.code === "EAGAIN") continue;
        // The reader has gone (`| head`): drop the rest, as a closed pipe would.
        if (error?.code === "EPIPE") break;
        throw error;
      }
    }
    if (callback) process.nextTick(callback);
    return true;
  };
}
