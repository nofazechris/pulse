import { dec } from '@pulse/shared';
import { AppError } from '../../utils/errors';
import type { OrderKind, OrderSide, SymbolInfo } from '../exchange/types';

export interface OrderTerms {
  side: OrderSide;
  orderType: OrderKind;
  quantity?: string | undefined;
  quoteOrderQty?: string | undefined;
  price?: string | undefined;
}

export interface Normalized {
  terms: OrderTerms;
  warnings: string[];
}

const MAX_DP = 8;

export function decimalPlaces(s: string): number {
  const i = s.indexOf('.');
  return i < 0 ? 0 : s.length - i - 1;
}

const bad = (code: string, message: string) => new AppError(422, code, message);

/** `lenient` skips the decimal-places cap so a spoken quantity can be floored to the lot step (with a warning). */
function parsePositive(label: string, s: string, lenient = false): bigint {
  if (!dec.isDecimalString(s)) throw bad('INVALID_AMOUNT', `${label} is not a valid number.`);
  if (!lenient && decimalPlaces(s.replace(/0+$/, '')) > MAX_DP) throw bad('INVALID_PRECISION', `${label} has too many decimal places (max ${MAX_DP}).`);
  const v = dec.parse(s);
  if (!dec.gt(v, dec.ZERO)) throw bad('INVALID_AMOUNT', `${label} must be greater than zero.`);
  return v;
}

function lotFilter(info: SymbolInfo, orderType: OrderKind) {
  const f = info.filters;
  if (orderType === 'MARKET' && f.marketStepSize && dec.gt(dec.parse(f.marketStepSize), dec.ZERO)) {
    return { step: f.marketStepSize, min: f.marketMinQty ?? f.minQty ?? '0', max: f.marketMaxQty ?? f.maxQty };
  }
  return { step: f.stepSize ?? '0', min: f.minQty ?? '0', max: f.maxQty };
}

/**
 * Turns user-friendly input into exchange-valid terms BEFORE the user is asked to approve:
 * floors to the lot step / tick size (with a visible warning) and converts quote amounts to base
 * quantity where the exchange needs a quantity. The approved snapshot is the normalised result.
 */
export function normalizeOrder(info: SymbolInfo, terms: OrderTerms, referencePrice: string): Normalized {
  const warnings: string[] = [];
  const out: OrderTerms = { ...terms };
  const lot = lotFilter(info, terms.orderType);
  const step = dec.parse(lot.step);

  if (terms.orderType === 'LIMIT' && terms.price !== undefined) {
    const tick = info.filters.tickSize ? dec.parse(info.filters.tickSize) : dec.ZERO;
    const p = parsePositive('Price', terms.price);
    const floored = dec.floorToStep(p, tick);
    if (dec.gt(tick, dec.ZERO) && floored !== p) {
      if (!dec.gt(floored, dec.ZERO)) throw bad('INVALID_PRICE', 'Price is below the minimum tick size.');
      out.price = dec.fmt(floored);
      warnings.push(`Price rounded down to ${out.price} (tick size ${info.filters.tickSize}).`);
    } else out.price = dec.fmt(p);
  }

  // Quote amount -> quantity where the exchange wants a quantity (everything except MARKET BUY).
  if (terms.quoteOrderQty !== undefined && !(terms.orderType === 'MARKET' && terms.side === 'BUY')) {
    const quote = parsePositive('Amount', terms.quoteOrderQty);
    const px = dec.parse(out.price ?? referencePrice);
    const qty = dec.floorToStep(dec.div(quote, px), step);
    out.quantity = dec.fmt(qty);
    delete out.quoteOrderQty;
    warnings.push(`${terms.quoteOrderQty} ${info.quoteAsset} converted to ${out.quantity} ${info.baseAsset} at ${dec.fmt(px)}.`);
  } else if (terms.quoteOrderQty !== undefined) {
    out.quoteOrderQty = dec.fmt(parsePositive('Amount', terms.quoteOrderQty));
  }

  if (out.quantity !== undefined) {
    const q = parsePositive('Quantity', out.quantity, true);
    const floored = dec.floorToStep(q, step);
    if (dec.gt(step, dec.ZERO) && floored !== q) {
      out.quantity = dec.fmt(floored);
      warnings.push(`Quantity rounded down to ${out.quantity} (lot step ${lot.step}).`);
    } else out.quantity = dec.fmt(q);
    if (!dec.gt(dec.parse(out.quantity), dec.ZERO)) throw bad('BELOW_MIN_QTY', `That amount is below the minimum order size for ${info.symbol}.`);
  }
  return { terms: out, warnings };
}

