import type { Transaction, Portfolio, GeminiInsight, TransactionCategory } from '../types';

const BASE = 'http://localhost:3001/api';

const request = async <T>(path: string, options?: RequestInit): Promise<T> => {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  if (!res.ok) throw new Error(`API ${path} failed: ${res.status}`);
  return res.json() as Promise<T>;
};

export const api = {
  // --- Transactions ---
  getTransactions: () => request<Transaction[]>('/transactions'),
  // Replaces all stored transactions with the current state
  saveTransactions: (txs: Transaction[]) =>
    request<{ saved: number }>('/transactions', {
      method: 'POST',
      body: JSON.stringify(txs),
    }),
  clearTransactions: () => request<{ cleared: boolean }>('/transactions', { method: 'DELETE' }),

  // --- Portfolio ---
  getPortfolio: () => request<Portfolio | null>('/portfolio'),
  savePortfolio: (portfolio: Portfolio) =>
    request<{ saved: boolean }>('/portfolio', {
      method: 'POST',
      body: JSON.stringify(portfolio),
    }),

  // --- Gemini AI ---
  // Auto-categorize a list of transactions; returns [{id, category}]
  categorize: (transactions: Pick<Transaction, 'id' | 'description' | 'amount' | 'isDebit'>[]) =>
    request<{ id: string; category: TransactionCategory }[]>('/gemini/categorize', {
      method: 'POST',
      body: JSON.stringify({ transactions }),
    }),

  // Analyze spending patterns; returns GeminiInsight[]
  analyze: (categoryTotals: Record<string, number>, monthlyAvgBurn: number) =>
    request<GeminiInsight[]>('/gemini/analyze', {
      method: 'POST',
      body: JSON.stringify({ categoryTotals, monthlyAvgBurn }),
    }),

  // Classify Excel file via pure LLM classifier
  classifyExcel: (base64: string, filename: string) =>
    request<{
      filename: string;
      rowsExtracted: number;
      results: {
        id: string;
        description: string;
        amount: number;
        category: string;
        confidence: 'high' | 'medium' | 'low';
        reasoning: string;
      }[];
      summary: Record<string, number>;
    }>('/classify/excel', {
      method: 'POST',
      body: JSON.stringify({ base64, filename }),
    }),
};
