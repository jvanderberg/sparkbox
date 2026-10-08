/**
 * Bounded waits for the sandbox runtime. When the SDK's worker pool dies
 * (an uncaught error inside a guest crashes a browser worker and the SDK
 * closes the pool), new processes neither start nor fail: their promises
 * hang. Every spawn and wait therefore gets a deadline, and a hang is
 * reported as RuntimeHung so the sandbox can rebuild itself.
 */
export class RuntimeHung extends Error {
  override name = "RuntimeHung";
  constructor(what: string, ms: number) {
    super(`The sandbox runtime did not ${what} within ${Math.round(ms / 1000)}s.`);
  }
}

export function deadline<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const expiry = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new RuntimeHung(what, ms)), ms);
  });
  return Promise.race([work, expiry]).finally(() => {
    if (timer) clearTimeout(timer);
  }) as Promise<T>;
}
