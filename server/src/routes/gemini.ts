import { Router, Request, Response } from 'express';
import { classifyBatch } from '../llm/command-classification';
import { sanitizeDescriptions } from '../utils/sanitize';
import * as catCache from '../utils/categoryCache';

const router = Router();

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const MODEL_CLASSIFY = 'llama-3.1-8b-instant';   // classification — own TPM pool
const MODEL_ANALYZE  = 'llama-3.3-70b-versatile'; // spending insights — own TPM pool

interface GroqResponse {
  choices?: { message: { content: string } }[];
  error?: { message: string };
}

const callGroq = async (apiKey: string, model: string, prompt: string, jsonMode = false): Promise<string> => {
  const res = await fetch(GROQ_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
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
    const raw = await callGroq(apiKey, MODEL_CLASSIFY, 'Return exactly this JSON object: {"status":"ok","model":"groq"}', true);
    res.json({ model: MODEL_CLASSIFY, raw, parsed: extractJSON(raw) });
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

  // Ensure the DB-backed cache is loaded into memory (no-op after first call)
  await catCache.ensureLoaded();

  // ── Split: cache hits vs LLM needed ────────────────────────────────────────
  const hits: { id: string; category: string }[] = [];
  const misses: typeof transactions = [];

  for (const tx of transactions) {
    const cached = catCache.get(tx.description);
    if (cached) {
      hits.push({ id: tx.id, category: cached.category });
    } else {
      misses.push(tx);
    }
  }

  console.log(
    `[Groq] Categorize ${transactions.length} txs — ` +
    `${hits.length} cache hits, ${misses.length} need LLM` +
    ` (cache size: ${catCache.stats().size})`
  );

  if (misses.length === 0) {
    res.json(hits);
    return;
  }

  try {
    // Strip PII from descriptions before sending to external LLM
    const sanitized = sanitizeDescriptions(
      misses.map(tx => ({ id: tx.id, description: tx.description, amount: tx.amount }))
    );

    // id → sanitised description map for cache storage after LLM returns
    const idToSanitisedDesc = new Map(sanitized.map(tx => [tx.id, tx.description]));

    const classified = await classifyBatch(
      apiKey,
      sanitized,
      [],
      (done, total) => console.log(`[Groq] ${done}/${total} classified`),
    );

    // Store results in cache (high/medium confidence only)
    catCache.setBatch(classified.map(r => ({
      description: idToSanitisedDesc.get(r.id) ?? r.description,
      category:    r.category,
      confidence:  r.confidence,
    })));

    const llmResults = classified.map(r => ({ id: r.id, category: r.category }));
    console.log(`[Groq] LLM returned ${llmResults.length}, total with cache: ${hits.length + llmResults.length}`);
    res.json([...hits, ...llmResults]);
  } catch (err) {
    console.error('[Groq] Classify error:', err);
    // Still return cache hits even if LLM failed
    if (hits.length > 0) {
      res.json(hits);
    } else {
      res.status(500).json({ error: String(err) });
    }
  }
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
    const text = await callGroq(apiKey, MODEL_ANALYZE, prompt, true);
    const parsed = extractJSON<{ insights: unknown[] }>(text);
    res.json(parsed?.insights ?? []);
  } catch (err) {
    console.error('[Groq] Analyze error:', err);
    res.status(500).json({ error: String(err) });
  }
});

export default router;
