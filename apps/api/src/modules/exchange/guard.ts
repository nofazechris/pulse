/**
 * Testnet-only enforcement. There is deliberately NO production mode: any URL other than the
 * approved Binance Spot Testnet hosts makes initialisation fail.
 */
export const APPROVED_REST_HOST = 'testnet.binance.vision';
export const APPROVED_STREAM_HOST = 'stream.testnet.binance.vision';

export class NonTestnetUrlError extends Error {
  constructor(what: string) {
    super(`Refusing ${what}: only the Binance Spot Testnet is permitted.`);
    this.name = 'NonTestnetUrlError';
  }
}

function parseUrl(raw: string, what: string): URL {
  try {
    return new URL(raw);
  } catch {
    throw new NonTestnetUrlError(`${what} (unparseable)`);
  }
}

/** Returns the canonical REST base (`https://testnet.binance.vision/api`) or throws. */
export function assertTestnetRestUrl(raw: string): string {
  const u = parseUrl(raw, 'REST URL');
  const ok =
    u.protocol === 'https:' &&
    u.hostname === APPROVED_REST_HOST &&
    u.port === '' &&
    u.username === '' &&
    u.password === '' &&
    u.search === '' &&
    u.hash === '' &&
    u.pathname.replace(/\/+$/, '') === '/api';
  if (!ok) throw new NonTestnetUrlError('REST URL');
  return `https://${APPROVED_REST_HOST}/api`;
}

/** Returns the canonical stream base or throws. */
export function assertTestnetStreamUrl(raw: string): string {
  const u = parseUrl(raw, 'stream URL');
  const ok =
    u.protocol === 'wss:' &&
    u.hostname === APPROVED_STREAM_HOST &&
    u.port === '' &&
    u.username === '' &&
    u.password === '' &&
    u.search === '' &&
    u.hash === '' &&
    ['/stream', '/ws'].includes(u.pathname.replace(/\/+$/, ''));
  if (!ok) throw new NonTestnetUrlError('stream URL');
  return `wss://${APPROVED_STREAM_HOST}${u.pathname.replace(/\/+$/, '')}`;
}
