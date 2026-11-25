import type { Intent } from '@pulse/shared';

/**
 * Deterministic intent parser. It is the ONLY component allowed to produce APPROVE_TRADE /
 * REJECT_TRADE, and it never needs a model. It also separates "asking about" from "instructing".
 */
export interface ParsedParams {
  asset?: string;
  side?: 'BUY' | 'SELL';
  orderType?: 'MARKET' | 'LIMIT';
  quote?: string; // amount in quote currency (e.g. USDT)
  quantity?: string; // amount in base asset
  price?: string;
  detail?: 'biggest';
  memory?: { category: 'explicit_preference' | 'financial_goal' | 'interaction_preference'; content: string; preference?: { key: string; value: string } };
  missing?: Array<'asset' | 'amount' | 'side'>;
}
export interface ParsedIntent {
  intent: Intent;
  params: ParsedParams;
  confidence: number;
}

export const ASSET_ALIASES: Readonly<Record<string, string>> = {
  bitcoin: 'BTC', btc: 'BTC', ethereum: 'ETH', ether: 'ETH', eth: 'ETH', solana: 'SOL', sol: 'SOL',
  bnb: 'BNB', xrp: 'XRP', ripple: 'XRP', dogecoin: 'DOGE', doge: 'DOGE', cardano: 'ADA', ada: 'ADA',
  litecoin: 'LTC', ltc: 'LTC', chainlink: 'LINK', polkadot: 'DOT', avalanche: 'AVAX', avax: 'AVAX',
  tron: 'TRX', trx: 'TRX', tether: 'USDT', usdt: 'USDT', usdc: 'USDC', shiba: 'SHIB',
};
const QUOTE_UNITS = new Set(['usdt', 'usd', 'dollar', 'dollars', 'bucks', 'usdc']);
const NUM = String.raw`(\d+(?:\.\d+)?)`;

