import { Router, Request, Response } from 'express';
import pdfParse from 'pdf-parse';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { sanitizeText } from '../utils/sanitize';

const router = Router();

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const MODEL    = 'llama-3.3-70b-versatile';

interface GroqResponse {
  choices?: { message: { content: string } }[];
  error?: { message: string };
}

const callGroq = async (apiKey: string, prompt: string): Promise<string> => {
  const res = await fetch(GROQ_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.1,
      max_tokens: 4096,
      response_format: { type: 'json_object' },
    }),
  });
  const data = (await res.json()) as GroqResponse;
  if (data.error) throw new Error(`Groq error: ${data.error.message}`);
  return data.choices?.[0]?.message?.content ?? '';
};

type ImageMimeType = 'application/pdf' | 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif';

const SUPPORTED_IMAGE_TYPES: Record<string, ImageMimeType> = {
  pdf:  'application/pdf',
  jpg:  'image/jpeg',
  jpeg: 'image/jpeg',
  png:  'image/png',
  webp: 'image/webp',
  gif:  'image/gif',
};

const HTML_MIME_TYPES = new Set(['text/html', 'application/xhtml+xml']);

/**
 * Send a file (PDF or image) directly to Gemini multimodal.
 * Works for scanned PDFs, photos of documents, and screenshots.
 * base64 must NOT include the data-URI prefix.
 */
const callGeminiVisual = async (
  geminiKey: string,
  base64: string,
  mimeType: ImageMimeType,
  prompt: string,
): Promise<string> => {
  const genAI  = new GoogleGenerativeAI(geminiKey);
  const model  = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
  const result = await model.generateContent([
    { inlineData: { mimeType, data: base64 } },
    { text: `${prompt}\n\nReturn ONLY valid JSON. Do not include any explanation outside the JSON.` },
  ]);
  return result.response.text();
};

/**
 * Convert an HTML bank export to plain readable text.
 * Preserves table structure so the LLM can understand rows/columns.
 */
