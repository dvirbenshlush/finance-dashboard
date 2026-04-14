import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import dataRouter from './routes/data';
import geminiRouter from './routes/gemini';
import classifyRouter from './routes/classify';
import portfolioRouter from './routes/portfolio';
import pdfRouter from './routes/pdf';
import authRouter from './routes/auth';
import { requireAuth } from './middleware/auth';
import { initDb } from './db';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json({ limit: '30mb' })); // PDFs can be large in base64

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', message: 'Finance Dashboard API is running' });
});

// Public — no auth required
app.use('/api/auth', authRouter);

// Protected — all routes below require a valid JWT
app.use('/api', requireAuth);
app.use('/api', dataRouter);
app.use('/api/gemini', geminiRouter);
app.use('/api/classify', classifyRouter);
app.use('/api/portfolio', portfolioRouter);
app.use('/api/pdf', pdfRouter);

initDb()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Server running on http://localhost:${PORT}`);
    });
  })
  .catch((err) => {
    console.error('❌ Failed to connect to database:', err.message);
    process.exit(1);
  });
