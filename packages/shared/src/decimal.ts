/**
 * Exact decimal arithmetic on BigInt (18 fractional digits). No floating point is ever used for
 * money, quantities or prices. Values are plain decimal strings at every boundary.
 */
const SCALE_DIGITS = 18;
const ONE = 10n ** BigInt(SCALE_DIGITS);
const DEC_RE = /^-?\d+(\.\d+)?$/;

export type Dec = bigint;

export function isDecimalString(s: unknown): s is string {
  return typeof s === 'string' && DEC_RE.test(s);
}

/** Parse a plain decimal string ("12", "0.00100000"). Exponents and >18 fractional digits are rejected. */
export function parse(s: string): Dec {
  if (!DEC_RE.test(s)) throw new Error(`Invalid decimal: ${JSON.stringify(s).slice(0, 40)}`);
  const neg = s.startsWith('-');
  const [intPart, frac = ''] = (neg ? s.slice(1) : s).split('.');
  if (frac.length > SCALE_DIGITS) {
    if (/[1-9]/.test(frac.slice(SCALE_DIGITS))) throw new Error('Too many fractional digits');
  }
  const v = BigInt(intPart!) * ONE + BigInt(frac.slice(0, SCALE_DIGITS).padEnd(SCALE_DIGITS, '0'));
  return neg ? -v : v;
}

/** Format with trailing zeros trimmed. */
export function fmt(v: Dec): string {
  const neg = v < 0n;
  const abs = neg ? -v : v;
  const int = abs / ONE;
  const frac = (abs % ONE).toString().padStart(SCALE_DIGITS, '0').replace(/0+$/, '');
  return `${neg ? '-' : ''}${int}${frac ? '.' + frac : ''}`;
}

/** Format rounded down to `dp` decimal places (truncate toward zero), keeping exactly dp digits. */
export function fmtFixed(v: Dec, dp: number): string {
  const neg = v < 0n;
  const abs = neg ? -v : v;
  const unit = 10n ** BigInt(SCALE_DIGITS - dp);
  const t = abs / unit;
  const s = t.toString().padStart(dp + 1, '0');
  const int = dp === 0 ? s : s.slice(0, -dp);
  const frac = dp === 0 ? '' : s.slice(-dp);
  return `${neg && t !== 0n ? '-' : ''}${int}${dp ? '.' + frac : ''}`;
}

export const ZERO: Dec = 0n;
export const add = (a: Dec, b: Dec): Dec => a + b;
export const sub = (a: Dec, b: Dec): Dec => a - b;
export const mul = (a: Dec, b: Dec): Dec => (a * b) / ONE;
export function div(a: Dec, b: Dec): Dec {
  if (b === 0n) throw new Error('Division by zero');
  return (a * ONE) / b;
}
export const cmp = (a: Dec, b: Dec): -1 | 0 | 1 => (a < b ? -1 : a > b ? 1 : 0);
export const gt = (a: Dec, b: Dec): boolean => a > b;
export const gte = (a: Dec, b: Dec): boolean => a >= b;
export const lt = (a: Dec, b: Dec): boolean => a < b;
export const lte = (a: Dec, b: Dec): boolean => a <= b;
export const abs = (a: Dec): Dec => (a < 0n ? -a : a);

/** Round a non-negative value down to a multiple of `step` (step > 0). */
export function floorToStep(v: Dec, step: Dec): Dec {
  if (step <= 0n) return v;
  return (v / step) * step;
}

/** Binance rule: (value - base) % step == 0. With step 0 the filter is disabled (always true). */
export function isOnStep(v: Dec, step: Dec, base: Dec = 0n): boolean {
  if (step <= 0n) return true;
  return (v - base) % step === 0n;
}

/** Percentage change from `from` to `to`: (to - from) / from * 100. */
export function pctChange(from: Dec, to: Dec): Dec {
  return div((to - from) * 100n, from);
}

export const dec = { parse, fmt, fmtFixed, add, sub, mul, div, cmp, gt, gte, lt, lte, abs, floorToStep, isOnStep, pctChange, ZERO, isDecimalString };
