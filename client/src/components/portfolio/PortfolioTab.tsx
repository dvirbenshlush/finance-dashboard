import { type FC, useRef, useState, useMemo, useEffect } from 'react';
import {
  PieChart, Pie, Cell, Tooltip, ResponsiveContainer,
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Legend,
} from 'recharts';
import * as pdfjsLib from 'pdfjs-dist';
import type { StockTransaction, PortfolioAIAnalysis } from '../../types';

// Point pdfjs to its worker (bundled with Vite)
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url,
).toString();

const BASE = 'http://localhost:3001/api';

const fmt = (v: number, currency = 'USD') =>
  new Intl.NumberFormat('he-IL', { style: 'currency', currency, maximumFractionDigits: 0 }).format(v);

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

    if (tx.action === 'buy') {
      p.totalBought    += tx.amount;
      p.quantityBought += tx.quantity ?? 0;
      // Recalculate weighted average cost
      p.avgCostPerShare = p.quantityBought > 0 ? p.totalBought / p.quantityBought : 0;
    } else if (tx.action === 'sell') {
      const qty = tx.quantity ?? 0;
      const costOfSold = p.avgCostPerShare * qty;
      p.realizedPnL += tx.amount - costOfSold;
      p.totalSold       += tx.amount;
      p.quantitySold    += qty;
    } else if (tx.action === 'dividend') {
      p.dividends    += tx.amount;
      p.realizedPnL  += tx.amount;
    } else if (tx.action === 'fee') {
      p.fees         += tx.amount;
      p.realizedPnL  -= tx.amount;
    }

    p.quantityHeld = Math.max(0, p.quantityBought - p.quantitySold);
    p.costBasis    = p.avgCostPerShare * p.quantityHeld;
  }

  return bySymbol;
}

