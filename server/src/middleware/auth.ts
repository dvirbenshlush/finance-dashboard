import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET ?? 'otzar-secret-change-in-prod';

export interface AuthRequest extends Request {
  userId?: number;
  userEmail?: string;
}

export function requireAuth(req: AuthRequest, res: Response, next: NextFunction): void {
  const header = req.headers['authorization'];
  const token  = header?.startsWith('Bearer ') ? header.slice(7) : null;

  if (!token) {
    res.status(401).json({ error: 'לא מורשה — יש להתחבר' });
    return;
  }

  try {
    const payload = jwt.verify(token, JWT_SECRET) as { userId: number; email: string };
    req.userId    = payload.userId;
    req.userEmail = payload.email;
    next();
  } catch {
    res.status(401).json({ error: 'טוקן לא תקין — יש להתחבר שוב' });
  }
}