/** Strict validation: rejects (never silently fixes) anything that violates the symbol's filters. */
export function validateOrder(info: SymbolInfo, terms: OrderTerms, referencePrice: string): void {
  if (info.status !== 'TRADING') throw bad('SYMBOL_NOT_TRADING', `${info.symbol} is not currently trading.`);
  if (!info.orderTypes.includes(terms.orderType)) throw bad('ORDER_TYPE_UNSUPPORTED', `${terms.orderType} orders are not supported for ${info.symbol}.`);
  const f = info.filters;

  if (terms.orderType === 'MARKET') {
    if (terms.price !== undefined) throw bad('INVALID_ORDER', 'A market order cannot have a price.');
    const both = terms.quantity !== undefined && terms.quoteOrderQty !== undefined;
    const none = terms.quantity === undefined && terms.quoteOrderQty === undefined;
    if (both || none) throw bad('INVALID_ORDER', 'Give either a quantity or a quote amount, not both.');
    if (terms.quoteOrderQty !== undefined && terms.side !== 'BUY') throw bad('INVALID_ORDER', 'A quote amount is only supported for market buys.');
  } else {
    if (terms.price === undefined || terms.quantity === undefined) throw bad('INVALID_ORDER', 'A limit order needs a quantity and a price.');
    if (terms.quoteOrderQty !== undefined) throw bad('INVALID_ORDER', 'A limit order cannot use a quote amount.');
  }

  let price: bigint | null = null;
  if (terms.price !== undefined) {
    price = parsePositive('Price', terms.price);
    const tick = f.tickSize ? dec.parse(f.tickSize) : dec.ZERO;
    if (!dec.isOnStep(price, tick)) throw bad('INVALID_PRECISION', `Price must be a multiple of ${f.tickSize}.`);
    if (f.minPrice && dec.lt(price, dec.parse(f.minPrice))) throw bad('INVALID_PRICE', `Price is below the minimum ${f.minPrice}.`);
    if (f.maxPrice && dec.gt(dec.parse(f.maxPrice), dec.ZERO) && dec.gt(price, dec.parse(f.maxPrice))) throw bad('INVALID_PRICE', `Price is above the maximum ${f.maxPrice}.`);
  }

  const effPrice = price ?? dec.parse(referencePrice);
  let notional: bigint;
  if (terms.quantity !== undefined) {
    const qty = parsePositive('Quantity', terms.quantity);
    const lot = lotFilter(info, terms.orderType);
    const step = dec.parse(lot.step);
    if (!dec.isOnStep(qty, step, dec.parse(lot.min))) throw bad('INVALID_PRECISION', `Quantity must be a multiple of ${lot.step}.`);
    if (dec.lt(qty, dec.parse(lot.min))) throw bad('BELOW_MIN_QTY', `Quantity is below the minimum ${lot.min}.`);
    if (lot.max && dec.gt(dec.parse(lot.max), dec.ZERO) && dec.gt(qty, dec.parse(lot.max))) throw bad('ABOVE_MAX_QTY', `Quantity is above the maximum ${lot.max}.`);
    notional = dec.mul(qty, effPrice);
  } else {
    notional = parsePositive('Amount', terms.quoteOrderQty!);
  }

  const applies = terms.orderType === 'LIMIT' || f.applyMinToMarket;
  if (applies && f.minNotional && dec.lt(notional, dec.parse(f.minNotional))) {
    throw bad('BELOW_MIN_NOTIONAL', `Order value is below the minimum ${f.minNotional} ${info.quoteAsset}.`);
  }
  if (f.maxNotional && dec.gt(dec.parse(f.maxNotional), dec.ZERO) && dec.gt(notional, dec.parse(f.maxNotional))) {
    throw bad('ABOVE_MAX_NOTIONAL', `Order value is above the maximum ${f.maxNotional} ${info.quoteAsset}.`);
  }
}

/** Balance check against FREE balances. Returns nothing; throws INSUFFICIENT_BALANCE. */
export function checkBalance(
  info: SymbolInfo, terms: OrderTerms, referencePrice: string, free: (asset: string) => string,
): void {
  const px = dec.parse(terms.price ?? referencePrice);
  if (terms.side === 'BUY') {
    const need = terms.quoteOrderQty !== undefined ? dec.parse(terms.quoteOrderQty) : dec.mul(dec.parse(terms.quantity!), px);
    const have = dec.parse(free(info.quoteAsset));
    if (dec.lt(have, need)) {
      throw bad('INSUFFICIENT_BALANCE', `Insufficient ${info.quoteAsset}: need ${dec.fmt(need)}, available ${dec.fmt(have)}.`);
    }
  } else {
    const need = dec.parse(terms.quantity!);
    const have = dec.parse(free(info.baseAsset));
    if (dec.lt(have, need)) {
      throw bad('INSUFFICIENT_BALANCE', `Insufficient ${info.baseAsset}: need ${dec.fmt(need)}, available ${dec.fmt(have)}.`);
    }
  }
}
