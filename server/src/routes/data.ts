import { Router, Request, Response } from 'express';
import pool from '../db';
import { sanitizeText } from '../utils/sanitize';

const router = Router();

/** Stable content-based dedup key for stock transactions.
 *  Does NOT rely on the LLM-assigned id (which changes on every upload). */
const stockTxKey = (tx: Record<string, unknown>): string =>
  `${tx.date}|${String(tx.symbol ?? '').toUpperCase()}|${tx.action}|${Math.round(Number(tx.amount) || 0)}`;

// ── Bank transactions ─────────────────────────────────────────────────────────

router.get('/transactions', async (_req: Request, res: Response) => {
  const { rows } = await pool.query(
    `SELECT id, date, description, amount, currency, category,
            source, bank_name AS "bankName", is_debit AS "isDebit"
     FROM bank_transactions
     ORDER BY date DESC`
  );
  res.json(rows);
});

router.post('/transactions', async (req: Request, res: Response) => {
  const incoming = req.body as Record<string, unknown>[];
  if (!Array.isArray(incoming)) {
    res.status(400).json({ error: 'Expected an array of transactions' });
    return;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    let added = 0;
    for (const tx of incoming) {
      const result = await client.query(
        `INSERT INTO bank_transactions
           (id, date, description, amount, currency, category, source, bank_name, is_debit)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (id) DO NOTHING`,
        [
          tx.id ?? '',
          tx.date ?? '',
          sanitizeText(String(tx.description ?? '')),   // strip PII before saving
          Number(tx.amount) || 0,
          tx.currency ?? 'ILS',
          tx.category ?? null,
          tx.source ?? null,
          tx.bankName ?? null,
          Boolean(tx.isDebit),
        ]
      );
      if (result.rowCount && result.rowCount > 0) added++;
    }
    await client.query('COMMIT');

    const { rows } = await client.query('SELECT COUNT(*)::int AS n FROM bank_transactions');
    res.json({ saved: (rows[0] as { n: number }).n, added });
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
});

router.delete('/transactions', async (_req: Request, res: Response) => {
  await pool.query('DELETE FROM bank_transactions');
  res.json({ cleared: true });
});

// Update a single transaction's category (used by AI categorizer result)
router.patch('/transactions/:id', async (req: Request, res: Response) => {
  const { category } = req.body as { category: string };
  await pool.query('UPDATE bank_transactions SET category=$1 WHERE id=$2', [category, req.params.id]);
  res.json({ ok: true });
});

// ── Stock transactions ────────────────────────────────────────────────────────

router.get('/stock-transactions', async (_req: Request, res: Response) => {
  const { rows } = await pool.query(
    `SELECT id, date, symbol, name, action, quantity, price, amount, currency
     FROM stock_transactions
     ORDER BY date ASC`
  );
  res.json(rows);
});

router.post('/stock-transactions', async (req: Request, res: Response) => {
  const incoming = req.body as Record<string, unknown>[];
  if (!Array.isArray(incoming)) { res.status(400).json({ error: 'Expected array' }); return; }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Use current count as ID offset so ids remain stable across uploads
    const { rows: countRows } = await client.query('SELECT COUNT(*)::int AS n FROM stock_transactions');
    let offset = (countRows[0] as { n: number }).n;
    let added = 0;

    for (const tx of incoming) {
      const result = await client.query(
        `INSERT INTO stock_transactions
           (id, date, symbol, name, action, quantity, price, amount, currency, content_key)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT (content_key) DO NOTHING`,
        [
          `stx-${offset++}`,
          tx.date ?? '',
          String(tx.symbol ?? '').toUpperCase(),
          tx.name ?? null,
          tx.action ?? 'other',
          tx.quantity != null ? Number(tx.quantity) : null,
          tx.price    != null ? Number(tx.price)    : null,
          Math.abs(Number(tx.amount) || 0),
          tx.currency ?? 'USD',
          stockTxKey(tx),
        ]
      );
      if (result.rowCount && result.rowCount > 0) added++;
    }

    await client.query('COMMIT');

    const { rows } = await client.query('SELECT COUNT(*)::int AS n FROM stock_transactions');
    res.json({ saved: (rows[0] as { n: number }).n, added });
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
});

router.delete('/stock-transactions', async (_req: Request, res: Response) => {
  await pool.query('DELETE FROM stock_transactions');
  res.json({ cleared: true });
});

// ── Portfolio (assets + loans) ────────────────────────────────────────────────

router.get('/portfolio', async (_req: Request, res: Response) => {
  const { rows } = await pool.query('SELECT data FROM portfolio WHERE id=1');
  res.json(rows.length > 0 ? JSON.parse((rows[0] as { data: string }).data) : null);
});

router.post('/portfolio', async (req: Request, res: Response) => {
  await pool.query(
    `INSERT INTO portfolio (id, data) VALUES (1,$1)
     ON CONFLICT (id) DO UPDATE SET data=EXCLUDED.data`,
    [JSON.stringify(req.body)]
  );
  res.json({ saved: true });
});

export default router;
