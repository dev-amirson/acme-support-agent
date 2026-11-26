import { rateLimit, type Options as RateLimitOptions } from 'express-rate-limit';
import type { ApiErrorBody } from '@acme/contracts';

/** Shared limiter factory: our error envelope, standard RateLimit headers, proxy-aware IPs. */
export function limiter(opts: Partial<RateLimitOptions> & { windowMs: number; limit: number }) {
  return rateLimit({
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    ...opts,
    handler: (_req, res, _next, options) => {
      const body: ApiErrorBody = {
        error: { code: 'RATE_LIMITED', message: 'Too many requests — please slow down and try again shortly.', retryable: true },
      };
      res.status(options.statusCode).json(body);
    },
  });
}
