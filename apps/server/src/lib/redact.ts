/**
 * PII scrubbing for anything that is persisted to traces or logs. Conversation content itself is
 * kept (it's the product), but card numbers / secrets accidentally pasted by users are not.
 */
const PATTERNS: Array<[RegExp, string]> = [
  [/\b(?:\d[ -]?){13,19}\b/g, '[REDACTED_CARD]'],
  [/\bsk-[A-Za-z0-9_-]{16,}\b/g, '[REDACTED_KEY]'],
  [/\b\d{3}-\d{2}-\d{4}\b/g, '[REDACTED_SSN]'],
];

export function redactText(text: string): string {
  let out = text;
  for (const [re, replacement] of PATTERNS) out = out.replace(re, replacement);
  return out;
}

export function redactDeep<T>(value: T): T {
  if (typeof value === 'string') return redactText(value) as T;
  if (Array.isArray(value)) return value.map((v) => redactDeep(v)) as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, redactDeep(v)]),
    ) as T;
  }
  return value;
}

export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
