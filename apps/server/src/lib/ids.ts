import { randomBytes, randomUUID } from 'node:crypto';

/** Prefixed, sortable-enough, URL-safe ids. Prefixes make logs and traces self-describing. */
export function newId(prefix: 'turn' | 'msg' | 'span' | 'step' | 'call'): string {
  const time = Date.now().toString(36);
  return `${prefix}_${time}${randomBytes(5).toString('hex')}`;
}

export function newSessionId(): string {
  return randomUUID();
}

/** Human-friendly references for things a customer may read aloud (tickets, refunds). */
export function newReference(prefix: 'ESC' | 'RF'): string {
  const n = randomBytes(3).readUIntBE(0, 3) % 900_000;
  return `${prefix}-${(100_000 + n).toString()}`;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function isSessionId(value: string): boolean {
  return UUID_RE.test(value);
}
