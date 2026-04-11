import { Router, Request, Response } from 'express';

const router = Router();

const GROQ_URL  = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODEL = 'meta-llama/llama-4-scout-17b-16e-instruct'; // 30K TPM on free tier

async function callGroq(apiKey: string, messages: { role: string; content: string }[], jsonMode = false): Promise<string> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(GROQ_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: GROQ_MODEL,
        messages,
        temperature: 0.1,
        max_tokens: 2048,
        ...(jsonMode ? { response_format: { type: 'json_object' } } : {}),
      }),
    });
    const data = await res.json() as { choices?: { message: { content: string } }[]; error?: { message: string } };
    if (!data.error) return data.choices?.[0]?.message?.content ?? '{}';

    // Parse wait time from rate-limit message e.g. "Please try again in 15.04s"
    const waitMatch = data.error.message.match(/try again in ([\d.]+)s/i);
    if (res.status === 429 && waitMatch && attempt < 2) {
      const waitMs = Math.ceil(parseFloat(waitMatch[1]) * 1000) + 500;
      console.log(`[groq] Rate limited — waiting ${waitMs}ms before retry ${attempt + 1}`);
      await new Promise(r => setTimeout(r, waitMs));
      continue;
    }
    throw new Error(data.error.message);
  }
  throw new Error('Groq: max retries exceeded');
}

