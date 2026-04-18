import { Router, Request, Response } from 'express';
import pool from '../db';

const router = Router();

// GET /api/settings — returns all key-value pairs as { key: parsedValue }
router.get('/', async (_req: Request, res: Response) => {
  const { rows } = await pool.query(`SELECT key, data FROM settings`);
  const result: Record<string, unknown> = {};
  for (const row of rows) {
    try { result[row.key as string] = JSON.parse(row.data as string); }
    catch { result[row.key as string] = row.data; }
  }
  res.json(result);
});

// PUT /api/settings/:key — upsert a single key
router.put('/:key', async (req: Request, res: Response) => {
  const { key } = req.params;
  const data = JSON.stringify(req.body);
  await pool.query(
    `INSERT INTO settings (key, data, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (key) DO UPDATE SET data = $2, updated_at = NOW()`,
    [key, data],
  );
  res.json({ saved: true });
});

// DELETE /api/settings/:key — remove a key
router.delete('/:key', async (req: Request, res: Response) => {
  const { key } = req.params;
  await pool.query(`DELETE FROM settings WHERE key = $1`, [key]);
  res.json({ deleted: true });
});

export default router;
