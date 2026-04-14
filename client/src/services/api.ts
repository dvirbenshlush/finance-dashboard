import type { Transaction, Portfolio, GeminiInsight, TransactionCategory, StockTransaction } from '../types';

const BASE = 'http://localhost:3001/api';

const request = async <T>(path: string, options?: RequestInit): Promise<T> => {
  const token = localStorage.getItem('otzar_token');
  const res = await fetch(`${BASE}${path}`, {
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...options,
  });
  if (res.status === 401) {
    // Token expired or invalid — clear it so the app shows the login screen
    localStorage.removeItem('otzar_token');
    localStorage.removeItem('otzar_email');
    window.location.reload();
    throw new Error('פג תוקף החיבור — יש להתחבר מחדש');
  }
  if (!res.ok) throw new Error(`API ${path} failed: ${res.status}`);
  return res.json() as Promise<T>;
};

export const api = {
  // --- Bank transactions ---
  getTransactions: () => request<Transaction[]>('/transactions'),
  // Merges new transactions with server-stored ones (server deduplicates by id)
  saveTransactions: (txs: Transaction[]) =>
    request<{ saved: number; added: number }>('/transactions', {
      method: 'POST',
      body: JSON.stringify(txs),
    }),
  clearTransactions: () => request<{ cleared: boolean }>('/transactions', { method: 'DELETE' }),

  // --- Stock transactions ---
  getStockTransactions: () => request<StockTransaction[]>('/stock-transactions'),
  // Merges new stock transactions (server deduplicates by content key)
  saveStockTransactions: (txs: StockTransaction[]) =>
    request<{ saved: number; added: number }>('/stock-transactions', {
      method: 'POST',
      body: JSON.stringify(txs),
    }),
  clearStockTransactions: () => request<{ cleared: boolean }>('/stock-transactions', { method: 'DELETE' }),

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

  // Parse a PDF or image bank statement via AI — returns extracted transactions
  parsePdf: (base64: string, bankSource: string, mimeType = 'application/pdf') =>
    request<{
      transactions: import('../types').Transaction[];
      pageCount: number;
      charCount: number;
    }>('/pdf/parse', {
      method: 'POST',
      body: JSON.stringify({ base64, bankSource, mimeType }),
    }),

  // Analyze a property document (clearing report, insurance, etc.) — returns cost line items
  analyzePropDoc: (base64: string, docType: string, mimeType = 'application/pdf') =>
    request<{
      summary: string;
      period: string | null;
      totalAmount: number;
      items: {
        category: string;
        name: string;
        amount: number;
        frequency: string;
        currency: string;
        confidence: string;
      }[];
    }>('/pdf/analyze-doc', {
      method: 'POST',
      body: JSON.stringify({ base64, docType, mimeType }),
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