export function normalizeText(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/^\s*(hey |ok |okay )?pulse[,:]?\s*/, '')
    .replace(/(\d),(\d{3})/g, '$1$2')
    .replace(/[^a-z0-9$.%@\s'-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function findAssets(t: string): string[] {
  const found: string[] = [];
  for (const w of t.split(' ')) {
    const a = ASSET_ALIASES[w.replace(/[^a-z]/g, '')];
    if (a && !found.includes(a)) found.push(a);
  }
  return found;
}

/** Picks the traded asset, ignoring the quote currency when another asset is present. */
function pickAsset(t: string): string | undefined {
  const all = findAssets(t);
  return all.find((a) => a !== 'USDT' && a !== 'USDC') ?? all[0];
}

function parseTrade(t: string): ParsedIntent | null {
  const side = /\b(buy|purchase|long)\b/.test(t) ? 'BUY' : /\bsell\b/.test(t) ? 'SELL' : undefined;
  if (!side) return null;
  const asset = pickAsset(t);
  const params: ParsedParams = { side, orderType: 'MARKET' };
  if (asset) params.asset = asset;

  const dollar = t.match(new RegExp(String.raw`\$\s?${NUM}`));
  const unit = t.match(new RegExp(`${NUM}\\s*(usdt|usd|dollars?|bucks|usdc|[a-z]{2,10})\\b`));
  if (dollar) params.quote = dollar[1]!;
  else if (unit) {
    const u = unit[2]!;
    if (QUOTE_UNITS.has(u)) params.quote = unit[1]!;
    else if (ASSET_ALIASES[u] && (!asset || ASSET_ALIASES[u] === asset)) {
      params.quantity = unit[1]!;
      params.asset ??= ASSET_ALIASES[u]!;
    }
  }
  const limit = t.match(new RegExp(String.raw`(?:\bat\b|@|limit(?: price)?(?: of| at)?)\s*\$?${NUM}`));
  if (limit && !/\bat market\b/.test(t)) {
    // "at 60000" is a limit price unless the number was already consumed as the amount.
    if (limit[1] !== params.quote && limit[1] !== params.quantity) {
      params.price = limit[1]!;
      params.orderType = 'LIMIT';
    }
  } else if (/\blimit\b/.test(t)) params.orderType = 'LIMIT';

  const missing: ParsedParams['missing'] = [];
  if (!params.asset) missing.push('asset');
  if (!params.quote && !params.quantity) missing.push('amount');
  if (params.orderType === 'LIMIT' && !params.price) missing.push('amount');
  if (missing.length) params.missing = missing;
  return { intent: 'PREPARE_TRADE', params, confidence: missing.length ? 0.7 : 0.95 };
}

/** `raw` keeps the user's original casing for stored text ("BTC", not "btc"); `t` is the normalised form used to match. */
function parseMemory(t: string, raw: string = t): ParsedIntent | null {
  let m = t.match(/^(?:please )?remember(?: that)?\s*(.*)$/);
  if (m) {
    const rawMatch = raw.trim().replace(/^\s*(?:hey |ok |okay )?pulse[,:]?\s*/i, '').match(/^(?:please )?remember(?: that)?\s*(.*)$/i);
    const content = (rawMatch?.[1] ?? m[1]!).trim().replace(/[.!]+$/, '');
    const goal = /\b(goal|aim|target|objective|saving|retire|long term)\b/.test(content);
    return { intent: 'SAVE_MEMORY', confidence: 0.95, params: { memory: { category: goal ? 'financial_goal' : 'explicit_preference', content } } };
  }
  m = t.match(/^my preferred quote(?: currency| asset)? is ([a-z]{3,5})$/);
  if (m) {
    const v = m[1]!.toUpperCase();
    return { intent: 'SAVE_MEMORY', confidence: 0.95, params: { memory: { category: 'explicit_preference', content: `Preferred quote currency is ${v}`, preference: { key: 'preferred_quote', value: v } } } };
  }
  m = t.match(/^i prefer (short|brief|concise|detailed|long)(?: answers| responses| explanations| replies)?$/);
  if (m) {
    const v = ['short', 'brief', 'concise'].includes(m[1]!) ? 'short' : 'detailed';
    return { intent: 'SAVE_MEMORY', confidence: 0.95, params: { memory: { category: 'interaction_preference', content: `Prefers ${v} answers`, preference: { key: 'explanation_length', value: v } } } };
  }
  m = t.match(/^my (?:goal|objective) is (.+)$/);
  if (m) {
    const rawGoal = raw.trim().replace(/^\s*(?:hey |ok |okay )?pulse[,:]?\s*/i, '').match(/^my (?:goal|objective) is (.+)$/i)?.[1];
    return { intent: 'SAVE_MEMORY', confidence: 0.95, params: { memory: { category: 'financial_goal', content: `Goal: ${(rawGoal ?? m[1]!).trim().replace(/[.!]+$/, '')}` } } };
  }
  return null;
}

export function parseIntent(raw: string): ParsedIntent {
  const t = normalizeText(raw);
  const assets = findAssets(t);
  const asset = pickAsset(t);
  const ok = (intent: Intent, params: ParsedParams = {}, confidence = 0.9): ParsedIntent => ({ intent, params, confidence });

  // Approval / rejection: short, exact phrases only. A vague "I want to trade" is never approval.
  if (/^(yes[ ,]+)?(approve|confirm)( (it|this|that|the|trade|order|proposal|buy|sell))*$/.test(t)) return ok('APPROVE_TRADE', {}, 1);
  if (/^(no[ ,]+)?(reject|decline|cancel|abort|stop|never ?mind)( (it|this|that|the|trade|order|proposal))*$/.test(t) || t === 'no') return ok('REJECT_TRADE', {}, 1);

  const mem = parseMemory(t, raw);
  if (mem) return mem;

  const trade = parseTrade(t);
  if (trade) return trade;

  if (/\b(last|latest|my|recent) order\b|\border status\b|what happened to (my )?(last )?(order|trade)/.test(t)) return ok('GET_ORDER_STATUS');

  const wl = t.match(/\badd (.+?) to (my )?watch ?list\b/);
  if (wl) return ok('ADD_WATCHLIST_ASSET', asset ? { asset } : {});
  const rm = t.match(/\b(remove|delete|drop) (.+?) from (my )?watch ?list\b/);
  if (rm) return ok('REMOVE_WATCHLIST_ASSET', asset ? { asset } : {});
  if (/\bwatch ?list\b/.test(t)) return ok('GET_WATCHLIST');

  if (/\b(end|finish|close|stop) (my |the )?(trading )?session\b/.test(t)) return ok('END_SESSION');
  if (/\b(start|begin|open|resume)\b.*\bsession\b|^start$/.test(t)) return ok('START_SESSION');

  if (/\bhow much\b.*\b(do i have|i have|do i own|i own|do i hold)\b|\bmy .+ balance\b|\bbalance of\b/.test(t) && asset) return ok('GET_BALANCE', { asset });
  if (/\b(biggest|largest|top) (holding|position|asset)\b/.test(t)) return ok('GET_PORTFOLIO', { detail: 'biggest' });
  if (/\b(portfolio|holdings|my account|my balances?|what do i (own|hold|have)|net worth)\b/.test(t)) return ok('GET_PORTFOLIO');
  if (/^balances?$/.test(t)) return ok('GET_PORTFOLIO');

  if (/\b(why|explain|insight|reason|how come|what'?s happening|what is happening|what happened|what'?s going on|going on with)\b/.test(t)) {
    return ok('ASK_FINANCIAL_QUESTION', asset ? { asset } : {}, 0.8);
  }
  if (/\b(perform|performing|doing|up or down|change|changed|moving|move|24h|24 hour|today)\b/.test(t) && asset) return ok('GET_MARKET_CHANGE', { asset });
  if (/\b(price|worth|trading at|cost|quote|how much is)\b/.test(t) && asset) return ok('GET_MARKET_PRICE', { asset });
  if (assets.length === 1 && t.split(' ').length <= 3) return ok('GET_MARKET_PRICE', { asset: asset! }, 0.6);

  if (/^(help|what can you do|commands|how do i use)\b/.test(t) || /what can (i|you) (say|do|ask)/.test(t)) return ok('GET_HELP');

  return { intent: 'UNKNOWN', params: {}, confidence: 0 };
}

/** Extracts explicit, user-stated preferences only (never model guesses). */
export function extractMemory(raw: string) {
  const p = parseMemory(normalizeText(raw), raw);
  return p?.params.memory ?? null;
}