function aggregateTotals(positions: Record<string, Position>, enriched: Position[]) {
  const totalCostBasis    = enriched.reduce((s, p) => s + p.costBasis, 0);
  const totalCurrentValue = enriched.reduce((s, p) => s + (p.currentValue ?? p.costBasis), 0);
  const totalUnrealized   = enriched.reduce((s, p) => s + (p.unrealizedPnL ?? 0), 0);
  const totalRealized     = Object.values(positions).reduce((s, p) => s + p.realizedPnL, 0);
  const totalDividends    = Object.values(positions).reduce((s, p) => s + p.dividends, 0);
  const totalFees         = Object.values(positions).reduce((s, p) => s + p.fees, 0);
  const totalBought       = Object.values(positions).reduce((s, p) => s + p.totalBought, 0);
  return { totalCostBasis, totalCurrentValue, totalUnrealized, totalRealized, totalDividends, totalFees, totalBought };
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

  // Computed positions (weighted avg cost, realized P&L)
  const positions = useMemo(() => computePositions(transactions), [transactions]);

  // Enrich positions with live prices
  const enrichedPositions = useMemo<Position[]>(() => {
    return Object.values(positions).map(p => {
      if (p.quantityHeld <= 0.0001) return p;
      const q = quotes.find(q => q.symbol === p.symbol);
      if (!q) return p;
      const currentValue  = q.price * p.quantityHeld;
      const unrealizedPnL = currentValue - p.costBasis;
      return {
        ...p,
        currentPrice:   q.price,
        currentValue,
        unrealizedPnL,
        unrealizedPct:  p.costBasis > 0 ? (unrealizedPnL / p.costBasis) * 100 : 0,
        dailyChangePct: q.changePercent,
      };
    });
  }, [positions, quotes]);

  const totals = useMemo(() => aggregateTotals(positions, enrichedPositions), [positions, enrichedPositions]);

  // Fetch live quotes for all held symbols after transactions load
  useEffect(() => {
    const held = Object.values(positions).filter(p => p.quantityHeld > 0.0001).map(p => p.symbol);
    if (held.length === 0) { setQuotes([]); return; }
    setQuotesLoading(true);
    setQuotesError(null);
    fetch(`${BASE}/portfolio/quotes?symbols=${held.join(',')}`)
      .then(r => r.json())
      .then((data: Quote[]) => { setQuotes(data); setQuotesUpdated(new Date()); })
      .catch(e => setQuotesError(String(e)))
      .finally(() => setQuotesLoading(false));
  }, [positions]);

  const handleFile = async (file: File) => {
    setUploading(true);
    setUploadError(null);
    setAnalysis(null);
    setQuotes([]);
    setFileName(file.name);
    try {
      const txs = await parseFile(file);
      if (txs.length === 0) throw new Error('לא נמצאו פעולות בקובץ — ודא שהקובץ מכיל דוח תנועות');
      setTransactions(txs);
    } catch (e) {
      setUploadError(e instanceof Error ? e.message : String(e));
    } finally {
      setUploading(false);
    }
  };

  const handleRefreshQuotes = () => {
    const held = Object.values(positions).filter(p => p.quantityHeld > 0.0001).map(p => p.symbol);
    if (held.length === 0) return;
    setQuotesLoading(true);
    setQuotesError(null);
    fetch(`${BASE}/portfolio/quotes?symbols=${held.join(',')}`)
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

  // ── Upload zone ─────────────────────────────────────────────────────────────

  if (transactions.length === 0) {
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
      </div>
    );
  }

  // ── Main dashboard ───────────────────────────────────────────────────────────

  return (
    <div className="space-y-5">
      {/* Header bar */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h2 className="text-base font-bold text-gray-800">📊 דוח תנועות — {fileName}</h2>
          <p className="text-xs text-gray-400">{transactions.length} פעולות</p>
        </div>
        <button
          onClick={() => { setTransactions([]); setAnalysis(null); setFileName(null); }}
          className="text-xs text-red-400 hover:text-red-600 underline"
        >
          טען קובץ חדש
        </button>
      </div>

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
                <Bar dataKey="pnl" name="רווח/הפסד" radius={[0,4,4,0]}>
                  {pnlData.map((d, i) => <Cell key={i} fill={d.pnl >= 0 ? '#10b981' : '#ef4444'} />)}
                </Bar>
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
      {enrichedPositions.length > 0 && (
        <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
          <div className="px-5 py-3 border-b border-gray-100 flex items-center justify-between">
            <h3 className="text-sm font-semibold text-gray-700">אחזקות ועמדות</h3>
            <div className="flex gap-4 text-xs text-gray-400">
              <span>✅ פתוחה</span><span>📦 סגורה</span>
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="bg-gray-50">
                <tr>
                  <th className="text-right px-4 py-2 font-medium text-gray-500">נייר</th>
                  <th className="text-right px-4 py-2 font-medium text-gray-500">כמות מוחזקת</th>
                  <th className="text-right px-4 py-2 font-medium text-gray-500">עלות ממוצעת</th>
                  <th className="text-right px-4 py-2 font-medium text-gray-500">שווי עלות</th>
                  <th className="text-right px-4 py-2 font-medium text-gray-500">מחיר כיום</th>
                  <th className="text-right px-4 py-2 font-medium text-gray-500">שווי כיום</th>
                  <th className="text-right px-4 py-2 font-medium text-gray-500">רווח לא ממומש</th>
                  <th className="text-right px-4 py-2 font-medium text-gray-500">רווח ממומש</th>
                  <th className="text-right px-4 py-2 font-medium text-gray-500">דיבידנדים</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {enrichedPositions
                  .sort((a, b) => (b.currentValue ?? b.costBasis) - (a.currentValue ?? a.costBasis))
                  .map(p => (
                    <tr key={p.symbol} className="hover:bg-gray-50">
                      <td className="px-4 py-2.5">
                        <div className="flex items-center gap-1.5">
                          <span className="text-xs">{p.quantityHeld > 0.0001 ? '✅' : '📦'}</span>
                          <span className="font-bold text-gray-800">{p.symbol}</span>
                          {p.name && <span className="text-gray-400 truncate max-w-24"> {p.name}</span>}
                        </div>
                      </td>
                      <td className="px-4 py-2.5 tabular-nums text-gray-700">
                        {p.quantityHeld > 0.0001 ? p.quantityHeld.toFixed(4) : '—'}
                      </td>
                      <td className="px-4 py-2.5 tabular-nums text-gray-600">
                        {p.avgCostPerShare > 0 ? `$${p.avgCostPerShare.toFixed(2)}` : '—'}
                      </td>
                      <td className="px-4 py-2.5 tabular-nums text-blue-600 font-medium">
                        {p.costBasis > 0 ? fmt(p.costBasis) : '—'}
                      </td>
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
                      <td className="px-4 py-2.5 tabular-nums font-medium text-indigo-600">
                        {p.currentValue ? fmt(p.currentValue) : '—'}
                      </td>
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
                      <td className={`px-4 py-2.5 tabular-nums font-semibold ${p.realizedPnL >= 0 ? 'text-green-600' : 'text-red-500'}`}>
                        {p.realizedPnL !== 0 ? `${p.realizedPnL >= 0 ? '+' : ''}${fmt(p.realizedPnL)}` : '—'}
                      </td>
                      <td className="px-4 py-2.5 tabular-nums text-yellow-600">
                        {p.dividends > 0 ? fmt(p.dividends) : '—'}
                      </td>
                    </tr>
                  ))}
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
