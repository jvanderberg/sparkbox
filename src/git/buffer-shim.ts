/**
 * isomorphic-git reaches for Node's Buffer global. Browsers have none, so
 * this module installs one before isomorphic-git is evaluated; import it
 * first wherever isomorphic-git is imported.
 */
import { Buffer } from "buffer";

const scope = globalThis as { Buffer?: typeof Buffer };
if (!scope.Buffer) scope.Buffer = Buffer;
