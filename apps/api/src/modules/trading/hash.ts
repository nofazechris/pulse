import { createHash, timingSafeEqual } from 'node:crypto';

/** The material terms an approval is bound to. Changing ANY of these changes the hash. */
export interface MaterialTerms {
  userId: string;
  sessionId: string;
  symbol: string;
  side: string;
  orderType: string;
  quantity: string | null;
  quoteOrderQty: string | null;
  price: string | null;
  environment: string;
  expiresAt: string;
}

export function proposalHash(t: MaterialTerms): string {
  // Fixed-order array => canonical serialisation independent of object key order.
  const canonical = JSON.stringify([
    t.userId, t.sessionId, t.symbol, t.side, t.orderType, t.quantity, t.quoteOrderQty, t.price, t.environment, t.expiresAt,
  ]);
  return createHash('sha256').update(canonical).digest('hex');
}

export function hashesEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}
