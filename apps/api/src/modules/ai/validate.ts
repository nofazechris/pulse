import { z } from 'zod';
import { intentSchema, type Intent } from '@pulse/shared';
import { aiResponseSchema, type AIContext, type AIResponse, type IntentResult } from './types';

/** Pulls the first JSON object out of a model reply (models sometimes wrap it in prose or fences). */
export function extractJson(text: string): unknown {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return undefined;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return undefined;
  }
}

/**
 * Validates model output. Returns null (=> deterministic fallback) when it is malformed or not grounded:
 * every evidence reference must be an item we supplied, and facts require evidence.
 * A model can never approve a trade or mark an order successful: those fields do not exist in the schema.
 */
export function validateAiResponse(raw: unknown, context: AIContext): AIResponse | null {
  // Models often send `null` for fields they leave out; treat that as absent.
  const cleaned = raw && typeof raw === 'object' && !Array.isArray(raw) ? Object.fromEntries(Object.entries(raw).filter(([, v]) => v !== null)) : raw;
  const parsed = aiResponseSchema.safeParse(cleaned);
  if (!parsed.success) return null;
  const r = parsed.data;
  const byRef = new Map(context.items.map((i) => [i.ref, i]));
  // Models sometimes copy the "[ref]" brackets used in the prompt; the reference itself must still match exactly.
  const refs = r.evidence.map((e) => e.reference.trim().replace(/^\[|\]$/g, ''));
  if (refs.some((ref) => !byRef.has(ref))) return null;
  // Evidence shown to the user comes from OUR data, never from the model's copy of it.
  const evidence = [...new Set(refs)].map((ref) => {
    const i = byRef.get(ref)!;
    return { type: i.type, reference: ref, ...(i.value !== undefined ? { value: i.value } : {}), ...(i.timestamp ? { timestamp: i.timestamp } : {}) };
  });
  if (r.facts.length > 0 && r.evidence.length === 0) return null;
  // EVERY line the wearer can read may only quote numbers that exist in the supplied context.
  const allowed = context.items.map((i) => i.text).join(' ').replace(/,/g, '');
  const numbersIn = (s: string) => s.match(/\d[\d,]*\.?\d*/g) ?? [];
  for (const text of [r.response, ...r.facts, r.interpretation ?? '', r.unverified ?? '']) {
    for (const n of numbersIn(text)) {
      const clean = n.replace(/,/g, '').replace(/\.$/, '');
      if (clean.length >= 2 && !allowed.includes(clean)) return null;
    }
  }
  return { ...r, evidence };
}

const FORBIDDEN_FROM_MODEL: ReadonlySet<Intent> = new Set(['APPROVE_TRADE', 'REJECT_TRADE']);

/** Approval and rejection can only come from the deterministic parser, never from a model. */
export function validateAiIntent(raw: unknown): IntentResult | null {
  const parsed = z.object({ intent: intentSchema, params: z.record(z.string(), z.unknown()).default({}), confidence: z.number().min(0).max(1).default(0.5) }).safeParse(raw);
  if (!parsed.success) return null;
  if (FORBIDDEN_FROM_MODEL.has(parsed.data.intent)) return { intent: 'UNKNOWN', params: {}, confidence: 0 };
  return parsed.data;
}

export const tradeParamsSchema = z.object({
  asset: z.string().regex(/^[A-Za-z0-9]{2,10}$/),
  side: z.enum(['BUY', 'SELL']),
  quote: z.string().regex(/^\d+(\.\d+)?$/).optional(),
  quantity: z.string().regex(/^\d+(\.\d+)?$/).optional(),
  price: z.string().regex(/^\d+(\.\d+)?$/).optional(),
});
