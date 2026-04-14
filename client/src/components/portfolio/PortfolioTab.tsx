import { type FC, Fragment, useRef, useState, useMemo, useEffect } from 'react';
import {
  PieChart, Pie, Cell, Tooltip, ResponsiveContainer,
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Legend,
} from 'recharts';
import * as pdfjsLib from 'pdfjs-dist';
import type { StockTransaction, PortfolioAIAnalysis } from '../../types';
import { api } from '../../services/api';

// Point pdfjs to its worker (bundled with Vite)
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url,
).toString();

const BASE = 'http://localhost:3001/api';

const fmt = (v: number, currency = 'USD') =>
  new Intl.NumberFormat('he-IL', { style: 'currency', currency, maximumFractionDigits: 0 }).format(v);

const fmtILS = (v: number) => fmt(v, 'ILS');

const COLORS = ['#3b82f6','#10b981','#f59e0b','#ef4444','#8b5cf6','#06b6d4','#f97316','#84cc16','#ec4899','#6366f1'];

const ACTION_LABEL: Record<string, string> = {
  buy: '📈 קניה', sell: '📉 מכירה', dividend: '💰 דיבידנד',
  fee: '💸 עמלה', interest: '🏦 ריבית', other: '📋 אחר',
};

const ACTION_COLOR: Record<string, string> = {
  buy: 'bg-blue-50 text-blue-700', sell: 'bg-green-50 text-green-700',
  dividend: 'bg-yellow-50 text-yellow-700', fee: 'bg-red-50 text-red-600',
  interest: 'bg-purple-50 text-purple-700', other: 'bg-gray-100 text-gray-600',
};

// ── helpers ──────────────────────────────────────────────────────────────────

/** Extract all text from a PDF file using pdfjs-dist (runs in browser — has DOM). */
async function extractPdfText(file: File): Promise<string> {
  const arrayBuffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  const parts: string[] = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    const pageText = content.items
      .map((item) => ('str' in item ? item.str : ''))
      .join(' ');
    parts.push(pageText);
  }
  return parts.join('\n');
}

/** Send extracted text to server → LLM → structured transactions. */
async function parseFile(file: File): Promise<StockTransaction[]> {
  let rawText: string;

  if (/\.pdf$/i.test(file.name)) {
    rawText = await extractPdfText(file);
  } else {
    rawText = await file.text();
  }

  if (!rawText.trim()) throw new Error('לא נמצא טקסט בקובץ');

  const res = await fetch(`${BASE}/portfolio/parse`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rawText, filename: file.name }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({})) as { error?: string };
    throw new Error(err.error ?? `Server error ${res.status}`);
  }
  const data = await res.json() as { transactions: StockTransaction[] };
  return data.transactions;
}

// ── Types ─────────────────────────────────────────────────────────────────────

interface Quote {
  symbol: string;
  price: number;
  change: number;
  changePercent: number;
  currency: string;
}

interface Position {
  symbol: string;
  name?: string;
  quantityBought: number;
  quantitySold: number;
  quantityHeld: number;       // bought - sold
  totalBought: number;        // total cash spent on buys
  totalSold: number;          // total cash received from sells
  avgCostPerShare: number;    // weighted avg: totalBought / quantityBought
  costBasis: number;          // avgCostPerShare × quantityHeld (remaining position cost)
  dividends: number;
  fees: number;
  realizedPnL: number;        // proceeds - cost of sold shares + dividends - fees
  // Populated after quote fetch:
  currentPrice?: number;
  currentValue?: number;
  unrealizedPnL?: number;
  unrealizedPct?: number;
  dailyChangePct?: number;
}

// ── Position computation (weighted average cost method) ───────────────────────

function computePositions(txs: StockTransaction[]): Record<string, Position> {
  const bySymbol: Record<string, Position> = {};

  for (const tx of txs) {
    const sym = tx.symbol.toUpperCase();
    if (!bySymbol[sym]) {
      bySymbol[sym] = {
        symbol: sym, name: tx.name,
        quantityBought: 0, quantitySold: 0, quantityHeld: 0,
        totalBought: 0, totalSold: 0,
        avgCostPerShare: 0, costBasis: 0,
        dividends: 0, fees: 0, realizedPnL: 0,
      };
    }
    const p = bySymbol[sym];
    if (tx.name && !p.name) p.name = tx.name;

    // Infer quantity when LLM didn't extract it but price is available
    const inferQty = (t: StockTransaction) =>
      (t.quantity && t.quantity > 0) ? t.quantity
      : (t.price && t.price > 0)     ? t.amount / t.price
      : 0;

    // LLM sometimes returns negative amounts — normalise to positive
    const amt = Math.abs(tx.amount);

    if (tx.action === 'buy') {
      const qty = inferQty(tx);
      p.totalBought    += amt;   // cumulative total invested (KPI display)
      p.quantityBought += qty;
      p.costBasis      += amt;   // running cost of currently held shares
    } else if (tx.action === 'sell') {
      const qty = inferQty(tx);
      // Average cost per share of currently held position at moment of sale
      const avgAtSale  = p.quantityHeld > 0.0001 ? p.costBasis / p.quantityHeld : 0;
      const costOfSold = avgAtSale * qty;
      p.realizedPnL   += amt - costOfSold;
      p.totalSold      += amt;
      p.quantitySold   += qty;
      p.costBasis       = Math.max(0, p.costBasis - costOfSold); // reduce by sold portion
    } else if (tx.action === 'dividend') {
      p.dividends   += amt;
      p.realizedPnL += amt;
    } else if (tx.action === 'fee') {
      p.fees        += amt;
      p.realizedPnL -= amt;
    }

    p.quantityHeld    = Math.max(0, p.quantityBought - p.quantitySold);
    p.avgCostPerShare = p.quantityHeld > 0.0001 ? p.costBasis / p.quantityHeld : 0;
  }

  return bySymbol;
}

function aggregateTotals(all: Position[]) {
  return {
    totalCostBasis:    all.reduce((s, p) => s + p.costBasis, 0),
    totalCurrentValue: all.reduce((s, p) => s + (p.currentValue ?? p.costBasis), 0),
    totalUnrealized:   all.reduce((s, p) => s + (p.unrealizedPnL ?? 0), 0),
    totalRealized:     all.reduce((s, p) => s + p.realizedPnL, 0),
    totalDividends:    all.reduce((s, p) => s + p.dividends, 0),
    totalFees:         all.reduce((s, p) => s + p.fees, 0),
    totalBought:       all.reduce((s, p) => s + p.totalBought, 0),
  };
}

// ── Manual transaction store ──────────────────────────────────────────────────
// Replaces the old "ManualPosition" aggregate. Each entry is a full StockTransaction
// entered by the user. They are fed directly into computePositions so position
// math (WAVG cost basis, realized P&L) works the same as for uploaded transactions.

const LS_MANUAL_TXS = 'riseup_manual_txs';
/** Legacy key — kept only for one-time migration on first load. */
const LS_MANUAL_LEGACY = 'riseup_manual_positions';

interface LegacyManualPosition {
  id: string; symbol: string; name?: string;
  quantityHeld: number; avgCostPerShare: number; date?: string;
}

// ── Sub-components ────────────────────────────────────────────────────────────

const KpiCard: FC<{ label: string; value: string; sub?: string; color?: string }> = ({ label, value, sub, color = 'text-gray-800' }) => (
  <div className="bg-white rounded-xl border border-gray-200 p-4">
    <p className="text-xs text-gray-400 mb-1">{label}</p>
    <p className={`text-xl font-bold ${color}`}>{value}</p>
    {sub && <p className="text-xs text-gray-400 mt-0.5">{sub}</p>}
  </div>
);

