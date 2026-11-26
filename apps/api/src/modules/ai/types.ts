import { z } from 'zod';
import { intentSchema, type Intent } from '@pulse/shared';

/** One verified fact the model may cite. `ref` ids are the only references an answer may use as evidence. */
export interface ContextItem {
  ref: string;
  type: 'ticker' | 'stats' | 'portfolio' | 'balance' | 'watchlist' | 'order';
  text: string;
  value?: string;
  timestamp?: string;
}

export interface AIContext {
  items: ContextItem[];
  /** Explicit, user-confirmed notes. Treated as untrusted DATA, never as instructions. */
  memories: string[];
  preferences: Record<string, unknown>;
  lastSessionSummary?: string | undefined;
}

export interface IntentRequest { text: string }
export interface IntentResult { intent: Intent; params: Record<string, unknown>; confidence: number }

export interface AIRequest { text: string; context: AIContext }
export interface InsightRequest { question: string; asset?: string | undefined; context: AIContext }

export const aiResponseSchema = z.object({
  intent: z.string().max(40),
  response: z.string().min(1).max(400),
  facts: z.array(z.string().max(220)).max(5).default([]),
  interpretation: z.string().max(320).optional(),
  unverified: z.string().max(320).optional(),
  // Only the REFERENCE is read from the model. Type, value and timestamp are filled in by the backend from its
  // own verified context (see validateAiResponse), so whatever the model writes there is ignored.
  evidence: z.array(z.object({ reference: z.string().max(60) })).max(8).default([]),
  confidence: z.number().min(0).max(1).optional(),
  requiresClarification: z.boolean().default(false),
  action: z
    .object({ type: z.enum(['PREPARE_TRADE', 'NONE']), parameters: z.record(z.string(), z.unknown()).optional() })
    .optional(),
});
export interface Evidence { type: string; reference: string; value?: string | undefined; timestamp?: string | undefined }
export type AIResponse = Omit<z.infer<typeof aiResponseSchema>, 'evidence'> & { evidence: Evidence[] };
export type InsightResult = AIResponse;

export const aiIntentSchema = z.object({
  intent: intentSchema,
  params: z.record(z.string(), z.unknown()).default({}),
  confidence: z.number().min(0).max(1).default(0.5),
});

export interface AIProvider {
  readonly name: string;
  isAvailable(): boolean;
  classifyIntent(req: IntentRequest): Promise<IntentResult>;
  generateResponse(req: AIRequest): Promise<AIResponse>;
  generateInsight(req: InsightRequest): Promise<InsightResult>;
}

export class AIProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AIProviderError';
  }
}
