import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import pool from '../db';

const router = Router();

const JWT_SECRET = process.env.JWT_SECRET ?? 'otzar-secret-change-in-prod';
const TOKEN_TTL  = '30d';

function sign(userId: number, email: string): string {
  return jwt.sign({ userId, email }, JWT_SECRET, { expiresIn: TOKEN_TTL });
}

// POST /api/auth/register
router.post('/register', async (req: Request, res: Response) => {
  const { email, password } = req.body as { email?: string; password?: string };

  if (!email || !password) {
    res.status(400).json({ error: 'נדרש אימייל וסיסמה' });
    return;
  }
  if (password.length < 6) {
    res.status(400).json({ error: 'הסיסמה חייבת להיות לפחות 6 תווים' });
    return;
  }

  try {
    const existing = await pool.query('SELECT id FROM users WHERE email = $1', [email.toLowerCase()]);
    if (existing.rows.length > 0) {
      res.status(409).json({ error: 'כתובת האימייל כבר רשומה' });
      return;
    }

    const hash = await bcrypt.hash(password, 12);
    const { rows } = await pool.query<{ id: number }>(
      'INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id',
      [email.toLowerCase(), hash],
    );
    const user = rows[0];
    res.status(201).json({ token: sign(user.id, email.toLowerCase()), email: email.toLowerCase() });
  } catch (e) {
    console.error('[auth] register error:', e);
    res.status(500).json({ error: 'שגיאת שרת — נסה שוב' });
  }
});

// POST /api/auth/login
router.post('/login', async (req: Request, res: Response) => {
  const { email, password } = req.body as { email?: string; password?: string };

  if (!email || !password) {
    res.status(400).json({ error: 'נדרש אימייל וסיסמה' });
    return;
  }

  try {
    const { rows } = await pool.query<{ id: number; password_hash: string }>(
      'SELECT id, password_hash FROM users WHERE email = $1',
      [email.toLowerCase()],
    );
    if (rows.length === 0) {
      res.status(401).json({ error: 'אימייל או סיסמה שגויים' });
      return;
    }
    const user = rows[0];
    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) {
      res.status(401).json({ error: 'אימייל או סיסמה שגויים' });
      return;
    }
    res.json({ token: sign(user.id, email.toLowerCase()), email: email.toLowerCase() });
  } catch (e) {
    console.error('[auth] login error:', e);
    res.status(500).json({ error: 'שגיאת שרת — נסה שוב' });
  }
});

export default router;
