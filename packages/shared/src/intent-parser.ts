import type { Intent } from './contracts';
import { dec } from './decimal';

/**
 * Shared by the backend and the glasses practice mode.
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
  /** "sell half" / "sell 25 percent": share of the free balance, 0-1]. Sized by the backend. */
  fraction?: string;
  detail?: 'biggest';
  /** The user asked for an opinion ("should I buy...?"): answer with facts only, never prepare a trade. */
  advice?: boolean;
  plan?: { direction: 'ABOVE' | 'BELOW'; price?: string; percent?: string };
  allPlans?: boolean;
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
    .trim()
    .replace(/[\s.]+$/, ''); // transcribers add a full stop: "Approve." must still mean approve
}

const SMALL: Readonly<Record<string, number>> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30,
  forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
};

/**
 * "fifty dollar" -> "50 dollar", "a hundred and twenty five" -> "125", "zero point five" -> "0.5".
 * Words that do not form one well-shaped number are left separate rather than guessed at.
 */
export function spokenNumbers(t: string): string {
  const w = t.split(/[ ]+/).flatMap((x) => (/^[a-z]+-[a-z]+$/.test(x) && x.split('-').every((p) => p in SMALL) ? x.split('-') : [x]));
  const out: string[] = [];
  let i = 0;
  while (i < w.length) {
    let total = 0;
    let current = 0;
    let used = 0;
    let j = i;
    if (w[j] === 'a' && (w[j + 1] === 'hundred' || w[j + 1] === 'thousand')) j++;
    const article = j > i;
    while (j < w.length) {
      const x = w[j]!;
      const v = SMALL[x];
      if (v !== undefined) {
        const fits = used === 0 || (current === 0 && total > 0) || (current % 100 === 0 && current > 0) || (current % 100 >= 20 && current % 10 === 0 && v > 0 && v < 10);
        if (!fits) break;
        current += v;
      } else if (x === 'hundred' && (used > 0 || article) && current < 100) current = (current || 1) * 100;
      else if (x === 'thousand' && (used > 0 || article) && total === 0) { total = (current || 1) * 1000; current = 0; }
      else if (x === 'and' && used > 0 && SMALL[w[j + 1] ?? ''] !== undefined && (current % 100 === 0)) { j++; continue; }
      else break;
      used++;
      j++;
    }
    if (used === 0) { out.push(w[i]!); i++; continue; }
    let n = String(total + current);
    if (w[j] === 'point') {
      let k = j + 1;
      let frac = '';
      while (k < w.length && SMALL[w[k]!] !== undefined && SMALL[w[k]!]! < 10) frac += SMALL[w[k++]!];
      if (frac) { n += `.${frac}`; j = k; }
    }
    out.push(n);
    i = j;
  }
  return out.join(' ');
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

/** "sell half", "sell all my ...", "sell a quarter", "sell 25 percent". "Half a bitcoin" is left for a clarification. */
function sellShare(t: string): string | undefined {
  const m = t.match(/\bsell\s+(?:(?:a\s+)?(half|quarter)(?!\s+(?:a|an)\s)|(all|everything)|(\d+(?:\.\d+)?)\s*(?:%|percent))(?![a-z])/);
  if (!m) return undefined;
  if (m[1]) return m[1] === 'half' ? '0.5' : '0.25';
  if (m[2]) return '1';
  const p = dec.parse(m[3]!);
  if (!dec.gt(p, dec.ZERO) || dec.gt(p, dec.parse('100'))) return undefined;
  return dec.fmt(dec.div(p, dec.parse('100')));
}

function parseTrade(spoken: string): ParsedIntent | null {
  const t = spokenNumbers(spoken);
  const side = /\b(buy|purchase|long)\b/.test(t) ? 'BUY' : /\bsell\b/.test(t) ? 'SELL' : undefined;
  if (!side) return null;
  const asset = pickAsset(t);
  const params: ParsedParams = { side, orderType: 'MARKET' };
  if (asset) params.asset = asset;

  const fraction = side === 'SELL' ? sellShare(t) : undefined;
  const dollar = t.match(new RegExp(String.raw`\$\s?${NUM}`));
  const unit = t.match(new RegExp(`${NUM}\\s*(usdt|usd|dollars?|bucks|usdc|[a-z]{2,10})\\b`));
  if (fraction) params.fraction = fraction;
  else if (dollar) params.quote = dollar[1]!;
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
  if (!params.quote && !params.quantity && !params.fraction) missing.push('amount');
  if (params.orderType === 'LIMIT' && !params.price) missing.push('amount');
  if (missing.length) params.missing = missing;
  return { intent: 'PREPARE_TRADE', params, confidence: missing.length ? 0.7 : 0.95 };
}

/** `raw` keeps the user's original casing for stored text ("BTC", not "btc"); `t` is the normalised form used to match. */
/**
 * "alert me if bitcoin drops below 57000", "if ether rises 2 percent sell 0.1", "buy 20 dollars of btc when it dips below 57k".
 * The condition clause supplies the trigger; the buy/sell clause (if any) supplies the offered action.
 */
function parsePlan(spoken: string): ParsedIntent | null {
  const t = spokenNumbers(spoken).replace(/(\d+(?:\.\d+)?)\s?k\b/g, (_m, n: string) => {
    const [i, f = ''] = n.split('.');
    return String(BigInt(i! + f.padEnd(3, '0').slice(0, 3)));
  });
  const down = /\b(below|under|drops?|falls?|dips?|goes? down|down)\b/.test(t);
  const up = /\b(above|over|rises?|climbs?|breaks?|goes? up|pumps?|up)\b/.test(t);
  if (down === up) return null;
  const verb = t.search(/\b(buy|purchase|sell)\b/);
  const cond = t.search(/\b(if|when|once)\b/);
  const asksToWatch = /\b(alert|notify|warn|ping|let me know|tell me|watch|set (an? )?(alert|plan|trigger))\b/.test(t) && cond >= 0;
  const conditionalTrade = verb >= 0 && cond >= 0;
  if (!asksToWatch && !conditionalTrade) return null;

  const action = verb < 0 ? '' : verb < cond ? t.slice(verb, cond) : t.slice(verb);
  const condition = verb < 0 ? t : verb < cond ? t.slice(cond) : t.slice(0, verb);
  const asset = pickAsset(t);
  const params: ParsedParams = { ...(asset ? { asset } : {}) };
  const percent = condition.match(new RegExp(`${NUM}\\s*(?:%|percent)`));
  const level = condition.match(new RegExp(String.raw`(?:below|under|above|over|to|past|reaches|hits|at)\s*\$?${NUM}(?!\s*(?:%|percent))`));
  const direction = down ? 'BELOW' : 'ABOVE';
  if (percent) params.plan = { direction, percent: percent[1]! };
  else if (level) params.plan = { direction, price: level[1]! };
  if (action) {
    const trade = parseTrade(asset ? `${action} ${Object.keys(ASSET_ALIASES).find((k) => ASSET_ALIASES[k] === asset)}` : action);
    if (trade?.params.side) {
      params.side = trade.params.side;
      if (trade.params.quote) params.quote = trade.params.quote;
      if (trade.params.quantity) params.quantity = trade.params.quantity;
      if (trade.params.fraction) params.fraction = trade.params.fraction;
    }
  }
  const missing: ParsedParams['missing'] = [];
  if (!asset) missing.push('asset');
  if (!params.plan || (params.side && !params.quote && !params.quantity && !params.fraction)) missing.push('amount');
  if (missing.length) params.missing = missing;
  return { intent: 'CREATE_PLAN', params, confidence: missing.length ? 0.7 : 0.95 };
}

function parseMemory(t: string, raw: string = t): ParsedIntent | null {
  const usual = spokenNumbers(t).match(/^(?:remember that )?my (?:usual|default|standard) (?:buy|order|trade)(?: size| amount)? is \$?(\d+(?:\.\d+)?)(?: ?(?:usdt|usd|dollars?|bucks))?$/);
  if (usual) {
    return { intent: 'SAVE_MEMORY', confidence: 0.95, params: { memory: { category: 'interaction_preference', content: `My usual buy is ${usual[1]} USDT`, preference: { key: 'default_buy_usdt', value: usual[1]! } } } };
  }
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

  // Asking for an opinion is never an instruction to trade.
  if (/^(should (i|we)|is (it|now) (a )?(good|bad|the right|worth)|is it worth|do you think|would you (buy|sell)|what if i|when should)\b/.test(t)) {
    return ok('ASK_FINANCIAL_QUESTION', { ...(asset ? { asset } : {}), advice: true });
  }

  if (/\b(cancel|remove|delete|clear)\b.*\b(plan|alert|trigger)s?\b/.test(t)) {
    return ok('CANCEL_PLAN', { ...(asset ? { asset } : {}), ...(/\ball\b/.test(t) ? { allPlans: true } : {}) });
  }

  // Resting orders. Checked before trades, so "cancel my buy order" is never read as a buy.
  if (/\bcancel\b(?: [a-z0-9]+){0,4}? orders?\b/.test(t)) return ok('CANCEL_ORDER', asset ? { asset } : {});
  if (/\b(open|pending|resting|unfilled)(?: (?:limit|buy|sell))? orders?\b|\b(show|list)(?: me)?(?: my)? orders\b|\bmy orders\b/.test(t)) return ok('GET_OPEN_ORDERS');

  const plan = parsePlan(t);
  if (plan) return plan;
  if (/\b(my|show|list|what are my|any) .*\b(plans?|alerts?|triggers?)\b|^(plans|alerts)$/.test(t)) return ok('GET_PLANS');
  if (/\b(pnl|p n l|p and l|p l|profit|profits|loss|losses|how am i doing|how is my session|how's my session|session (change|performance|so far|result))\b/.test(t)) return ok('GET_SESSION_PNL');

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
