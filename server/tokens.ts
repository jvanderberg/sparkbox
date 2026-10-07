import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/** Signed, stateless session tokens: `<id>.<expires>.<signature>`. */
export function mintToken(secret: string, ttlDays = 90) {
  const id = randomBytes(9).toString("base64url");
  const expires = Date.now() + ttlDays * 86_400_000;
  const body = `${id}.${expires}`;
  return `${body}.${sign(secret, body)}`;
}

function sign(secret: string, body: string) {
  return createHmac("sha256", secret).update(body).digest("base64url");
}

export function verifyToken(secret: string, token: string | undefined | null) {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [id, expires, signature] = parts as [string, string, string];
  const expected = sign(secret, `${id}.${expires}`);
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
