import { Router, Request, Response } from 'express';

const router = Router();

const GROQ_MODEL = 'llama-3.1-8b-instant';
const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';

interface GroqResponse {
  choices?: { message: { content: string } }[];
  error?: { message: string };
}

const callGroq = async (apiKey: string, prompt: string, jsonMode = false): Promise<string> => {
  const res = await fetch(GROQ_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: GROQ_MODEL,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.1,
      max_tokens: 1024,
      ...(jsonMode ? { response_format: { type: 'json_object' } } : {}),
    }),
  });

  const data = (await res.json()) as GroqResponse;
  if (data.error) throw new Error(`Groq error: ${data.error.message}`);
  return data.choices?.[0]?.message?.content ?? '';
};

const extractJSON = <T>(text: string): T | null => {
  const stripped = text.replace(/```(?:json)?\s*/gi, '').replace(/```/g, '').trim();
  for (const candidate of [stripped, (stripped.match(/\[[\s\S]*\]|\{[\s\S]*\}/) ?? [])[0]]) {
    if (!candidate) continue;
    try { return JSON.parse(candidate) as T; } catch { /* try next */ }
  }
  return null;
};

// GET /api/gemini/test
router.get('/test', async (_req: Request, res: Response) => {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) { res.json({ error: 'GROQ_API_KEY not set in server .env' }); return; }
  try {
    const raw = await callGroq(apiKey, 'Return exactly this JSON object: {"status":"ok","model":"groq"}', true);
    res.json({ model: GROQ_MODEL, raw, parsed: extractJSON(raw) });
  } catch (e) {
    res.json({ error: String(e) });
  }
});

// POST /api/gemini/categorize
router.post('/categorize', async (req: Request, res: Response) => {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) { res.status(500).json({ error: 'GROQ_API_KEY not set in server .env' }); return; }

  const { transactions } = req.body as {
    transactions: { id: string; description: string; amount: number; isDebit: boolean }[];
  };

  if (!transactions?.length) { res.json([]); return; }

  console.log(`[Groq] Categorizing ${transactions.length} transactions`);

  const BATCH = 20;
  const results: { id: string; category: string }[] = [];

  for (let i = 0; i < transactions.length; i += BATCH) {
    if (i > 0) await new Promise(r => setTimeout(r, 1500));
    const batch = transactions.slice(i, i + BATCH);
    // Use short indices in the prompt to minimize tokens; map back to real IDs after
    const lines = batch.map((tx, idx) => `${idx} ${tx.amount} ${tx.description}`).join('\n');

    const prompt = `Categorize Israeli bank transactions. Return JSON only: {"0":"category","1":"category",...}

Categories: salary rental_income refund transfer_in mortgage rent_paid home_expenses groceries food_restaurant car public_transport subscriptions utilities health shopping education entertainment travel investment other

Rules: base decision on description text only. "העברת מ"=transfer_in, "משכורת"/"שכר"=salary, "הפקדת שיק"=refund, "קבלת תשלום"=transfer_in, rent received=rental_income, rent paid=rent_paid, unknown=other.

Transactions (index amount description):
${lines}`;

    try {
      const text = await callGroq(apiKey, prompt, true);
      console.log(`[Groq] Response (first 200 chars):`, text.slice(0, 200));
      const parsed = extractJSON<Record<string, string>>(text);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        for (const [idx, category] of Object.entries(parsed)) {
          const tx = batch[parseInt(idx)];
          if (tx) results.push({ id: tx.id, category });
        }
        console.log(`[Groq] Parsed ${Object.keys(parsed).length} categories`);
      } else {
        console.error('[Groq] Failed to parse response:', text.slice(0, 300));
      }
    } catch (err) {
      console.error('[Groq] Batch error:', err);
    }
  }

  console.log(`[Groq] Returning ${results.length} results`);
  res.json(results);
});

// POST /api/gemini/analyze
router.post('/analyze', async (req: Request, res: Response) => {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) { res.status(500).json({ error: 'GROQ_API_KEY not set in server .env' }); return; }

  const { categoryTotals, monthlyAvgBurn } = req.body as {
    categoryTotals: Record<string, number>;
    monthlyAvgBurn: number;
  };

  const summary = Object.entries(categoryTotals)
    .filter(([, v]) => v > 0)
    .map(([k, v]) => `${k}: ₪${Math.round(v)}`)
    .join(', ');

  const prompt = `אתה יועץ פיננסי ישראלי מומחה. המשתמש מוציא ₪${Math.round(monthlyAvgBurn)} בממוצע לחודש.
פילוח הוצאות: ${summary}.

זהה עד 3 תובנות: חריגות, דליפות חוזרות, או המלצות לחיסכון.
החזר JSON בלבד: {"insights":[{"type":"anomaly","title":"כותרת","description":"הסבר","severity":"low|medium|high"}]}`;

  try {
    const text = await callGroq(apiKey, prompt, true);
    const parsed = extractJSON<{ insights: unknown[] }>(text);
    res.json(parsed?.insights ?? []);
  } catch (err) {
    console.error('[Groq] Analyze error:', err);
    res.status(500).json({ error: String(err) });
  }
});

export default router;
