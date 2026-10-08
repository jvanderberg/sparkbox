// Sparkbox replacement for Rollup's native parser: the same ESTree shape
// from acorn, which is plain JavaScript. Production builds use real Rollup
// outside the sandbox.
import { Parser } from "acorn";

function parseWith(code, options) {
  const opts = options || {};
  return Parser.parse(code, {
    ecmaVersion: "latest",
    sourceType: "module",
    allowHashBang: true,
    allowAwaitOutsideFunction: true,
    allowImportExportEverywhere: false,
    allowReturnOutsideFunction: Boolean(opts.allowReturnOutsideFunction),
    locations: false,
    ranges: false,
  });
}

export function parseAst(code, options) {
  return parseWith(code, options);
}

export async function parseAstAsync(code, options) {
  return parseWith(code, options);
}
