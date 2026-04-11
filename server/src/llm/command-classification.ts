/**
 * command-classification.ts
 * Batched LLM classifier — sends up to CHUNK_SIZE transactions per Groq call
 * instead of one call per transaction, reducing token usage by ~10x.
 */
import { sanitizeText } from '../utils/sanitize';

const GROQ_URL   = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODEL = 'llama-3.1-8b-instant';
const CHUNK_SIZE = 15;   // transactions per LLM call
const CHUNK_DELAY_MS = 1200; // pause between chunks to stay within TPM

export type TransactionCategory =
  | 'salary' | 'rental_income' | 'refund' | 'transfer_in'
  | 'mortgage' | 'rent_paid' | 'home_expenses'
  | 'groceries' | 'food_restaurant'
  | 'car' | 'public_transport'
  | 'subscriptions' | 'utilities' | 'health' | 'shopping'
  | 'education' | 'entertainment' | 'travel' | 'investment'
  | 'other';

export interface TransactionInput {
  id: string;
  description: string;
  amount: number;
}

export interface ClassificationResult {
  id: string;
  description: string;
  amount: number;
  category: TransactionCategory;
  confidence: 'high' | 'medium' | 'low';
  reasoning: string;
}

export interface FewShotExample {
  description: string;
  amount: number;
  category: TransactionCategory;
}

// ─── Groq call ────────────────────────────────────────────────────────────────

async function callGroq(apiKey: string, prompt: string): Promise<string> {
  const res = await fetch(GROQ_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: GROQ_MODEL,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.1,
      max_tokens: 800,
      response_format: { type: 'json_object' },
    }),
  });
  const data = await res.json() as {
    choices?: { message: { content: string } }[];
    error?: { message: string };
  };
  if (data.error) throw new Error(`Groq: ${data.error.message}`);
  return data.choices?.[0]?.message?.content ?? '{}';
}

// ─── Classify a single chunk of transactions in one LLM call ─────────────────

async function classifyChunk(
  apiKey: string,
  chunk: TransactionInput[],
  examples: FewShotExample[],
): Promise<ClassificationResult[]> {
  const examplesBlock = examples.length > 0
    ? `Examples from this user:\n${examples.map(e => `  "${e.description}" | ${e.amount} → ${e.category}`).join('\n')}\n\n`
    : '';

  const txLines = chunk
    .map(tx => `  ${tx.id}: "${sanitizeText(tx.description)}" | ${tx.amount}`)
    .join('\n');

  const prompt = `You are an expert classifier for Israeli bank transactions.

${examplesBlock}Valid categories:
salary, rental_income, refund, transfer_in, mortgage, rent_paid, home_expenses,
groceries, food_restaurant, car, public_transport, subscriptions, utilities,
health, shopping, education, entertainment, travel, investment, other

Rules:
- "העברת מ"/"קבלת תשלום" → transfer_in
- "משכורת"/"שכר" → salary
- "שופרסל"/"רמי לוי"/"מגה"/"victory" → groceries
- "ארנונה"/"ועד בית" → home_expenses
- mortgage payment to bank → mortgage
- Base decision on description. Return confidence: high/medium/low.

Classify these transactions. Return JSON: {"results":[{"id":"...","category":"...","confidence":"high|medium|low"},...]}

Transactions:
${txLines}`;

  const raw = await callGroq(apiKey, prompt);

  let parsed: { results?: { id: string; category: string; confidence: string }[] } = {};
  try { parsed = JSON.parse(raw); } catch { /* fallback below */ }

  const resultMap = new Map((parsed.results ?? []).map(r => [r.id, r]));

  return chunk.map(tx => {
    const r = resultMap.get(tx.id);
    return {
      id:          tx.id,
      description: tx.description,
      amount:      tx.amount,
      category:    (r?.category as TransactionCategory) ?? 'other',
      confidence:  (r?.confidence as 'high' | 'medium' | 'low') ?? 'low',
      reasoning:   '',
    };
  });
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function classifyOne(
  apiKey: string,
  tx: TransactionInput,
  examples: FewShotExample[] = [],
): Promise<ClassificationResult> {
  const [result] = await classifyChunk(apiKey, [tx], examples);
  return result;
}

export async function classifyBatch(
  apiKey: string,
  transactions: TransactionInput[],
  examples: FewShotExample[] = [],
  onProgress?: (done: number, total: number) => void,
): Promise<ClassificationResult[]> {
  const results: ClassificationResult[] = [];

  for (let i = 0; i < transactions.length; i += CHUNK_SIZE) {
    if (i > 0) await new Promise(r => setTimeout(r, CHUNK_DELAY_MS));

    const chunk = transactions.slice(i, i + CHUNK_SIZE);
    try {
      const chunkResults = await classifyChunk(apiKey, chunk, examples);
      results.push(...chunkResults);
    } catch (err) {
      // On rate-limit error, wait 10s and retry once
      if (String(err).includes('rate') || String(err).includes('limit')) {
        await new Promise(r => setTimeout(r, 10000));
        try {
          results.push(...await classifyChunk(apiKey, chunk, examples));
        } catch {
          results.push(...chunk.map(tx => ({ ...tx, category: 'other' as TransactionCategory, confidence: 'low' as const, reasoning: 'rate limit' })));
        }
      } else {
        results.push(...chunk.map(tx => ({ ...tx, category: 'other' as TransactionCategory, confidence: 'low' as const, reasoning: 'error' })));
      }
    }

    onProgress?.(Math.min(i + CHUNK_SIZE, transactions.length), transactions.length);
  }

  return results;
}

export function buildExamples(
  classified: { description: string; amount: number; category: TransactionCategory }[],
  maxPerCategory = 2,
): FewShotExample[] {
  const seen = new Map<TransactionCategory, number>();
  const examples: FewShotExample[] = [];
  for (const tx of classified) {
    const count = seen.get(tx.category) ?? 0;
    if (count < maxPerCategory) {
      examples.push({ description: tx.description, amount: tx.amount, category: tx.category });
      seen.set(tx.category, count + 1);
    }
  }
  return examples;
}
