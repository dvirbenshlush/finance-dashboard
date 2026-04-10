/**
 * command-classification.ts
 * Pure LLM-based transaction classifier using Groq.
 * No keyword rules — the model decides from raw description + amount.
 */

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODEL = 'llama-3.1-8b-instant';

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

// ─── Groq call ───────────────────────────────────────────────────────────────

interface GroqMessage { role: 'system' | 'user' | 'assistant'; content: string; }

async function callGroq(apiKey: string, messages: GroqMessage[]): Promise<string> {
  const res = await fetch(GROQ_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: GROQ_MODEL,
      messages,
      temperature: 0.1,
      max_tokens: 1024,
      response_format: { type: 'json_object' },
    }),
  });

  const data = (await res.json()) as {
    choices?: { message: { content: string } }[];
    error?: { message: string };
  };

  if (data.error) throw new Error(`Groq: ${data.error.message}`);
  return data.choices?.[0]?.message?.content ?? '{}';
}

// ─── System prompt ────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are an expert classifier for Israeli bank transactions.
Given a transaction description and amount, return the best category.

Valid categories:
- salary          : salary/wages received from employer
- rental_income   : rent received from a tenant
- refund          : refund, credit note, or check deposit
- transfer_in     : incoming bank transfer (from another account)
- mortgage        : mortgage payment to bank
- rent_paid       : rent paid to landlord
- home_expenses   : municipal tax (ארנונה), building committee (ועד בית), utilities for home
- groceries       : supermarket, grocery store (שופרסל, רמי לוי, מגה, etc.)
- food_restaurant : restaurant, café, fast food, food delivery (וולט, תן-ביס)
- car             : fuel, parking, car insurance, garage, leasing
- public_transport: train, bus, light rail (רכבת, אגד, דן, רב-קו)
- subscriptions   : streaming/software subscriptions (Netflix, Spotify, Apple, etc.)
- utilities       : phone, internet, electricity, water, gas bills
- health          : doctor, pharmacy, health insurance, dental, clinic
- shopping        : clothing, electronics, general retail
- education       : tuition, courses, kindergarten, university
- entertainment   : cinema, theater, sports, gym, leisure
- travel          : flights, hotels, Airbnb, travel agencies
- investment      : stocks, ETF, crypto, savings deposits
- other           : anything that doesn't fit above

Rules:
1. "העברת מ" / "העברה מ" → transfer_in (money arriving from another account)
2. "משכורת" / "שכר" → salary
3. "הפקדת שיק/צ'ק" → refund
4. "קבלת תשלום" → transfer_in
5. Rent received from tenant → rental_income; rent paid to landlord → rent_paid
6. Base decision on description text — DO NOT rely on amount sign.

Return JSON: {"category":"<key>","confidence":"high|medium|low","reasoning":"<one sentence>"}`;

// ─── Single transaction ───────────────────────────────────────────────────────

export async function classifyOne(
  apiKey: string,
  tx: TransactionInput,
  examples: FewShotExample[] = [],
): Promise<ClassificationResult> {
  const messages: GroqMessage[] = [{ role: 'system', content: SYSTEM_PROMPT }];

  // Inject few-shot examples if provided
  if (examples.length > 0) {
    const exBlock = examples
      .map(e => `Description: "${e.description}" | Amount: ${e.amount} → ${e.category}`)
      .join('\n');
    messages.push({
      role: 'user',
      content: `Here are labeled examples from this user's actual transactions:\n${exBlock}`,
    });
    messages.push({ role: 'assistant', content: 'Understood. I will use these patterns.' });
  }

  messages.push({
    role: 'user',
    content: `Classify this transaction:\nDescription: "${tx.description}"\nAmount: ${tx.amount}`,
  });

  const raw = await callGroq(apiKey, messages);
  let parsed: { category?: string; confidence?: string; reasoning?: string } = {};
  try { parsed = JSON.parse(raw); } catch { /* fallback below */ }

  return {
    id: tx.id,
    description: tx.description,
    amount: tx.amount,
    category: (parsed.category as TransactionCategory) ?? 'other',
    confidence: (parsed.confidence as 'high' | 'medium' | 'low') ?? 'low',
    reasoning: parsed.reasoning ?? '',
  };
}

// ─── Batch (respects Groq TPM by doing one request per tx with a delay) ──────

export async function classifyBatch(
  apiKey: string,
  transactions: TransactionInput[],
  examples: FewShotExample[] = [],
  onProgress?: (done: number, total: number) => void,
): Promise<ClassificationResult[]> {
  const results: ClassificationResult[] = [];

  for (let i = 0; i < transactions.length; i++) {
    if (i > 0) await new Promise(r => setTimeout(r, 200)); // ~5 req/s, well within 30 RPM
    try {
      const result = await classifyOne(apiKey, transactions[i], examples);
      results.push(result);
    } catch {
      results.push({
        ...transactions[i],
        category: 'other',
        confidence: 'low',
        reasoning: 'Classification failed',
      });
    }
    onProgress?.(i + 1, transactions.length);
  }

  return results;
}

// ─── Build few-shot examples from already-classified transactions ─────────────

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