function htmlToText(html: string): string {
  return html
    // Remove scripts, styles, head — nothing useful there
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<head[\s\S]*?<\/head>/gi, '')
    // Table cell separators → readable columns
    .replace(/<\/th>/gi, ' | ')
    .replace(/<\/td>/gi, ' | ')
    // Row endings → newlines
    .replace(/<\/tr>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    // Strip all remaining tags
    .replace(/<[^>]+>/g, '')
    // Decode common HTML entities
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x200f;/g, '') // RTL mark
    .replace(/&#x200e;/g, '') // LTR mark
    // Collapse blank lines and excessive whitespace
    .replace(/[ \t]+\|[ \t]+\|/g, ' | ')   // dup separators
    .replace(/\|[ \t]*\n/g, '\n')           // trailing sep before newline
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const extractJSON = <T>(text: string): T | null => {
  const stripped = text.replace(/```(?:json)?\s*/gi, '').replace(/```/g, '').trim();
  for (const candidate of [stripped, (stripped.match(/\{[\s\S]*\}/) ?? [])[0]]) {
    if (!candidate) continue;
    try { return JSON.parse(candidate) as T; } catch { /* try next */ }
  }
  return null;
};

/**
 * Strip additional PII patterns relevant to PDF bank statements:
 * - Email addresses
 * - Full name patterns (lines that are only 2-3 Hebrew/Latin capitalized words without numbers)
 * - Israeli postal codes (5–7 digits standalone)
 * - IBAN-style patterns (IL + digits)
 */
function sanitizePdfText(text: string): string {
  return sanitizeText(text)
    // Email addresses
    .replace(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g, '[EMAIL]')
    // Israeli IBAN (IL followed by 2 digits and 19 digits)
    .replace(/\bIL\d{2}[\s\-]?\d{4}[\s\-]?\d{4}[\s\-]?\d{4}[\s\-]?\d{4}[\s\-]?\d{3}\b/gi, '[IBAN]')
    // Short digit sequences that look like branch/account segments (not amounts)
    .replace(/\b(\d{3}[\s\-]\d{6,9})\b/g, '[ACCT]');
}

// POST /api/pdf/parse  (also handles images: jpg/png/webp)
router.post('/parse', async (req: Request, res: Response) => {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: 'GROQ_API_KEY not set in server .env' });
    return;
  }

  const { base64, bankSource, mimeType: clientMime } = req.body as {
    base64: string; bankSource: string; mimeType?: string;
  };
  if (!base64) {
    res.status(400).json({ error: 'Missing base64 data' });
    return;
  }

  const isHtml  = HTML_MIME_TYPES.has(clientMime ?? '');
  const resolvedMime = (clientMime && SUPPORTED_IMAGE_TYPES[clientMime.replace('image/', '').replace('application/', '')])
    ?? SUPPORTED_IMAGE_TYPES[clientMime?.split('/')[1] ?? '']
    ?? 'application/pdf';
  const isImage = !isHtml && resolvedMime !== 'application/pdf';

  const prompt = `You are a financial data extraction engine. You receive content from an Israeli bank or credit-card statement.

Extract ALL financial transactions. For each:
- date: YYYY-MM-DD format (convert DD/MM/YYYY if needed)
- description: merchant or transaction name only — no account numbers, no names, no IDs
- amount: positive number (ILS unless clearly USD/EUR)
- isDebit: true for charges/withdrawals/expenses, false for deposits/credits/income
- currency: "ILS" (default) or "USD"/"EUR" if clearly stated

Rules:
1. IGNORE personal information (names, IDs, account numbers, addresses, phone numbers)
2. IGNORE table headers, balance rows, totals, and summary lines
3. If a row is a reversal/refund, set isDebit: false
4. Bank source: ${bankSource || 'unknown'}

Return ONLY valid JSON:
{"transactions":[{"date":"YYYY-MM-DD","description":"...","amount":0,"isDebit":true,"currency":"ILS"}]}
If no transactions found return: {"transactions":[]}`;

  let llmRaw = '';
  let rawText = '';
  let pageCount = 0;
  let usedGemini = false;

  if (isHtml) {
    // HTML bank export — decode, strip tags, send to Groq as text
    const htmlContent = Buffer.from(base64, 'base64').toString('utf8');
    rawText = htmlToText(htmlContent);
    const sanitized = sanitizePdfText(rawText).slice(0, 12000);
    console.log(`[HTML] ${rawText.length} chars extracted → ${sanitized.length} sanitized → Groq`);
    llmRaw = await callGroq(apiKey, `${prompt}\n\nHTML table data:\n${sanitized}`);
  } else if (isImage) {
    // Image file — Gemini vision
    const geminiKey = process.env.VITE_GEMINI_API_KEY;
    if (!geminiKey) {
      res.status(422).json({ error: 'עיבוד תמונות דורש GEMINI_API_KEY בקובץ server/.env' });
      return;
    }
    console.log(`[img] ${resolvedMime} → Gemini vision`);
    usedGemini = true;
    llmRaw = await callGeminiVisual(geminiKey, base64, resolvedMime as ImageMimeType, prompt);
  } else {
    // PDF — text extraction first, Gemini OCR fallback
    try {
      const buffer  = Buffer.from(base64, 'base64');
      const pdfData = await pdfParse(buffer, { max: 0 });
      rawText   = pdfData.text ?? '';
      pageCount = pdfData.numpages ?? 0;
    } catch (e) {
      console.error('[PDF] Parse error:', e);
    }

    if (!rawText.trim()) {
      const geminiKey = process.env.VITE_GEMINI_API_KEY;
      if (!geminiKey) {
        res.status(422).json({ error: 'ה-PDF סרוק ודורש OCR. הגדר GEMINI_API_KEY בקובץ server/.env.' });
        return;
      }
      console.log(`[PDF] No text — Gemini OCR fallback`);
      usedGemini = true;
      llmRaw = await callGeminiVisual(geminiKey, base64, 'application/pdf', prompt);
    } else {
      const sanitized = sanitizePdfText(rawText).slice(0, 12000);
      console.log(`[PDF] ${rawText.length} chars → ${sanitized.length} sanitized → Groq`);
      llmRaw = await callGroq(apiKey, `${prompt}\n\nPDF text:\n${sanitized}`);
    }
  }

  try {
    const parsed = extractJSON<{ transactions: unknown[] }>(llmRaw);

    if (!parsed || !Array.isArray(parsed.transactions)) {
      console.error('[PDF] LLM returned non-array:', llmRaw.slice(0, 200));
      res.status(422).json({ error: 'LLM לא החזיר מבנה תנועות תקין' });
      return;
    }

    interface RawTx { date?: unknown; description?: unknown; amount?: unknown; isDebit?: unknown; currency?: unknown }
    const transactions = (parsed.transactions as RawTx[])
      .filter(tx => tx && typeof tx === 'object')
      .map((tx, i) => {
        const amount = Math.abs(Number(tx.amount) || 0);
        const description = String(tx.description ?? '').trim();
        const date = String(tx.date ?? '').trim();
        const isDebit = Boolean(tx.isDebit ?? true);
        const currency = String(tx.currency ?? 'ILS').toUpperCase() === 'USD' ? 'USD' : 'ILS';
        if (amount === 0 || !description) return null;
        return {
          id: `pdf-${Date.now()}-${i}`,
          date, description, amount, currency, isDebit,
          source: 'bank' as const,
          bankName: (bankSource ?? 'other') as 'poalim' | 'leumi' | 'max' | 'isracard' | 'other',
        };
      })
      .filter(Boolean);

    console.log(`[PDF] ${usedGemini ? 'Gemini OCR' : 'Groq'}: ${transactions.length} transactions`);
    res.json({ transactions, pageCount, charCount: rawText.length });
  } catch (e) {
    console.error('[PDF] LLM error:', e);
    res.status(500).json({ error: String(e) });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/pdf/analyze-doc
// Extracts cost line items from a property management document (clearing report,
// insurance, municipal tax bill, etc.) — personal data is stripped before the
// text reaches the LLM.
// ─────────────────────────────────────────────────────────────────────────────
router.post('/analyze-doc', async (req: Request, res: Response) => {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: 'GROQ_API_KEY not set in server .env' });
    return;
  }

  const { base64, docType, mimeType: clientMime } = req.body as {
    base64: string; docType: string; mimeType?: string;
  };
  if (!base64) {
    res.status(400).json({ error: 'Missing base64 data' });
    return;
  }

  const isHtmlDoc = HTML_MIME_TYPES.has(clientMime ?? '');
  const resolvedMime = (clientMime && SUPPORTED_IMAGE_TYPES[clientMime.replace('image/', '').replace('application/', '')])
    ?? SUPPORTED_IMAGE_TYPES[clientMime?.split('/')[1] ?? '']
    ?? 'application/pdf';
  const isImage = !isHtmlDoc && resolvedMime !== 'application/pdf';

  let rawText = '';
  let usedGeminiDoc = false;

  if (isHtmlDoc) {
    // HTML — decode and strip tags immediately; rest of flow treats it as plain text
    const htmlContent = Buffer.from(base64, 'base64').toString('utf8');
    rawText = htmlToText(htmlContent);
  } else if (!isImage) {
    try {
      const buffer  = Buffer.from(base64, 'base64');
      const pdfData = await pdfParse(buffer, { max: 0 });
      rawText = pdfData.text ?? '';
    } catch (e) {
      console.error('[PDF:doc] Parse error:', e);
    }
  }

  const DOC_HINTS: Record<string, string> = {
    clearing_report: 'דוח סליקה / דוח ניהול נכס — יכול לכלול: דמי ניהול, ביטוח, ועד בית, תחזוקה, ניקיון, חשמל ומים לרכוש משותף',
    insurance:       'פוליסת ביטוח נכס — יכול לכלול: פרמיה שנתית, דמי ביטוח חיים/מבנה/תכולה',
    municipal_tax:   'שובר ארנונה — יכול לכלול: חיוב שנתי/רבעוני/חודשי לארנונה',
    other:           'מסמך כספי כללי הקשור לנכס',
  };

  const hint = DOC_HINTS[docType] ?? DOC_HINTS.other;

  const VALID_CATEGORIES = [
    'management','insurance','municipal_tax','maintenance',
    'building_committee','brokerage','lawyer','appraiser',
    'inspector','mortgage_advisor','other',
  ];

  const prompt = `You are a financial extraction engine for Israeli real estate documents (PDF or scanned image).

Document type hint: ${hint}

Extract ALL cost/expense line items. For each item return:
- category: one of [${VALID_CATEGORIES.join(', ')}]
- name: short Hebrew label for the cost (e.g. "דמי ניהול", "ביטוח מבנה", "ועד בית")
- amount: positive number (ILS unless clearly USD)
- frequency: "monthly" | "annual" | "one_time"
- currency: "ILS" (default) or "USD"
- confidence: "high" | "medium" | "low"

Rules:
1. IGNORE personal info (names, IDs, account numbers, addresses, phones)
2. IGNORE balance carried-forward rows and running totals
3. If the document shows a monthly total, set frequency="monthly"
4. If yearly/annual premium, set frequency="annual"
5. One-time charges (repairs, fees): frequency="one_time"
6. Also return a one-sentence Hebrew summary of the document.

Return ONLY valid JSON:
{
  "summary": "תיאור קצר של המסמך",
  "period": "YYYY-MM or YYYY or null",
  "totalAmount": 0,
  "items": [
    {"category":"management","name":"דמי ניהול","amount":800,"frequency":"monthly","currency":"ILS","confidence":"high"}
  ]
}`;

  let llmRawDoc = '';

  if (isImage || (!isHtmlDoc && !rawText.trim())) {
    // Image file OR scanned PDF → Gemini vision
    const geminiKey = process.env.VITE_GEMINI_API_KEY;
    if (!geminiKey) {
      res.status(422).json({
        error: 'עיבוד תמונות וקבצים סרוקים דורש GEMINI_API_KEY בקובץ server/.env.',
      });
      return;
    }
    console.log(`[doc] ${isImage ? `Image (${resolvedMime})` : 'No text'} → Gemini vision`);
    usedGeminiDoc = true;
    llmRawDoc = await callGeminiVisual(geminiKey, base64, resolvedMime as ImageMimeType, prompt);
  } else {
    const sanitized = sanitizePdfText(rawText).slice(0, 10000);
    const src = isHtmlDoc ? 'HTML' : 'PDF text';
    console.log(`[doc] ${src}: ${sanitized.length} chars → Groq (docType=${docType})`);
    llmRawDoc = await callGroq(apiKey, `${prompt}\n\nDocument content:\n${sanitized}`);
  }

  try {
    const parsed = extractJSON<{
      summary: string;
      period?: string;
      totalAmount?: number;
      items: {
        category: string; name: string; amount: number;
        frequency: string; currency: string; confidence: string;
      }[];
    }>(llmRawDoc);

    if (!parsed) {
      res.status(422).json({ error: 'LLM לא החזיר מבנה תקין' });
      return;
    }

    // Normalize and validate items
    const items = (parsed.items ?? [])
      .filter(it => it.amount > 0 && it.name)
      .map(it => ({
        category:   VALID_CATEGORIES.includes(it.category) ? it.category : 'other',
        name:       String(it.name).trim(),
        amount:     Math.abs(Number(it.amount) || 0),
        frequency:  ['monthly','annual','one_time'].includes(it.frequency) ? it.frequency : 'monthly',
        currency:   it.currency?.toUpperCase() === 'USD' ? 'USD' : 'ILS',
        confidence: ['high','medium','low'].includes(it.confidence) ? it.confidence : 'medium',
      }));

    console.log(`[PDF:doc] ${usedGeminiDoc ? 'Gemini OCR' : 'Groq'}: ${items.length} items`);
    res.json({
      summary:     parsed.summary ?? '',
      period:      parsed.period  ?? null,
      totalAmount: parsed.totalAmount ?? 0,
      items,
    });
  } catch (e) {
    console.error('[PDF:doc] LLM error:', e);
    res.status(500).json({ error: String(e) });
  }
});

export default router;

