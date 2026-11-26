export { cn as cx } from './utils';

export const fmtMs = (ms: number | null | undefined): string =>
  ms === null || ms === undefined ? '—' : ms >= 1000 ? `${(ms / 1000).toFixed(ms >= 10_000 ? 0 : 1)}s` : `${Math.round(ms)}ms`;

export const fmtUsd = (usd: number | null | undefined): string => {
  if (usd === null || usd === undefined) return '—';
  if (usd === 0) return '$0';
  return usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(3)}`;
};

export const fmtTokens = (n: number | null | undefined): string =>
  n === null || n === undefined ? '—' : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
