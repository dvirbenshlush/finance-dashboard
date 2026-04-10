import { Router, Request, Response } from 'express';
import * as XLSX from 'xlsx';
import {
  classifyOne,
  classifyBatch,
  buildExamples,
  type TransactionInput,
  type FewShotExample,
} from '../llm/command-classification';

const router = Router();

/**
 * POST /api/classify/one
 * Test classifying a single transaction.
 * Body: { description: string; amount: number }
 */
router.post('/one', async (req: Request, res: Response) => {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) { res.status(500).json({ error: 'GROQ_API_KEY not set' }); return; }

  const { description, amount } = req.body as { description: string; amount: number };
  if (!description) { res.status(400).json({ error: 'description required' }); return; }

  try {
    const result = await classifyOne(apiKey, { id: 'test', description, amount: amount ?? 0 });
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

/**
 * POST /api/classify/batch
 * Classify a batch of transactions with optional few-shot examples.
 * Body: {
 *   transactions: [{id, description, amount}],
 *   examples?: [{description, amount, category}]   // few-shot labeled examples
 * }
 */
router.post('/batch', async (req: Request, res: Response) => {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) { res.status(500).json({ error: 'GROQ_API_KEY not set' }); return; }

  const { transactions, examples = [] } = req.body as {
    transactions: TransactionInput[];
    examples?: FewShotExample[];
  };

  if (!transactions?.length) { res.status(400).json({ error: 'transactions[] required' }); return; }
  if (transactions.length > 30) {
    res.status(400).json({ error: 'Max 30 transactions per batch for the test endpoint' });
    return;
  }

  console.log(`[classify] Batch of ${transactions.length} with ${examples.length} examples`);

  try {
    const results = await classifyBatch(apiKey, transactions, examples, (done, total) => {
      console.log(`[classify] ${done}/${total}`);
    });

    const summary = results.reduce<Record<string, number>>((acc, r) => {
      acc[r.category] = (acc[r.category] ?? 0) + 1;
      return acc;
    }, {});

    res.json({ results, summary, total: results.length });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

/**
 * POST /api/classify/excel
 * Upload an Excel file, extract transactions, classify them with the LLM,
 * and return structured results.
 *
 * Multipart: field "file" (xlsx/csv)
 * Query: ?sheet=0 (sheet index, default 0)
 *
 * Uses raw base64 body for simplicity (no multer):
 * Body: { base64: string; filename: string; examples?: FewShotExample[] }
 */
router.post('/excel', async (req: Request, res: Response) => {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) { res.status(500).json({ error: 'GROQ_API_KEY not set' }); return; }

  const { base64, filename = 'upload.xlsx', examples = [] } = req.body as {
    base64: string;
    filename?: string;
    examples?: FewShotExample[];
  };

  if (!base64) { res.status(400).json({ error: 'base64 field required' }); return; }

  // Parse Excel
  let transactions: TransactionInput[];
  try {
    const buffer = Buffer.from(base64, 'base64');
    const wb = XLSX.read(buffer, { type: 'buffer', cellDates: false });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const raw = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: '' }) as string[][];

    // Find header row (contains Hebrew keywords)
    const KEYWORDS = ['תאריך', 'תיאור', 'פרטים', 'סכום', 'חובה', 'זכות', 'שם', 'מוטב'];
    let headerIdx = 0;
    for (let i = 0; i < Math.min(raw.length, 15); i++) {
      const rowStr = raw[i].map(c => String(c).trim().toLowerCase());
      if (KEYWORDS.filter(k => rowStr.some(c => c.includes(k.toLowerCase()))).length >= 2) {
        headerIdx = i; break;
      }
    }

    const headers = raw[headerIdx].map(c => String(c).trim());
    const pick = (row: string[], candidates: string[]) => {
      for (const cand of candidates) {
        const idx = headers.findIndex(h => h.includes(cand));
        if (idx >= 0) return String(row[idx] ?? '').trim();
      }
      return '';
    };

    transactions = raw
      .slice(headerIdx + 1)
      .filter(row => row.some(c => String(c).trim()))
      .map((row, i) => {
        const desc = pick(row, ['תיאור', 'פרטים', 'שם בית עסק', 'שם', 'מוטב', 'נושא']);
        const rawAmt = pick(row, ['סכום', 'חובה', 'זכות', 'חיוב', 'Amount']);
        const amount = Math.abs(parseFloat(String(rawAmt).replace(/[,\s₪$]/g, '')) || 0);
        if (!desc && amount === 0) return null;
        return { id: `row-${i}`, description: desc, amount } as TransactionInput;
      })
      .filter((t): t is TransactionInput => t !== null && t.amount > 0)
      .slice(0, 30); // limit to 30 for test endpoint

  } catch (e) {
    res.status(400).json({ error: `Failed to parse Excel: ${String(e)}` });
    return;
  }

  if (!transactions.length) {
    res.status(400).json({ error: 'No valid transactions found in file' });
    return;
  }

  console.log(`[classify/excel] ${filename}: ${transactions.length} rows extracted`);

  // Build auto few-shot from already-labeled examples if provided
  const fewShot = examples.length > 0 ? buildExamples(
    examples.map(e => ({ ...e })),
  ) : [];

  try {
    const results = await classifyBatch(apiKey, transactions, fewShot, (done, total) => {
      console.log(`[classify/excel] ${done}/${total}`);
    });

    const summary = results.reduce<Record<string, number>>((acc, r) => {
      acc[r.category] = (acc[r.category] ?? 0) + 1;
      return acc;
    }, {});

    res.json({
      filename,
      rowsExtracted: transactions.length,
      results,
      summary,
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

export default router;
