import { ZodError } from 'zod';
import {
  ExchangeNotConfiguredError, ExchangeRejectedError, ExchangeUnavailableError,
} from '../modules/exchange/types';

/** Application error with a stable machine code and a message that is safe to show to the user. */
export class AppError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly details?: unknown) {
    super(message);
    this.name = 'AppError';
  }
}

export interface NormalizedError {
  status: number;
  code: string;
  message: string;
  details?: unknown;
}

/** Maps any thrown value to a safe response. Never leaks stack traces, credentials or driver text. */
export function normalizeError(err: unknown): NormalizedError {
  if (err instanceof AppError) {
    return { status: err.status, code: err.code, message: err.message, ...(err.details !== undefined ? { details: err.details } : {}) };
  }
  if (err instanceof ZodError) {
    return {
      status: 400, code: 'VALIDATION_ERROR', message: 'The request is invalid.',
      details: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    };
  }
  if (err instanceof ExchangeNotConfiguredError) {
    return { status: 503, code: 'EXCHANGE_NOT_CONFIGURED', message: 'Exchange credentials are not configured.' };
  }
  if (err instanceof ExchangeUnavailableError) {
    return { status: 503, code: 'EXCHANGE_UNAVAILABLE', message: 'Binance Testnet is unavailable right now.' };
  }
  if (err instanceof ExchangeRejectedError) {
    return { status: 422, code: 'EXCHANGE_REJECTED', message: `Binance rejected the request: ${err.exchangeMessage}` };
  }
  const e = err as { statusCode?: number; code?: string };
  if (typeof e?.statusCode === 'number' && e.statusCode >= 400 && e.statusCode < 500) {
    return { status: e.statusCode, code: e.statusCode === 429 ? 'RATE_LIMITED' : 'BAD_REQUEST', message: e.statusCode === 429 ? 'Too many requests.' : 'The request could not be processed.' };
  }
  return { status: 500, code: 'INTERNAL_ERROR', message: 'Something went wrong on our side.' };
}