const AIAnalysisPanel: FC<{ analysis: PortfolioAIAnalysis }> = ({ analysis }) => (
  <div className="space-y-4">
    {/* Summary */}
    <div className="bg-blue-50 border border-blue-200 rounded-xl p-4">
      <p className="text-sm font-semibold text-blue-800 mb-1">📋 סיכום כללי</p>
      <p className="text-sm text-blue-700">{analysis.summary}</p>
    </div>

    {/* Insights */}
    {analysis.insights?.length > 0 && (
      <div className="space-y-2">
        <p className="text-xs font-bold text-gray-500 uppercase tracking-wide">תובנות</p>
        {analysis.insights.map((ins, i) => (
          <div key={i} className={`rounded-lg p-3 border-r-4 ${
            ins.severity === 'high'   ? 'bg-red-50 border-red-500' :
            ins.severity === 'medium' ? 'bg-orange-50 border-orange-400' :
                                        'bg-yellow-50 border-yellow-400'
          }`}>
            <p className="text-sm font-semibold text-gray-800">{ins.title}</p>
            <p className="text-xs text-gray-600 mt-0.5">{ins.description}</p>
          </div>
        ))}
      </div>
    )}

    {/* Recommendations */}
    {analysis.recommendations?.length > 0 && (
      <div className="space-y-2">
        <p className="text-xs font-bold text-gray-500 uppercase tracking-wide">המלצות</p>
        {analysis.recommendations.map((rec, i) => (
          <div key={i} className={`rounded-lg p-3 border-r-4 ${
            rec.priority === 'high'   ? 'bg-green-50 border-green-500' :
            rec.priority === 'medium' ? 'bg-blue-50 border-blue-400' :
                                        'bg-gray-50 border-gray-300'
          }`}>
            <div className="flex items-center gap-2">
              <p className="text-sm font-semibold text-gray-800 flex-1">{rec.title}</p>
              <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                rec.priority === 'high' ? 'bg-green-100 text-green-700' :
                rec.priority === 'medium' ? 'bg-blue-100 text-blue-700' : 'bg-gray-100 text-gray-600'
              }`}>
                {rec.priority === 'high' ? 'דחוף' : rec.priority === 'medium' ? 'מומלץ' : 'לשקול'}
              </span>
            </div>
            <p className="text-xs text-gray-600 mt-0.5">{rec.description}</p>
          </div>
        ))}
      </div>
    )}
  </div>
);

// ── Main tab ──────────────────────────────────────────────────────────────────

const PortfolioTab: FC = () => {
  const inputRef = useRef<HTMLInputElement>(null);
  const [transactions, setTransactions] = useState<StockTransaction[]>([]);
  const [loadingStored, setLoadingStored] = useState(true);
  const [uploading, setUploading]       = useState(false);
  const [uploadError, setUploadError]   = useState<string | null>(null);
  const [fileName, setFileName]         = useState<string | null>(null);
  const [analyzing, setAnalyzing]       = useState(false);
  const [analysis, setAnalysis]         = useState<PortfolioAIAnalysis | null>(null);
  const [analyzeError, setAnalyzeError] = useState<string | null>(null);
  const [isDragging, setIsDragging]     = useState(false);
  const [quotes, setQuotes]             = useState<Quote[]>([]);
  const [quotesLoading, setQuotesLoading] = useState(false);
  const [quotesError, setQuotesError]     = useState<string | null>(null);
  const [quotesUpdated, setQuotesUpdated] = useState<Date | null>(null);

  // Manual transactions (persisted in localStorage; replaces old ManualPosition aggregate)
  const [manualStoredTxs, setManualStoredTxs] = useState<StockTransaction[]>(() => {
    try {
      const raw = localStorage.getItem(LS_MANUAL_TXS);
      if (raw) return JSON.parse(raw) as StockTransaction[];
      // One-time migration from legacy ManualPosition format
      const legacy = localStorage.getItem(LS_MANUAL_LEGACY);
      if (legacy) {
        const old = JSON.parse(legacy) as LegacyManualPosition[];
        return old.map(m => ({
          id: m.id,
          date: m.date ?? new Date().toISOString().slice(0, 10),
          symbol: m.symbol.toUpperCase(),
          name: m.name,
          action: 'buy' as const,
          quantity: m.quantityHeld,
          price: m.avgCostPerShare,
          amount: m.avgCostPerShare * m.quantityHeld,
          currency: 'USD',
        }));
      }
    } catch { /* ignore */ }
    return [];
  });

  const saveManualTxs = (next: StockTransaction[]) => {
    setManualStoredTxs(next);
    localStorage.setItem(LS_MANUAL_TXS, JSON.stringify(next));
  };

  const [addingRow, setAddingRow]     = useState(false);
  const [newSymbol, setNewSymbol]     = useState('');
  const [newQty, setNewQty]           = useState('');
  const [newAvgCost, setNewAvgCost]   = useState('');
  const [newDate, setNewDate]         = useState('');
  const [manualRowError, setManualRowError] = useState('');

  // Inline edit state for individual manual transactions inside the history panel
  const [editingManualTxId, setEditingManualTxId] = useState<string | null>(null);
  const [editingManualTxDraft, setEditingManualTxDraft] = useState<Partial<StockTransaction>>({});
  // "Add row to history" state — symbol currently being added to
  const [addingHistoryFor, setAddingHistoryFor] = useState<string | null>(null);
  const [historyForm, setHistoryForm] = useState<{ date: string; action: StockTransaction['action']; qty: string; price: string }>({
    date: '', action: 'buy', qty: '', price: '',
  });

  // Per-field overrides — user can correct any editable column for any position
  type OverrideField = 'quantityHeld' | 'avgCostPerShare' | 'realizedPnL' | 'dividends';
  type PositionOverrides = Partial<Record<OverrideField, number>>;
  const LS_OVERRIDES = 'riseup_position_overrides';
  const [positionOverrides, setPositionOverrides] = useState<Record<string, PositionOverrides>>(
    () => { try { return JSON.parse(localStorage.getItem('riseup_position_overrides') ?? '{}'); } catch { return {}; } }
  );
  const [editingCell, setEditingCell] = useState<{ symbol: string; field: OverrideField; value: string } | null>(null);

  const saveOverride = (symbol: string, field: OverrideField, val: number) => {
    const next = { ...positionOverrides, [symbol]: { ...(positionOverrides[symbol] ?? {}), [field]: val } };
    setPositionOverrides(next);
    localStorage.setItem(LS_OVERRIDES, JSON.stringify(next));
  };

  const startEdit = (symbol: string, field: OverrideField, current: number) =>
    setEditingCell({ symbol, field, value: String(current) });

  const commitEdit = (symbol: string, field: OverrideField) => {
    if (!editingCell || editingCell.symbol !== symbol || editingCell.field !== field) return;
    const val = parseFloat(editingCell.value.replace(',', '.'));
    if (!isNaN(val)) saveOverride(symbol, field, val);
    setEditingCell(null);
  };

  const addManualRow = () => {
    setManualRowError('');
    const sym = newSymbol.trim().toUpperCase();
    const qty = parseFloat(newQty.replace(',', '.'));
    const avg = parseFloat(newAvgCost.replace(',', '.'));
    if (!sym)                    { setManualRowError('נדרש שם נייר ערך'); return; }
    if (isNaN(qty) || qty <= 0)  { setManualRowError('כמות לא תקינה');   return; }
    if (isNaN(avg) || avg <= 0)  { setManualRowError('עלות לא תקינה');   return; }
    saveManualTxs([...manualStoredTxs, {
      id: `m-${Date.now()}`,
      date: newDate || new Date().toISOString().slice(0, 10),
      symbol: sym,
      action: 'buy',
      quantity: qty,
      price: avg,
      amount: qty * avg,
      currency: 'USD',
    }]);
    setAddingRow(false);
    setNewSymbol(''); setNewQty(''); setNewAvgCost(''); setNewDate('');
  };

  /** Delete all manual transactions for a given symbol (used by main table row ✕). */
  const deleteManualSymbol = (sym: string) =>
    saveManualTxs(manualStoredTxs.filter(t => t.symbol !== sym));

  /** Delete a single manual transaction by id (used by history row trash icon). */
  const deleteManualTx = (id: string) =>
    saveManualTxs(manualStoredTxs.filter(t => t.id !== id));

  /** Save inline edits to a manual transaction. */
  const commitManualTxEdit = (id: string) => {
    const draft = editingManualTxDraft;
    saveManualTxs(manualStoredTxs.map(t => {
      if (t.id !== id) return t;
      const qty   = draft.quantity != null ? draft.quantity : t.quantity;
      const price = draft.price    != null ? draft.price    : t.price;
      return {
        ...t,
        date:     draft.date     ?? t.date,
        action:   draft.action   ?? t.action,
        quantity: qty,
        price:    price,
        amount:   (qty ?? 0) * (price ?? 0) || (draft.amount ?? t.amount),
      };
    }));
    setEditingManualTxId(null);
    setEditingManualTxDraft({});
  };

  /** Add a new transaction to an existing symbol's history. */
  const addHistoryTx = (sym: string) => {
    const qty   = parseFloat(historyForm.qty.replace(',', '.'));
    const price = parseFloat(historyForm.price.replace(',', '.'));
    if (isNaN(qty) || qty <= 0 || isNaN(price) || price <= 0) return;
    saveManualTxs([...manualStoredTxs, {
      id: `m-${Date.now()}`,
      date: historyForm.date || new Date().toISOString().slice(0, 10),
      symbol: sym,
      action: historyForm.action,
      quantity: qty,
      price,
      amount: qty * price,
      currency: 'USD',
    }]);
    setAddingHistoryFor(null);
    setHistoryForm({ date: '', action: 'buy', qty: '', price: '' });
  };

  // ── Forex (USD/ILS historical rates) ─────────────────────────────────────────
  const [forexRates, setForexRates] = useState<Record<string, number>>({});
  const [forexLoading, setForexLoading] = useState(false);

  // Collapse state — which symbols have their transaction history expanded
  const [expandedSymbols, setExpandedSymbols] = useState<Set<string>>(new Set());
  const toggleExpanded = (symbol: string) =>
    setExpandedSymbols(prev => {
      const next = new Set(prev);
      next.has(symbol) ? next.delete(symbol) : next.add(symbol);
      return next;
    });

  // Return the closest available USD/ILS rate on or before the given date
  const getRateForDate = (date: string): number | null => {
    if (forexRates[date]) return forexRates[date];
    const sorted = Object.keys(forexRates).sort();
    let best: string | null = null;
    for (const d of sorted) { if (d <= date) best = d; else break; }
    return best ? forexRates[best] : null;
  };

  // Load persisted stock transactions from server on mount
  useEffect(() => {
    api.getStockTransactions()
      .then(saved => { if (saved.length > 0) setTransactions(saved); })
      .catch(() => {/* offline — start empty */})
      .finally(() => setLoadingStored(false));
  }, []);

  // Fetch USD/ILS historical rates whenever any transactions change
  useEffect(() => {
    const allDates = [...transactions, ...manualStoredTxs].map(t => t.date).sort();
    if (allDates.length === 0) return;
    const from = allDates[0];
    const to   = new Date().toISOString().slice(0, 10);
    setForexLoading(true);
    fetch(`${BASE}/portfolio/forex-rates?from=${from}&to=${to}`)
      .then(r => r.json())
      .then((data: Record<string, number>) => setForexRates(data))
      .catch(e => console.warn('[forex-rates]', e))
      .finally(() => setForexLoading(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [transactions, manualStoredTxs]);

  // Computed positions — manual txs are fed in directly alongside file-parsed txs
  const positions = useMemo(
    () => computePositions([...transactions, ...manualStoredTxs]),
    [transactions, manualStoredTxs]
  );

  // All held symbols (derived purely from positions now)
  const allHeldSymbols = useMemo(() =>
    Object.values(positions).filter(p => p.quantityHeld > 0.0001).map(p => p.symbol),
  [positions]);

  // Enrich positions with live quotes (no more separate manual merge needed)
  const enrichedPositions = useMemo<Position[]>(() => {
    const enrichOne = (p: Position, q?: Quote): Position => {
      if (!q || p.quantityHeld <= 0.0001) return p;
      const currentValue  = q.price * p.quantityHeld;
      const unrealizedPnL = currentValue - p.costBasis;
      return { ...p, currentPrice: q.price, currentValue, unrealizedPnL,
        unrealizedPct: p.costBasis > 0 ? (unrealizedPnL / p.costBasis) * 100 : 0,
        dailyChangePct: q.changePercent };
    };

    const quoteMap = new Map(quotes.map(q => [q.symbol, q]));
    const bySymbol = new Map<string, Position>(Object.values(positions).map(p => [p.symbol, p]));

    // Apply per-field overrides — user edits take precedence over computed values
    for (const [sym, ov] of Object.entries(positionOverrides)) {
      if (!bySymbol.has(sym)) continue;
      const p   = bySymbol.get(sym)!;
      const qty = ov.quantityHeld      ?? p.quantityHeld;
      const avg = ov.avgCostPerShare   ?? p.avgCostPerShare;
      bySymbol.set(sym, {
        ...p,
        quantityHeld:    qty,
        avgCostPerShare: avg,
        costBasis:       avg * qty,
        realizedPnL:     ov.realizedPnL ?? p.realizedPnL,
        dividends:       ov.dividends   ?? p.dividends,
      });
    }

    return Array.from(bySymbol.values()).map(p => enrichOne(p, quoteMap.get(p.symbol)));
  }, [positions, quotes, positionOverrides]);

  const totals = useMemo(() => aggregateTotals(enrichedPositions), [enrichedPositions]);

  // ILS summary — converts every transaction (file + manual) to shekels
  const ilsSummary = useMemo(() => {
    if (Object.keys(forexRates).length === 0) return null;
    let investedILS = 0, proceedsILS = 0, dividendsILS = 0, feesILS = 0;
    for (const tx of [...transactions, ...manualStoredTxs]) {
      const rate = getRateForDate(tx.date);
      if (!rate) continue;
      const amtILS = Math.abs(tx.amount) * rate;
      if      (tx.action === 'buy')      investedILS   += amtILS;
      else if (tx.action === 'sell')     proceedsILS   += amtILS;
      else if (tx.action === 'dividend') dividendsILS  += amtILS;
      else if (tx.action === 'fee')      feesILS       += amtILS;
    }
    const today      = new Date().toISOString().slice(0, 10);
    const currentRate = getRateForDate(today) ?? 0;
    const currentValueILS = totals.totalCurrentValue * currentRate;
    const totalReturnILS = currentValueILS + proceedsILS + dividendsILS - feesILS - investedILS;
    return { investedILS, proceedsILS, dividendsILS, feesILS, currentValueILS, currentRate, totalReturnILS };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [forexRates, transactions, manualStoredTxs, totals.totalCurrentValue]);

  // Fetch live quotes whenever held symbols change
  useEffect(() => {
    if (allHeldSymbols.length === 0) { setQuotes([]); return; }
    setQuotesLoading(true);
    setQuotesError(null);
    fetch(`${BASE}/portfolio/quotes?symbols=${allHeldSymbols.join(',')}`)
      .then(r => r.json())
      .then((data: Quote[]) => { setQuotes(data); setQuotesUpdated(new Date()); })
      .catch(e => setQuotesError(String(e)))
      .finally(() => setQuotesLoading(false));
  }, [allHeldSymbols]);

  const handleFile = async (file: File) => {
    setUploading(true);
    setUploadError(null);
    setAnalysis(null);
    setFileName(file.name);
    try {
      const newTxs = await parseFile(file);
      if (newTxs.length === 0) throw new Error('לא נמצאו פעולות בקובץ — ודא שהקובץ מכיל דוח תנועות');

      // Send new transactions to server — server merges and deduplicates
      const result = await api.saveStockTransactions(newTxs);
      console.log(`[portfolio] Uploaded ${newTxs.length} txs, ${result.added} new added, ${result.saved} total`);

      // Reload full merged set from server as source of truth
      const all = await api.getStockTransactions();
      setTransactions(all);
    } catch (e) {
      setUploadError(e instanceof Error ? e.message : String(e));
    } finally {
      setUploading(false);
    }
  };

  const handleRefreshQuotes = () => {
    if (allHeldSymbols.length === 0) return;
    setQuotesLoading(true);
    setQuotesError(null);
    fetch(`${BASE}/portfolio/quotes?symbols=${allHeldSymbols.join(',')}`)
      .then(r => r.json())
      .then((data: Quote[]) => { setQuotes(data); setQuotesUpdated(new Date()); })
      .catch(e => setQuotesError(String(e)))
      .finally(() => setQuotesLoading(false));
  };

  const handleAnalyze = async () => {
    setAnalyzing(true);
    setAnalyzeError(null);
    try {
      const res = await fetch(`${BASE}/portfolio/analyze`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          summary: {
            totalTransactions: transactions.length,
            totalBought: totals.totalBought,
            totalCurrentValue: totals.totalCurrentValue,
            totalUnrealizedPnL: totals.totalUnrealized,
            totalRealizedPnL: totals.totalRealized,
            totalDividends: totals.totalDividends,
            totalFees: totals.totalFees,
            holdings: enrichedPositions.map(p => ({
              symbol: p.symbol, name: p.name,
              quantityHeld: p.quantityHeld,
              avgCostPerShare: p.avgCostPerShare,
              costBasis: p.costBasis,
              currentPrice: p.currentPrice,
              currentValue: p.currentValue,
              unrealizedPnL: p.unrealizedPnL,
              realizedPnL: p.realizedPnL,
              dividends: p.dividends,
            })),
          },
        }),
      });
      if (!res.ok) throw new Error(`Server ${res.status}`);
      setAnalysis(await res.json() as PortfolioAIAnalysis);
    } catch (e) {
      setAnalyzeError(e instanceof Error ? e.message : String(e));
    } finally {
      setAnalyzing(false);
    }
  };

  // ── Chart data ──────────────────────────────────────────────────────────────

  const allocationData = useMemo(() =>
    enrichedPositions
      .filter(p => p.quantityHeld > 0.0001)
      .sort((a, b) => (b.currentValue ?? b.costBasis) - (a.currentValue ?? a.costBasis))
      .slice(0, 8)
      .map(p => ({ name: p.symbol, value: Math.round(p.currentValue ?? p.costBasis) })),
  [enrichedPositions]);

  const pnlData = useMemo(() =>
    enrichedPositions
      .filter(p => p.quantityBought > 0)
      .map(p => ({
        symbol: p.symbol,
        unrealized: Math.round(p.unrealizedPnL ?? 0),
        realized:   Math.round(p.realizedPnL),
      }))
      .sort((a, b) => (b.unrealized + b.realized) - (a.unrealized + a.realized))
      .slice(0, 10),
  [enrichedPositions]);

  const monthlyActivity = useMemo(() => {
    const map = new Map<string, { month: string; bought: number; sold: number; dividends: number }>();
    for (const tx of transactions) {
      const month = tx.date.slice(0, 7);
      if (!map.has(month)) map.set(month, { month, bought: 0, sold: 0, dividends: 0 });
      const e = map.get(month)!;
      if (tx.action === 'buy') e.bought += tx.amount;
      else if (tx.action === 'sell') e.sold += tx.amount;
      else if (tx.action === 'dividend') e.dividends += tx.amount;
    }
    return Array.from(map.values()).sort((a, b) => a.month.localeCompare(b.month));
  }, [transactions]);

  const totalPnL    = totals.totalUnrealized + totals.totalRealized;
  const totalPnLPct = totals.totalBought > 0 ? (totalPnL / totals.totalBought) * 100 : 0;

  const hasData = transactions.length > 0 || manualStoredTxs.length > 0;

  // ── Loading state (waiting for server on first mount) ────────────────────────

  if (loadingStored) {
    return (
      <div className="flex items-center justify-center py-20 text-sm text-gray-400 animate-pulse">
        ⏳ טוען נתונים שמורים...
      </div>
    );
  }

  // ── Upload zone (full screen when no data at all) ────────────────────────────

  if (!hasData) {
    return (
      <div className="space-y-4">
        <div
          className={`border-2 border-dashed rounded-2xl p-12 text-center cursor-pointer transition-colors ${
            isDragging ? 'border-blue-500 bg-blue-50' : 'border-gray-300 hover:border-blue-400 hover:bg-gray-50'
          }`}
          onDragOver={e => { e.preventDefault(); setIsDragging(true); }}
          onDragLeave={() => setIsDragging(false)}
          onDrop={e => { e.preventDefault(); setIsDragging(false); const f = e.dataTransfer.files[0]; if (f) handleFile(f); }}
          onClick={() => inputRef.current?.click()}
        >
          <div className="text-5xl mb-4">📂</div>
          <p className="text-lg font-semibold text-gray-700">גרור קובץ דוח תנועות שוק ההון</p>
          <p className="text-sm text-gray-400 mt-1">תומך ב-PDF ו-CSV מכל בית השקעות ישראלי</p>
          <p className="text-xs text-gray-300 mt-2">מיטב, אקסלנס, פסגות, IDB, קסם, אלטשולר שחם...</p>
          <input ref={inputRef} type="file" accept=".pdf,.csv,.txt" className="hidden"
            onChange={e => { const f = e.target.files?.[0]; if (f) handleFile(f); }} />
        </div>

        {uploading && (
          <div className="bg-blue-50 border border-blue-200 rounded-xl px-5 py-4 text-sm text-blue-700 animate-pulse">
            ⏳ מעבד קובץ ומחלץ נתונים עם AI...
          </div>
        )}
        {uploadError && (
          <div className="bg-red-50 border border-red-200 rounded-xl px-5 py-4 text-sm text-red-600">
            ⚠️ {uploadError}
          </div>
        )}

        {/* Allow adding manual positions even before uploading a file */}
        <div className="bg-white rounded-xl border border-dashed border-gray-200 p-4 text-center">
          <p className="text-xs text-gray-400 mb-2">או הוסף עמדות ידנית ללא קובץ</p>
          <button
            onClick={() => { setAddingRow(true); setNewSymbol(''); setNewQty(''); setNewAvgCost(''); setNewDate(''); }}
            className="text-xs text-blue-600 hover:text-blue-800 font-medium underline"
          >
            + הוסף שורה ידנית
          </button>
          {addingRow && (
            <div className="mt-3 flex items-center gap-2 justify-center flex-wrap">
              <input autoFocus value={newSymbol} onChange={e => setNewSymbol(e.target.value.toUpperCase())}
                onKeyDown={e => e.key === 'Enter' && addManualRow()}
                placeholder="VOO" className="w-20 border border-blue-300 rounded px-2 py-1 text-xs font-bold uppercase focus:outline-none focus:ring-1 focus:ring-blue-500" />
              <input value={newQty} onChange={e => setNewQty(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && addManualRow()}
                placeholder="כמות" className="w-20 border border-blue-300 rounded px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-blue-500" />
              <input value={newAvgCost} onChange={e => setNewAvgCost(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && addManualRow()}
                placeholder="עלות ממוצעת $" className="w-28 border border-blue-300 rounded px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-blue-500" />
              <input type="date" value={newDate} onChange={e => setNewDate(e.target.value)}
                className="border border-blue-300 rounded px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-blue-500" />
              <button onClick={addManualRow} className="bg-blue-600 text-white text-xs px-3 py-1 rounded hover:bg-blue-700">הוסף</button>
              <button onClick={() => { setAddingRow(false); setManualRowError(''); setNewDate(''); }} className="text-gray-400 hover:text-red-500 text-xs">ביטול</button>
              {manualRowError && <span className="text-xs text-red-500 w-full text-center">{manualRowError}</span>}
            </div>
          )}
        </div>
      </div>
    );
  }

  // ── Main dashboard ───────────────────────────────────────────────────────────

  return (
    <div className="space-y-5">
      {/* Header bar */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h2 className="text-base font-bold text-gray-800">
            {fileName ? `📊 דוח תנועות — ${fileName}` : '📊 תיק השקעות'}
          </h2>
          <p className="text-xs text-gray-400">
            {transactions.length > 0 ? `${transactions.length} פעולות` : ''}
            {transactions.length > 0 && manualStoredTxs.length > 0 ? ' · ' : ''}
            {manualStoredTxs.length > 0 ? `${manualStoredTxs.length} פעולות ידניות` : ''}
          </p>
        </div>
        <div className="flex items-center gap-3">
          {/* Upload another file — always visible, server merges automatically */}
          <div
            className="flex items-center gap-1.5 text-xs text-blue-500 hover:text-blue-700 cursor-pointer border border-blue-200 rounded-lg px-3 py-1.5 hover:bg-blue-50 transition-colors"
            onClick={() => inputRef.current?.click()}
          >
            📂 העלה קובץ נוסף
            <input ref={inputRef} type="file" accept=".pdf,.csv,.txt" className="hidden"
              onChange={e => { const f = e.target.files?.[0]; if (f) handleFile(f); }} />
          </div>
          {/* Clear all — removes from server too */}
          <button
            onClick={() => {
              api.clearStockTransactions().catch(() => {});
              setTransactions([]); setAnalysis(null); setFileName(null);
              saveManualTxs([]);
              setPositionOverrides({});
              localStorage.removeItem(LS_OVERRIDES);
              setExpandedSymbols(new Set());
              setForexRates({});
            }}
            className="text-xs text-red-400 hover:text-red-600 underline"
          >
            נקה הכל
          </button>
        </div>
      </div>

      {/* Upload / processing feedback */}
      {uploading && (
        <div className="bg-blue-50 border border-blue-200 rounded-xl px-5 py-3 text-sm text-blue-700 animate-pulse">
          ⏳ מעבד קובץ ומחלץ נתונים עם AI...
        </div>
      )}
      {uploadError && (
        <div className="bg-red-50 border border-red-200 rounded-xl px-5 py-3 text-sm text-red-600">
          ⚠️ {uploadError}
        </div>
      )}

      {/* Quote status bar */}
      <div className="flex items-center gap-3 text-xs text-gray-400 flex-wrap">
        {quotesLoading && <span className="animate-pulse text-blue-500">🔄 מושך שערים עדכניים...</span>}
        {quotesError && <span className="text-orange-500">⚠️ לא ניתן לטעון שערים: {quotesError.slice(0, 60)}</span>}
        {quotesUpdated && !quotesLoading && (
          <span>עודכן ב-{quotesUpdated.toLocaleTimeString('he-IL')}</span>
        )}
        {quotes.length > 0 && (
          <button onClick={handleRefreshQuotes} disabled={quotesLoading}
            className="text-blue-500 hover:text-blue-700 underline disabled:opacity-40">
            רענן שערים
          </button>
        )}
        {quotes.map(q => (
          <span key={q.symbol} className={`font-medium ${q.changePercent >= 0 ? 'text-green-600' : 'text-red-500'}`}>
            {q.symbol} ${q.price.toFixed(2)} ({q.changePercent >= 0 ? '+' : ''}{q.changePercent.toFixed(2)}%)
          </span>
        ))}
      </div>

      {/* KPI cards */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
        <KpiCard label="עלות השקעה כוללת" value={fmt(totals.totalBought)}     color="text-blue-600" />
        <KpiCard label="שווי תיק כיום"    value={fmt(totals.totalCurrentValue)} color="text-indigo-600"
          sub={quotes.length > 0 ? 'לפי שערים עדכניים' : 'לפי עלות (ממתין לשערים)'} />
        <KpiCard
          label="רווח לא ממומש"
          value={fmt(totals.totalUnrealized)}
          sub={totals.totalCostBasis > 0 ? `${totals.totalUnrealized >= 0 ? '+' : ''}${((totals.totalUnrealized / totals.totalCostBasis) * 100).toFixed(1)}% על עמדות פתוחות` : undefined}
          color={totals.totalUnrealized >= 0 ? 'text-green-600' : 'text-red-500'}
        />
        <KpiCard
          label="רווח ממומש"
          value={fmt(totals.totalRealized)}
          color={totals.totalRealized >= 0 ? 'text-green-600' : 'text-red-500'}
        />
        <KpiCard label="דיבידנדים"     value={fmt(totals.totalDividends)} color="text-yellow-600" />
        <KpiCard label="עמלות ששולמו"  value={fmt(totals.totalFees)}      color="text-red-500"
          sub={`${totals.totalBought > 0 ? ((totals.totalFees / totals.totalBought) * 100).toFixed(2) : 0}% מהשקעה`} />
      </div>

      {/* Total P&L banner */}
      <div className={`rounded-xl border px-5 py-3 flex items-center justify-between ${
        totalPnL >= 0 ? 'bg-green-50 border-green-200' : 'bg-red-50 border-red-200'
      }`}>
        <span className="text-sm font-medium text-gray-600">רווח/הפסד כולל (ממומש + לא ממומש)</span>
        <span className={`text-xl font-bold ${totalPnL >= 0 ? 'text-green-600' : 'text-red-500'}`}>
          {totalPnL >= 0 ? '+' : ''}{fmt(totalPnL)}
          <span className="text-sm font-normal mr-2">({totalPnLPct >= 0 ? '+' : ''}{totalPnLPct.toFixed(1)}%)</span>
        </span>
      </div>

      {/* Charts row */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Allocation pie */}
        {allocationData.length > 0 && (
          <div className="bg-white rounded-xl border border-gray-200 p-5">
            <h3 className="text-sm font-semibold text-gray-700 mb-3">הקצאת תיק לפי נייר ערך</h3>
            <ResponsiveContainer width="100%" height={240}>
              <PieChart>
                <Pie data={allocationData} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={90} label={({ name, percent }) => `${name} ${(percent * 100).toFixed(0)}%`}>
                  {allocationData.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
                </Pie>
                <Tooltip formatter={(v: number) => fmt(v)} />
              </PieChart>
            </ResponsiveContainer>
          </div>
        )}

        {/* P&L by symbol */}
        {pnlData.length > 0 && (
          <div className="bg-white rounded-xl border border-gray-200 p-5">
            <h3 className="text-sm font-semibold text-gray-700 mb-3">רווח/הפסד לפי נייר ערך</h3>
            <ResponsiveContainer width="100%" height={240}>
              <BarChart data={pnlData} layout="vertical">
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis type="number" tickFormatter={v => `$${(v/1000).toFixed(0)}k`} tick={{ fontSize: 10 }} />
                <YAxis type="category" dataKey="symbol" tick={{ fontSize: 11 }} width={50} />
                <Tooltip formatter={(v: number) => fmt(v)} />
                <Legend />
                <Bar dataKey="unrealized" name="לא ממומש" fill="#3b82f6" radius={[0,4,4,0]} />
                <Bar dataKey="realized"   name="ממומש"    fill="#10b981" radius={[0,4,4,0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}

        {/* Monthly activity */}
        {monthlyActivity.length > 1 && (
          <div className="bg-white rounded-xl border border-gray-200 p-5 md:col-span-2">
            <h3 className="text-sm font-semibold text-gray-700 mb-3">פעילות חודשית</h3>
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={monthlyActivity}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="month" tick={{ fontSize: 10 }} />
                <YAxis tickFormatter={v => `$${(v/1000).toFixed(0)}k`} tick={{ fontSize: 10 }} />
                <Tooltip formatter={(v: number) => fmt(v)} />
                <Legend />
                <Bar dataKey="bought"    name="קניות"      fill="#3b82f6" radius={[4,4,0,0]} />
                <Bar dataKey="sold"      name="מכירות"     fill="#10b981" radius={[4,4,0,0]} />
                <Bar dataKey="dividends" name="דיבידנדים"  fill="#f59e0b" radius={[4,4,0,0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
      </div>

      {/* Holdings table */}
      {(enrichedPositions.length > 0 || manualStoredTxs.length > 0 || true) && (
        <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
          <div className="px-5 py-3 border-b border-gray-100 flex items-center justify-between">
            <h3 className="text-sm font-semibold text-gray-700">אחזקות ועמדות</h3>
            <div className="flex items-center gap-4">
              <div className="flex gap-3 text-xs text-gray-400">
                <span>✅ מקובץ</span><span>✏️ ידני</span><span>📦 סגורה</span>
              </div>
              <button
                onClick={() => { setAddingRow(true); setNewSymbol(''); setNewQty(''); setNewAvgCost(''); setNewDate(''); }}
                className="flex items-center gap-1 text-xs text-blue-600 hover:text-blue-800 font-medium"
              >
                + הוסף שורה ידנית
              </button>
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="bg-gray-50">
                <tr>
                  <th className="text-right px-4 py-2 font-medium text-gray-500 w-6"></th>
                  <th className="text-right px-4 py-2 font-medium text-gray-500">נייר</th>
                  <th className="text-right px-4 py-2 font-medium text-gray-400">כמות מוחזקת ✏️</th>
                  <th className="text-right px-4 py-2 font-medium text-gray-400">עלות ממוצעת ✏️</th>
                  <th className="text-right px-4 py-2 font-medium text-gray-400">רווח ממומש ✏️</th>
                  <th className="text-right px-4 py-2 font-medium text-gray-400">דיבידנדים ✏️</th>
                  <th className="text-right px-4 py-2 font-medium text-gray-500">שווי עלות</th>
                  <th className="text-right px-4 py-2 font-medium text-gray-500">מחיר כיום</th>
                  <th className="text-right px-4 py-2 font-medium text-gray-500">שווי כיום</th>
                  <th className="text-right px-4 py-2 font-medium text-gray-500">רווח לא ממומש</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {enrichedPositions
                  .sort((a, b) => (b.currentValue ?? b.costBasis) - (a.currentValue ?? a.costBasis))
                  .map((p, idx) => {
                    const isManual = manualStoredTxs.some(t => t.symbol === p.symbol);
                    const isExpanded = expandedSymbols.has(p.symbol);
                    const symManualTxs = manualStoredTxs.filter(t => t.symbol === p.symbol);
                    const symTxs = [
                      ...transactions.filter(t => t.symbol.toUpperCase() === p.symbol && ['buy','sell','dividend','fee'].includes(t.action)),
                      ...symManualTxs,
                    ].sort((a, b) => a.date.localeCompare(b.date));
                    const isManualSymbol = symManualTxs.length > 0;
                    return (
                      <Fragment key={`${p.symbol}-${idx}`}>
                      <tr className={`hover:bg-gray-50 ${isManual ? 'bg-blue-50/30' : ''} ${isExpanded ? 'bg-blue-50/20' : ''}`}>
                        <td className="px-3 py-2.5">
                          <div className="flex items-center gap-1">
                            <button
                              onClick={() => toggleExpanded(p.symbol)}
                              className="text-gray-400 hover:text-blue-500 transition-colors text-xs w-4"
                              title="היסטוריית פעולות"
                            >{isExpanded ? '▼' : '▶'}</button>
                            {isManual
                              ? <button onClick={() => deleteManualSymbol(p.symbol)}
                                  className="text-gray-300 hover:text-red-500 transition-colors text-xs" title="הסר שורה">✕</button>
                              : <span className="text-gray-200 text-xs">·</span>
                            }
                          </div>
                        </td>
                        <td className="px-4 py-2.5">
                          <div className="flex items-center gap-1.5">
                            <span className="text-xs">{isManual ? '✏️' : p.quantityHeld > 0.0001 ? '✅' : '📦'}</span>
                            <span className="font-bold text-gray-800">{p.symbol}</span>
                            {p.name && <span className="text-gray-400 truncate max-w-24"> {p.name}</span>}
                          </div>
                        </td>
                        {/* ── Editable cell helper rendered inline ── */}
                        {(['quantityHeld', 'avgCostPerShare', 'realizedPnL', 'dividends'] as OverrideField[]).map(field => {
                          const isEditing = editingCell?.symbol === p.symbol && editingCell?.field === field;
                          const raw: number = p[field] ?? 0;
                          const display = field === 'quantityHeld'
                            ? (raw > 0.0001 ? raw.toFixed(4) : '—')
                            : field === 'avgCostPerShare'
                              ? (raw > 0 ? `$${raw.toFixed(2)}` : '—')
                              : (raw !== 0 ? `${raw >= 0 ? (field === 'realizedPnL' ? '+' : '') : ''}${fmt(raw)}` : '—');
                          const colorClass = field === 'realizedPnL'
                            ? (raw >= 0 ? 'text-green-600 font-semibold' : 'text-red-500 font-semibold')
                            : field === 'dividends' ? 'text-yellow-600'
                            : field === 'avgCostPerShare' ? 'text-gray-600'
                            : 'text-gray-700';
                          return (
                            <td
                              key={field}
                              className={`px-4 py-2.5 tabular-nums ${colorClass} cursor-pointer`}
                              onClick={() => !editingCell && startEdit(p.symbol, field, raw)}
                            >
                              {isEditing ? (
                                <input
                                  autoFocus
                                  type="number" step="any"
                                  value={editingCell!.value}
                                  onChange={e => setEditingCell({ symbol: p.symbol, field, value: e.target.value })}
                                  onBlur={() => commitEdit(p.symbol, field)}
                                  onKeyDown={e => {
                                    if (e.key === 'Enter')  commitEdit(p.symbol, field);
                                    if (e.key === 'Escape') setEditingCell(null);
                                  }}
                                  className="w-24 border border-blue-400 rounded px-2 py-0.5 text-xs focus:outline-none focus:ring-1 focus:ring-blue-500"
                                />
                              ) : (
                                <span className="group flex items-center gap-1">
                                  {display}
                                  <span className="opacity-0 group-hover:opacity-40 text-blue-400 text-xs">✏️</span>
                                </span>
                              )}
                            </td>
                          );
                        })}
                        {/* שווי עלות — derived, read-only */}
                        <td className="px-4 py-2.5 tabular-nums text-blue-600 font-medium">
                          {p.costBasis > 0 ? fmt(p.costBasis) : '—'}
                        </td>
                        {/* מחיר כיום — live, read-only */}
                        <td className="px-4 py-2.5 tabular-nums">
                          {p.currentPrice ? (
                            <span>
                              ${p.currentPrice.toFixed(2)}
                              {p.dailyChangePct !== undefined && (
                                <span className={`mr-1 ${p.dailyChangePct >= 0 ? 'text-green-500' : 'text-red-500'}`}>
                                  {' '}({p.dailyChangePct >= 0 ? '+' : ''}{p.dailyChangePct.toFixed(2)}%)
                                </span>
                              )}
                            </span>
                          ) : <span className="text-gray-300">—</span>}
                        </td>
                        {/* שווי כיום — derived, read-only */}
                        <td className="px-4 py-2.5 tabular-nums font-medium text-indigo-600">
                          {p.currentValue ? fmt(p.currentValue) : '—'}
                        </td>
                        {/* רווח לא ממומש — derived, read-only */}
                        <td className={`px-4 py-2.5 tabular-nums font-semibold ${
                          p.unrealizedPnL == null ? 'text-gray-300' :
                          p.unrealizedPnL >= 0 ? 'text-green-600' : 'text-red-500'
                        }`}>
                          {p.unrealizedPnL != null ? (
                            <span>
                              {p.unrealizedPnL >= 0 ? '+' : ''}{fmt(p.unrealizedPnL)}
                              {p.unrealizedPct !== undefined && (
                                <span className="font-normal text-xs mr-1">
                                  {' '}({p.unrealizedPct >= 0 ? '+' : ''}{p.unrealizedPct.toFixed(1)}%)
                                </span>
                              )}
                            </span>
                          ) : '—'}
                        </td>
                      </tr>

                      {/* ── Collapsed transaction history ── */}
                      {isExpanded && (
                        <tr>
                          <td colSpan={10} className="p-0 border-b border-blue-100">
                            <div className="bg-gradient-to-b from-blue-50/60 to-white px-8 py-4">
                              <p className="text-xs font-semibold text-blue-700 mb-2">
                                היסטוריית פעולות — {p.symbol}
                                {forexLoading && <span className="mr-2 text-gray-400 font-normal">טוען שערי חליפין…</span>}
                              </p>
                              {symTxs.length === 0 && !isManualSymbol
                                ? <p className="text-xs text-gray-400">אין פעולות מפורטות בדוח עבור נייר זה</p>
                                : (
                                  <table className="w-full text-xs mb-3">
                                    <thead>
                                      <tr className="text-gray-400 border-b border-gray-200">
                                        <th className="text-right pb-1 pr-3">תאריך</th>
                                        <th className="text-right pb-1 pr-3">פעולה</th>
                                        <th className="text-right pb-1 pr-3">כמות</th>
                                        <th className="text-right pb-1 pr-3">מחיר $</th>
                                        <th className="text-right pb-1 pr-3">סכום $</th>
                                        <th className="text-right pb-1 pr-3">שע"ח ₪/$</th>
                                        <th className="text-right pb-1 pr-3">סכום ₪</th>
                                        {isManualSymbol && <th className="pb-1"></th>}
                                      </tr>
                                    </thead>
                                    <tbody className="divide-y divide-gray-100">
                                      {symTxs.map(tx => {
                                        const isMTx = symManualTxs.some(m => m.id === tx.id);
                                        const isEditingThis = editingManualTxId === tx.id;
                                        const rate   = getRateForDate(tx.date);
                                        const amtUSD = Math.abs(isEditingThis && editingManualTxDraft.amount != null ? editingManualTxDraft.amount : tx.amount);
                                        const amtILS = rate ? amtUSD * rate : null;
                                        if (isEditingThis) {
                                          const draft = editingManualTxDraft;
                                          const dQty   = draft.quantity != null ? String(draft.quantity) : String(tx.quantity ?? '');
                                          const dPrice = draft.price    != null ? String(draft.price)    : String(tx.price    ?? '');
                                          return (
                                            <tr key={tx.id} className="bg-yellow-50">
                                              <td className="py-1 pr-2">
                                                <input type="date" value={draft.date ?? tx.date}
                                                  onChange={e => setEditingManualTxDraft(d => ({ ...d, date: e.target.value }))}
                                                  className="border border-yellow-300 rounded px-1 py-0.5 text-xs w-28" />
                                              </td>
                                              <td className="py-1 pr-2">
                                                <select value={draft.action ?? tx.action}
                                                  onChange={e => setEditingManualTxDraft(d => ({ ...d, action: e.target.value as StockTransaction['action'] }))}
                                                  className="border border-yellow-300 rounded px-1 py-0.5 text-xs">
                                                  {(['buy','sell','dividend','fee','interest','other'] as const).map(a =>
                                                    <option key={a} value={a}>{ACTION_LABEL[a] ?? a}</option>
                                                  )}
                                                </select>
                                              </td>
                                              <td className="py-1 pr-2">
                                                <input type="number" step="any" min="0" value={dQty}
                                                  onChange={e => setEditingManualTxDraft(d => {
                                                    const q = parseFloat(e.target.value);
                                                    const pr = d.price != null ? d.price : (tx.price ?? 0);
                                                    return { ...d, quantity: isNaN(q) ? undefined : q, amount: isNaN(q) ? d.amount : q * pr };
                                                  })}
                                                  className="border border-yellow-300 rounded px-1 py-0.5 text-xs w-20" />
                                              </td>
                                              <td className="py-1 pr-2">
                                                <input type="number" step="any" min="0" value={dPrice}
                                                  onChange={e => setEditingManualTxDraft(d => {
                                                    const pr = parseFloat(e.target.value);
                                                    const q  = d.quantity != null ? d.quantity : (tx.quantity ?? 0);
                                                    return { ...d, price: isNaN(pr) ? undefined : pr, amount: isNaN(pr) ? d.amount : q * pr };
                                                  })}
                                                  className="border border-yellow-300 rounded px-1 py-0.5 text-xs w-20" />
                                              </td>
                                              <td className="py-1 pr-2 tabular-nums text-xs text-gray-500 italic">
                                                {editingManualTxDraft.amount != null ? fmt(editingManualTxDraft.amount) : fmt(tx.amount)}
                                              </td>
                                              <td className="py-1 pr-2 tabular-nums text-gray-400 text-xs">{rate ? rate.toFixed(3) : '—'}</td>
                                              <td className="py-1 pr-2 tabular-nums text-xs text-gray-500">
                                                {amtILS != null ? fmtILS(amtILS) : '—'}
                                              </td>
                                              <td className="py-1 flex gap-1">
                                                <button onClick={() => commitManualTxEdit(tx.id)}
                                                  onKeyDown={e => e.key === 'Enter' && commitManualTxEdit(tx.id)}
                                                  className="text-xs px-2 py-0.5 bg-green-500 text-white rounded hover:bg-green-600">✓</button>
                                                <button onClick={() => { setEditingManualTxId(null); setEditingManualTxDraft({}); }}
                                                  className="text-xs px-2 py-0.5 bg-gray-200 text-gray-600 rounded hover:bg-gray-300">✕</button>
                                              </td>
                                            </tr>
                                          );
                                        }
                                        return (
                                          <tr key={tx.id} className={`group hover:bg-blue-50/40 ${isMTx ? 'bg-blue-50/20' : ''}`}>
                                            <td className="py-1.5 pr-3 tabular-nums text-gray-500">{tx.date}</td>
                                            <td className="py-1.5 pr-3">
                                              <span className={`px-1.5 py-0.5 rounded text-xs ${ACTION_COLOR[tx.action] ?? 'bg-gray-100 text-gray-600'}`}>
                                                {ACTION_LABEL[tx.action] ?? tx.action}
                                              </span>
                                            </td>
                                            <td className="py-1.5 pr-3 tabular-nums text-gray-700">{tx.quantity != null ? tx.quantity.toFixed(4) : '—'}</td>
                                            <td className="py-1.5 pr-3 tabular-nums text-gray-600">{tx.price != null ? `$${tx.price.toFixed(2)}` : '—'}</td>
                                            <td className={`py-1.5 pr-3 tabular-nums font-medium ${tx.action === 'buy' ? 'text-blue-600' : tx.action === 'sell' ? 'text-green-600' : 'text-gray-600'}`}>
                                              {tx.action === 'buy' ? '-' : tx.action === 'sell' ? '+' : ''}{fmt(amtUSD)}
                                            </td>
                                            <td className="py-1.5 pr-3 tabular-nums text-gray-400">{rate ? rate.toFixed(3) : '—'}</td>
                                            <td className={`py-1.5 pr-3 tabular-nums font-medium ${tx.action === 'buy' ? 'text-blue-600' : tx.action === 'sell' ? 'text-green-600' : 'text-gray-600'}`}>
                                              {amtILS != null ? `${tx.action === 'buy' ? '-' : tx.action === 'sell' ? '+' : ''}${fmtILS(amtILS)}` : '—'}
                                            </td>
                                            {isManualSymbol && (
                                              <td className="py-1.5 text-left">
                                                {isMTx && (
                                                  <span className="flex gap-1 opacity-0 group-hover:opacity-100 hover:opacity-100">
                                                    <button onClick={() => { setEditingManualTxId(tx.id); setEditingManualTxDraft({}); }}
                                                      className="text-blue-400 hover:text-blue-600 text-xs" title="ערוך">✏️</button>
                                                    <button onClick={() => deleteManualTx(tx.id)}
                                                      className="text-gray-300 hover:text-red-500 text-xs" title="מחק">🗑</button>
                                                  </span>
                                                )}
                                              </td>
                                            )}
                                          </tr>
                                        );
                                      })}

                                      {/* ── Add new history row form ── */}
                                      {isManualSymbol && addingHistoryFor === p.symbol && (
                                        <tr className="bg-green-50 border-t border-green-200">
                                          <td className="py-1.5 pr-2">
                                            <input type="date" value={historyForm.date}
                                              onChange={e => setHistoryForm(f => ({ ...f, date: e.target.value }))}
                                              onKeyDown={e => e.key === 'Enter' && addHistoryTx(p.symbol)}
                                              className="border border-green-300 rounded px-1 py-0.5 text-xs w-28" />
                                          </td>
                                          <td className="py-1.5 pr-2">
                                            <select value={historyForm.action}
                                              onChange={e => setHistoryForm(f => ({ ...f, action: e.target.value as StockTransaction['action'] }))}
                                              className="border border-green-300 rounded px-1 py-0.5 text-xs">
                                              {(['buy','sell','dividend','fee','interest','other'] as const).map(a =>
                                                <option key={a} value={a}>{ACTION_LABEL[a] ?? a}</option>
                                              )}
                                            </select>
                                          </td>
                                          <td className="py-1.5 pr-2">
                                            <input type="number" step="any" min="0" placeholder="כמות"
                                              value={historyForm.qty}
                                              onChange={e => setHistoryForm(f => ({ ...f, qty: e.target.value }))}
                                              onKeyDown={e => e.key === 'Enter' && addHistoryTx(p.symbol)}
                                              className="border border-green-300 rounded px-1 py-0.5 text-xs w-20" />
                                          </td>
                                          <td className="py-1.5 pr-2">
                                            <input type="number" step="any" min="0" placeholder="מחיר $"
                                              value={historyForm.price}
                                              onChange={e => setHistoryForm(f => ({ ...f, price: e.target.value }))}
                                              onKeyDown={e => e.key === 'Enter' && addHistoryTx(p.symbol)}
                                              className="border border-green-300 rounded px-1 py-0.5 text-xs w-20" />
                                          </td>
                                          <td className="py-1.5 pr-2 text-xs text-gray-400 italic tabular-nums">
                                            {historyForm.qty && historyForm.price ? fmt(parseFloat(historyForm.qty) * parseFloat(historyForm.price)) : '—'}
                                          </td>
                                          <td colSpan={isManualSymbol ? 3 : 2} className="py-1.5">
                                            <div className="flex gap-1">
                                              <button onClick={() => addHistoryTx(p.symbol)}
                                                className="text-xs px-2 py-0.5 bg-green-500 text-white rounded hover:bg-green-600">הוסף</button>
                                              <button onClick={() => { setAddingHistoryFor(null); setHistoryForm({ date:'', action:'buy', qty:'', price:'' }); }}
                                                className="text-xs px-2 py-0.5 bg-gray-200 text-gray-600 rounded hover:bg-gray-300">ביטול</button>
                                            </div>
                                          </td>
                                        </tr>
                                      )}
                                    </tbody>
                                  </table>
                                )
                              }

                              {/* Add row button for manual symbols */}
                              {isManualSymbol && addingHistoryFor !== p.symbol && (
                                <button
                                  onClick={() => { setAddingHistoryFor(p.symbol); setHistoryForm({ date: '', action: 'buy', qty: '', price: '' }); }}
                                  className="text-xs text-green-600 hover:text-green-800 font-medium mb-3 flex items-center gap-1"
                                >
                                  ➕ הוסף פעולה
                                </button>
                              )}

                              {/* Per-position ILS mini-summary */}
                              {(() => {
                                let posInvILS = 0, posSoldILS = 0, posDivILS = 0;
                                for (const tx of symTxs) {
                                  const rate = getRateForDate(tx.date);
                                  if (!rate) continue;
                                  const a = Math.abs(tx.amount) * rate;
                                  if (tx.action === 'buy')           posInvILS  += a;
                                  else if (tx.action === 'sell')     posSoldILS += a;
                                  else if (tx.action === 'dividend') posDivILS  += a;
                                }
                                const rate = getRateForDate(new Date().toISOString().slice(0,10)) ?? 0;
                                const curValILS = (p.currentValue ?? p.costBasis) * rate;
                                const pnlILS = curValILS + posSoldILS + posDivILS - posInvILS;
                                return (
                                  <div className="flex flex-wrap gap-4 text-xs border-t border-blue-100 pt-2">
                                    <span className="text-gray-500">הושקע: <strong className="text-blue-600">{fmtILS(posInvILS)}</strong></span>
                                    <span className="text-gray-500">מומש: <strong className="text-green-600">{fmtILS(posSoldILS)}</strong></span>
                                    <span className="text-gray-500">דיבידנדים: <strong className="text-yellow-600">{fmtILS(posDivILS)}</strong></span>
                                    <span className="text-gray-500">שווי כיום: <strong className="text-indigo-600">{fmtILS(curValILS)}</strong></span>
                                    <span className="text-gray-500">רווח/הפסד ₪: <strong className={pnlILS >= 0 ? 'text-green-600' : 'text-red-500'}>{pnlILS >= 0 ? '+' : ''}{fmtILS(pnlILS)}</strong></span>
                                  </div>
                                );
                              })()}
                            </div>
                          </td>
                        </tr>
                      )}
                      </Fragment>
                    );
                  })}

                {/* ── Add row form ── */}
                {addingRow && (
                  <tr className="bg-blue-50 border-t-2 border-blue-200">
                    <td className="px-3 py-2">
                      <button onClick={() => { setAddingRow(false); setNewDate(''); }} className="text-gray-400 hover:text-red-500">✕</button>
                    </td>
                    <td className="px-2 py-2">
                      <input
                        autoFocus
                        value={newSymbol}
                        onChange={e => setNewSymbol(e.target.value.toUpperCase())}
                        onKeyDown={e => e.key === 'Enter' && addManualRow()}
                        placeholder="VOO"
                        className="w-20 border border-blue-300 rounded px-2 py-1 text-xs font-bold uppercase focus:outline-none focus:ring-1 focus:ring-blue-500"
                      />
                    </td>
                    <td className="px-2 py-2">
                      <input
                        type="number" min="0" step="any"
                        value={newQty}
                        onChange={e => setNewQty(e.target.value)}
                        onKeyDown={e => e.key === 'Enter' && addManualRow()}
                        placeholder="כמות"
                        className="w-24 border border-blue-300 rounded px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-blue-500"
                      />
                    </td>
                    <td className="px-2 py-2">
                      <input
                        type="number" min="0" step="any"
                        value={newAvgCost}
                        onChange={e => setNewAvgCost(e.target.value)}
                        onKeyDown={e => e.key === 'Enter' && addManualRow()}
                        placeholder="עלות ממוצעת $"
                        className="w-28 border border-blue-300 rounded px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-blue-500"
                      />
                    </td>
                    <td className="px-2 py-2 text-xs text-gray-400 italic">
                      {newQty && newAvgCost ? fmt(parseFloat(newQty) * parseFloat(newAvgCost)) : '—'}
                    </td>
                    <td className="px-2 py-2">
                      <input
                        type="date"
                        value={newDate}
                        onChange={e => setNewDate(e.target.value)}
                        className="border border-blue-300 rounded px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-blue-500"
                      />
                    </td>
                    <td colSpan={4} className="px-2 py-2">
                      <button
                        onClick={addManualRow}
                        className="px-3 py-1 bg-blue-600 text-white rounded text-xs font-medium hover:bg-blue-700"
                      >
                        ✓ הוסף
                      </button>
                      {manualRowError
                        ? <span className="text-xs text-red-500 mr-2">{manualRowError}</span>
                        : <span className="text-xs text-gray-400 mr-2">שווי עלות, שווי כיום ורווח יחושבו אוטומטית</span>
                      }
                    </td>
                  </tr>
                )}

                {/* ── Empty state ── */}
                {enrichedPositions.length === 0 && !addingRow && (
                  <tr>
                    <td colSpan={10} className="px-4 py-6 text-center text-xs text-gray-400">
                      אין נתונים — העלה קובץ דוח או הוסף שורה ידנית
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Transaction log */}
      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        <details>
          <summary className="px-5 py-3 cursor-pointer hover:bg-gray-50 text-sm font-semibold text-gray-700 select-none flex items-center gap-2">
            📋 יומן פעולות מלא ({transactions.length})
          </summary>
          <div className="border-t border-gray-100 max-h-80 overflow-y-auto">
            <table className="w-full text-xs">
              <thead className="bg-gray-50 sticky top-0">
                <tr>
                  <th className="text-right px-4 py-2 font-medium text-gray-500">תאריך</th>
                  <th className="text-right px-4 py-2 font-medium text-gray-500">נייר</th>
                  <th className="text-right px-4 py-2 font-medium text-gray-500">פעולה</th>
                  <th className="text-right px-4 py-2 font-medium text-gray-500">כמות</th>
                  <th className="text-right px-4 py-2 font-medium text-gray-500">מחיר</th>
                  <th className="text-right px-4 py-2 font-medium text-gray-500">סכום</th>
                  <th className="text-right px-4 py-2 font-medium text-gray-500">מטבע</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {[...transactions].sort((a,b) => b.date.localeCompare(a.date)).map(tx => (
                  <tr key={tx.id} className="hover:bg-gray-50">
                    <td className="px-4 py-2 text-gray-500">{tx.date.slice(0,10)}</td>
                    <td className="px-4 py-2 font-semibold text-gray-800">{tx.symbol}</td>
                    <td className="px-4 py-2">
                      <span className={`px-1.5 py-0.5 rounded text-xs ${ACTION_COLOR[tx.action] ?? 'bg-gray-100 text-gray-600'}`}>
                        {ACTION_LABEL[tx.action] ?? tx.action}
                      </span>
                    </td>
                    <td className="px-4 py-2 tabular-nums text-gray-600">{tx.quantity?.toFixed(2) ?? '—'}</td>
                    <td className="px-4 py-2 tabular-nums text-gray-600">{tx.price ? fmt(tx.price, tx.currency) : '—'}</td>
                    <td className="px-4 py-2 tabular-nums font-medium text-gray-800">{fmt(tx.amount, tx.currency)}</td>
                    <td className="px-4 py-2 text-gray-400">{tx.currency}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      </div>

      {/* ── ILS Summary ── */}
      {ilsSummary && (
        <div className="bg-white rounded-xl border border-gray-200 p-5">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-sm font-semibold text-gray-700">סיכום בשקלים ₪</h3>
            <span className="text-xs text-gray-400">שע"ח כיום: ₪{ilsSummary.currentRate.toFixed(3)} ל-$1</span>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3">
            <KpiCard label="סה״כ הושקע ₪"     value={fmtILS(ilsSummary.investedILS)}     color="text-blue-600" />
            <KpiCard label="סה״כ מומש ₪"       value={fmtILS(ilsSummary.proceedsILS)}     color="text-green-600" />
            <KpiCard label="דיבידנדים ₪"        value={fmtILS(ilsSummary.dividendsILS)}    color="text-yellow-600" />
            <KpiCard label="שווי תיק כיום ₪"   value={fmtILS(ilsSummary.currentValueILS)} color="text-indigo-600" />
            <KpiCard
              label="רווח / הפסד כולל ₪"
              value={`${ilsSummary.totalReturnILS >= 0 ? '+' : ''}${fmtILS(ilsSummary.totalReturnILS)}`}
              color={ilsSummary.totalReturnILS >= 0 ? 'text-green-600' : 'text-red-500'}
              sub={ilsSummary.investedILS > 0
                ? `${((ilsSummary.totalReturnILS / ilsSummary.investedILS) * 100).toFixed(1)}% על ההשקעה`
                : undefined}
            />
          </div>
          <p className="text-xs text-gray-400 mt-3">
            * מחושב לפי שערי USD/ILS היסטוריים בתאריך כל פעולה (מקור: Yahoo Finance)
          </p>
        </div>
      )}

      {/* AI Analysis section */}
      <div className="bg-white rounded-xl border border-gray-200 p-5 space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-sm font-semibold text-gray-700">🤖 ניתוח תיק ע״י AI</h3>
            <p className="text-xs text-gray-400">תובנות, מסקנות והמלצות מותאמות אישית</p>
          </div>
          <button
            onClick={handleAnalyze}
            disabled={analyzing}
            className="px-5 py-2 bg-indigo-600 hover:bg-indigo-700 disabled:bg-indigo-300 text-white text-sm font-semibold rounded-lg transition-colors"
          >
            {analyzing ? '⏳ מנתח...' : analysis ? 'נתח מחדש' : 'נתח תיק'}
          </button>
        </div>

        {analyzeError && (
          <p className="text-sm text-red-500">⚠️ {analyzeError}</p>
        )}

        {analysis && <AIAnalysisPanel analysis={analysis} />}

        {!analysis && !analyzing && !analyzeError && (
          <p className="text-sm text-gray-400 text-center py-4">לחץ "נתח תיק" לקבלת ניתוח AI מפורט</p>
        )}
      </div>
    </div>
  );
};

export default PortfolioTab;
