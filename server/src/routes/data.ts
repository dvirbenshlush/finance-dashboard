import { Router, Request, Response } from 'express';
import fs from 'fs';
import path from 'path';

const router = Router();

// Data files live in /server/data/ — persisted as JSON on disk
const DATA_DIR = path.join(__dirname, '../../data');
const TRANSACTIONS_FILE = path.join(DATA_DIR, 'transactions.json');
const PORTFOLIO_FILE = path.join(DATA_DIR, 'portfolio.json');

const readJSON = <T>(filePath: string, fallback: T): T => {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T;
  } catch {
    return fallback;
  }
};

const writeJSON = (filePath: string, data: unknown): void => {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
};

// --- Transactions ---

router.get('/transactions', (_req: Request, res: Response) => {
  const transactions = readJSON(TRANSACTIONS_FILE, []);
  res.json(transactions);
});

router.post('/transactions', (req: Request, res: Response) => {
  const incoming: unknown[] = req.body;
  if (!Array.isArray(incoming)) {
    res.status(400).json({ error: 'Expected an array of transactions' });
    return;
  }

  // Replace — the frontend owns deduplication; DB just persists the latest state
  writeJSON(TRANSACTIONS_FILE, incoming);
  res.json({ saved: incoming.length });
});

router.delete('/transactions', (_req: Request, res: Response) => {
  writeJSON(TRANSACTIONS_FILE, []);
  res.json({ cleared: true });
});

// --- Portfolio (assets + loans) ---

router.get('/portfolio', (_req: Request, res: Response) => {
  const portfolio = readJSON(PORTFOLIO_FILE, null);
  res.json(portfolio);
});

router.post('/portfolio', (req: Request, res: Response) => {
  writeJSON(PORTFOLIO_FILE, req.body);
  res.json({ saved: true });
});

export default router;