// ── POST /api/portfolio/parse ─────────────────────────────────────────────────
// Body: { base64?: string; filename: string; csvText?: string }
// Returns: { transactions: StockTransaction[] }
router.post('/parse', async (req: Request, res: Response) => {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey)
  {
    res.status(500).json({ error: 'GROQ_API_KEY not set' });
    return;
  }

  const { rawText: rawTextBody, filename = '' } = req.body as {
    rawText?: string; filename?: string;
  };

  const rawText = (rawTextBody ?? '').trim();
  if (!rawText) {
    res.status(400).json({ error: 'rawText required' }); return;
  }

  // Keep ~3500 chars (~900 tokens) to stay well under the 6000 TPM free-tier limit
  const trimmed = rawText.slice(0, 3500);

  console.log(`[portfolio/parse] ${filename}: ${rawText.length} chars → trimmed to ${trimmed.length}`);

  const systemPrompt = `Extract transactions from this brokerage statement. Return JSON only:
{"transactions":[{"date":"YYYY-MM-DD","symbol":"TICKER","name":"Security Name","action":"buy|sell|dividend|fee|interest|other","quantity":0,"price":0,"amount":0,"costBasis":0,"currency":"USD"}]}
Rules:
- date=YYYY-MM-DD, symbol=ticker or first word of name, amount=always positive
- action: קניה=buy מכירה=sell דיבידנד=dividend עמלה=fee ריבית=interest
- costBasis: for SELL rows only — the total acquisition cost of the sold shares as stated in the report (שווי עלות / עלות רכישה / מחיר עלות). Omit if not present.
- Omit any field not present in the source.`;

  try {
    const raw = await callGroq(apiKey, [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: `Parse this brokerage statement:\n\n${trimmed}` },
    ], true);

    let parsed: { transactions?: unknown[] } = {};
    try { parsed = JSON.parse(raw); } catch { /* fallback below */ }

    const transactions = Array.isArray(parsed.transactions) ? parsed.transactions : [];
    console.log(`[portfolio/parse] Extracted ${transactions.length} transactions`);

    // Assign stable IDs
    const withIds = transactions.map((tx: unknown, i: number) => ({
      id: `ptx-${i}`,
      ...(tx as object),
    }));

    res.json({ transactions: withIds, rawLength: rawText.length });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ── POST /api/portfolio/analyze ───────────────────────────────────────────────
// Body: { transactions: StockTransaction[]; summary: object }
// Returns: PortfolioAIAnalysis
router.post('/analyze', async (req: Request, res: Response) => {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) { res.status(500).json({ error: 'GROQ_API_KEY not set' }); return; }

  const { summary } = req.body as { summary: Record<string, unknown> };
  if (!summary) { res.status(400).json({ error: 'summary required' }); return; }

  const prompt = `אתה יועץ השקעות ישראלי מנוסה. נתח את תיק ההשקעות הבא וספק תובנות והמלצות מפורטות בעברית.

נתוני התיק:
${JSON.stringify(summary, null, 2)}

החזר JSON בלבד בפורמט הבא:
{
  "summary": "סיכום כללי של התיק ב-2-3 משפטים",
  "insights": [
    {"title": "כותרת תובנה", "description": "הסבר מפורט", "severity": "low|medium|high"}
  ],
  "recommendations": [
    {"title": "כותרת המלצה", "description": "הסבר ופעולה מוצעת", "priority": "high|medium|low"}
  ]
}

התמקד ב:
1. ביצועי התיק ורמת הסיכון
2. פיזור ההשקעות (דיוורסיפיקציה)
3. השפעת העמלות על התשואה
4. חשיפה לסוגי נכסים שונים
5. המלצות ספציפיות לשיפור`;

  try {
    // llama-4-scout doesn't support json_object mode — extract JSON from free-text response
    const raw = await callGroq(apiKey, [{ role: 'user', content: prompt }], false);
    let parsed: unknown = {};
    try {
      const match = raw.match(/\{[\s\S]*\}/);
      if (match) parsed = JSON.parse(match[0]);
    } catch { /* fallback */ }
    res.json(parsed);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ── GET /api/portfolio/forex-rates?from=YYYY-MM-DD&to=YYYY-MM-DD ─────────────
// Returns daily USD/ILS closing rates for the requested range from Yahoo Finance.
router.get('/forex-rates', async (req: Request, res: Response) => {
  const from = String(req.query.from ?? '');
  const to   = String(req.query.to   ?? new Date().toISOString().slice(0, 10));
  if (!from) { res.status(400).json({ error: '"from" date required' }); return; }

  const period1 = Math.floor(new Date(from).getTime() / 1000) - 86400;
  const period2 = Math.floor(new Date(to).getTime()   / 1000) + 86400;
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/USDILS=X?interval=1d&period1=${period1}&period2=${period2}`;

  const r = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' },
  });
  if (!r.ok) { res.status(502).json({ error: `Yahoo HTTP ${r.status}` }); return; }

  const data = await r.json() as {
    chart?: { result?: [{ timestamp: number[]; indicators: { quote: [{ close: (number | null)[] }] } }] }
  };
  const result = data?.chart?.result?.[0];
  if (!result) { res.json({}); return; }

  const rates: Record<string, number> = {};
  result.timestamp.forEach((ts, i) => {
    const close = result.indicators.quote[0].close[i];
    if (close != null) rates[new Date(ts * 1000).toISOString().slice(0, 10)] = close;
  });

  console.log(`[forex-rates] ${from}→${to}: ${Object.keys(rates).length} data points`);
  res.json(rates);
});

// ── GET /api/portfolio/quotes?symbols=VOO,AAPL,IBIT ──────────────────────────
// Proxies Yahoo Finance — no API key required.
router.get('/quotes', async (req: Request, res: Response) => {
  const symbols = String(req.query.symbols ?? '')
    .split(',')
    .map(s => s.trim().toUpperCase())
    .filter(Boolean);

  if (!symbols.length) { res.json([]); return; }

  const results = await Promise.allSettled(
    symbols.map(async (symbol) => {
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=1d`;
      const r = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept': 'application/json',
        },
      });
      if (!r.ok) throw new Error(`Yahoo HTTP ${r.status} for ${symbol}`);
      const data = await r.json() as {
        chart?: { result?: { meta: { regularMarketPrice?: number; previousClose?: number; chartPreviousClose?: number; currency?: string } }[] }
      };
      const meta = data?.chart?.result?.[0]?.meta;
      const price = meta?.regularMarketPrice;
      if (!price) throw new Error(`No price for ${symbol}`);
      const prev = meta.previousClose ?? meta.chartPreviousClose ?? price;
      return {
        symbol,
        price,
        change: price - prev,
        changePercent: prev ? ((price - prev) / prev) * 100 : 0,
        currency: meta.currency ?? 'USD',
      };
    }),
  );

  const quotes = results
    .filter((r): r is PromiseFulfilledResult<{ symbol: string; price: number; change: number; changePercent: number; currency: string }> => r.status === 'fulfilled')
    .map(r => r.value);

  const failed = results
    .filter(r => r.status === 'rejected')
    .map((r, i) => ({ symbol: symbols[i], error: (r as PromiseRejectedResult).reason?.message }));

  if (failed.length) console.warn('[portfolio/quotes] Failed:', failed);
  console.log(`[portfolio/quotes] ${quotes.length}/${symbols.length} quotes fetched`);

  res.json(quotes);
});

export default router;
