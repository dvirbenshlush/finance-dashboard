import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import dataRouter from './routes/data';
import geminiRouter from './routes/gemini';
import classifyRouter from './routes/classify';
import portfolioRouter from './routes/portfolio';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json({ limit: '10mb' }));

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', message: 'Finance Dashboard API is running' });
});

app.use('/api', dataRouter);
app.use('/api/gemini', geminiRouter);
app.use('/api/classify', classifyRouter);
app.use('/api/portfolio', portfolioRouter);

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
