import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Signed, stateless session tokens: `<id>.<expires>.<signature>`.
 *
 * A scope separates token kinds that share the secret: invite tokens (the
 * default, signed over the bare body so tokens minted earlier stay valid) and
 * short-lived relay tickets, which carry the invite's id so budgets stay per
 * invite but cannot be used in place of the invite itself.
 */
export function mintToken(
  secret: string,
  ttlDays = 90,
  options: { scope?: string; id?: string } = {},
) {
  const id = options.id ?? randomBytes(9).toString("base64url");
  const expires = Date.now() + ttlDays * 86_400_000;
  const body = `${id}.${expires}`;
  return `${body}.${sign(secret, body, options.scope)}`;
}

function sign(secret: string, body: string, scope?: string) {
  return createHmac("sha256", secret)
    .update(scope ? `${scope}:${body}` : body)
    .digest("base64url");
}

export function verifyToken(secret: string, token: string | undefined | null, scope?: string) {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [id, expires, signature] = parts as [string, string, string];
  const expected = sign(secret, `${id}.${expires}`, scope);
  if (expected.length !== signature.length) return null;
  if (!timingSafeEqual(Buffer.from(expected), Buffer.from(signature))) return null;
  if (Number(expires) < Date.now()) return null;
  return { id, expires: Number(expires) };
}

/** Per-key counters that reset daily. Memory only; a restart forgives everyone. */
export class DailyCounter {
  private day = "";
  private counts = new Map<string, number>();
  private roll() {
    const today = new Date().toISOString().slice(0, 10);
    if (today !== this.day) {
      this.day = today;
      this.counts.clear();
    }
  }
  add(key: string, amount = 1) {
    this.roll();
    const next = (this.counts.get(key) ?? 0) + amount;
    this.counts.set(key, next);
    return next;
  }
  get(key: string) {
    this.roll();
    return this.counts.get(key) ?? 0;
  }
}
