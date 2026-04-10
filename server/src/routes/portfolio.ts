import { Router, Request, Response } from 'express';

const router = Router();

const GROQ_URL  = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODEL = 'llama-3.1-8b-instant';

async function callGroq(apiKey: string, messages: { role: string; content: string }[], jsonMode = false): Promise<string> {
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
  if (data.error) throw new Error(data.error.message);
  return data.choices?.[0]?.message?.content ?? '{}';
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

  // Trim to avoid exceeding token limits (keep first ~8000 chars which is ~2000 tokens)
  const trimmed = rawText.slice(0, 8000);

  console.log(`[portfolio/parse] ${filename}: ${rawText.length} chars extracted`);

  const systemPrompt = `You are a financial data extractor for Israeli brokerage statements.
Extract ALL transactions from the provided brokerage statement text.

Return JSON ONLY in this exact format:
{
  "transactions": [
    {
      "date": "YYYY-MM-DD",
      "symbol": "TICKER",
      "name": "Company or Fund Name",
      "action": "buy|sell|dividend|fee|interest|other",
      "quantity": 10.5,
      "price": 450.20,
      "amount": 4752.00,
      "currency": "USD"
    }
  ]
}

Rules:
- date: always YYYY-MM-DD format. If only month/year available use first of month.
- symbol: stock/ETF ticker. If unknown use first word of name. Never empty string.
- action: buy=קניה, sell=מכירה, dividend=דיבידנד, fee=עמלה/דמי ניהול, interest=ריבית, other=anything else
- amount: always positive number (absolute value)
- quantity: number of shares/units (omit if not applicable like fees)
- price: price per unit (omit if not applicable)
- currency: USD, ILS, EUR, GBP, etc.
- Include ALL rows: buys, sells, dividends, fees, interest payments
- If a field is not present in the source, omit it from the JSON`;

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
    const raw = await callGroq(apiKey, [{ role: 'user', content: prompt }], true);
    let parsed: unknown = {};
    try { parsed = JSON.parse(raw); } catch { /* fallback */ }
    res.json(parsed);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
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
