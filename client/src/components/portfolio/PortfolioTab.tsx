import { type FC, useRef, useState, useMemo } from 'react';
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

// ── Summary computation ───────────────────────────────────────────────────────

function computeSummary(txs: StockTransaction[]) {
  const bySymbol: Record<string, {
    symbol: string; name?: string;
    totalBought: number; totalSold: number;
    dividends: number; fees: number; quantity: number;
  }> = {};

  let totalBought = 0, totalSold = 0, totalDividends = 0, totalFees = 0;

  for (const tx of txs) {
    const sym = tx.symbol.toUpperCase();
    if (!bySymbol[sym]) bySymbol[sym] = { symbol: sym, name: tx.name, totalBought: 0, totalSold: 0, dividends: 0, fees: 0, quantity: 0 };
    const b = bySymbol[sym];
    if (tx.name && !b.name) b.name = tx.name;

    switch (tx.action) {
      case 'buy':      b.totalBought += tx.amount; b.quantity += tx.quantity ?? 0; totalBought += tx.amount; break;
      case 'sell':     b.totalSold   += tx.amount; b.quantity -= tx.quantity ?? 0; totalSold   += tx.amount; break;
      case 'dividend': b.dividends   += tx.amount; totalDividends += tx.amount; break;
      case 'fee':      b.fees        += tx.amount; totalFees      += tx.amount; break;
    }
  }

  const netPnL = totalSold + totalDividends - totalBought - totalFees;
  return { bySymbol, totalBought, totalSold, totalDividends, totalFees, netPnL };
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
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [analysis, setAnalysis] = useState<PortfolioAIAnalysis | null>(null);
  const [analyzeError, setAnalyzeError] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);

  const summary = useMemo(() => computeSummary(transactions), [transactions]);

  const handleFile = async (file: File) => {
    setUploading(true);
    setUploadError(null);
    setAnalysis(null);
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

  const handleAnalyze = async () => {
    setAnalyzing(true);
    setAnalyzeError(null);
    try {
      const { bySymbol, totalBought, totalSold, totalDividends, totalFees, netPnL } = summary;
      const res = await fetch(`${BASE}/portfolio/analyze`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          summary: {
            totalTransactions: transactions.length,
            totalBought, totalSold, totalDividends, totalFees, netPnL,
            returnPct: totalBought > 0 ? ((netPnL / totalBought) * 100).toFixed(1) : 0,
            holdings: Object.values(bySymbol).map(h => ({
              symbol: h.symbol,
              name: h.name,
              invested: h.totalBought,
              received: h.totalSold,
              dividends: h.dividends,
              fees: h.fees,
              pnl: h.totalSold - h.totalBought + h.dividends,
            })),
          },
        }),
      });
      if (!res.ok) throw new Error(`Server ${res.status}`);
      const data = await res.json() as PortfolioAIAnalysis;
      setAnalysis(data);
    } catch (e) {
      setAnalyzeError(e instanceof Error ? e.message : String(e));
    } finally {
      setAnalyzing(false);
    }
  };

  // ── Chart data ──────────────────────────────────────────────────────────────

  const allocationData = useMemo(() =>
    Object.values(summary.bySymbol)
      .filter(h => h.totalBought > 0)
      .sort((a, b) => b.totalBought - a.totalBought)
      .slice(0, 8)
      .map(h => ({ name: h.symbol, value: Math.round(h.totalBought) })),
  [summary]);

  const pnlData = useMemo(() =>
    Object.values(summary.bySymbol)
      .filter(h => h.totalBought > 0 || h.dividends > 0)
      .map(h => ({
        symbol: h.symbol,
        pnl: Math.round(h.totalSold - h.totalBought + h.dividends),
        dividends: Math.round(h.dividends),
      }))
      .sort((a, b) => b.pnl - a.pnl)
      .slice(0, 10),
  [summary]);

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

  const returnPct = summary.totalBought > 0
    ? ((summary.netPnL / summary.totalBought) * 100)
    : 0;

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

      {/* KPI cards */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <KpiCard label="סה״כ הושקע"    value={fmt(summary.totalBought)}    color="text-blue-600" />
        <KpiCard label="סה״כ נמכר"     value={fmt(summary.totalSold)}      color="text-green-600" />
        <KpiCard label="דיבידנדים"      value={fmt(summary.totalDividends)} color="text-yellow-600" />
        <KpiCard label="עמלות ששולמו"   value={fmt(summary.totalFees)}      color="text-red-500" />
        <KpiCard
          label="רווח/הפסד נטו"
          value={fmt(summary.netPnL)}
          sub={`${returnPct >= 0 ? '+' : ''}${returnPct.toFixed(1)}%`}
          color={summary.netPnL >= 0 ? 'text-green-600' : 'text-red-500'}
        />
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
      {Object.keys(summary.bySymbol).length > 0 && (
        <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
          <div className="px-5 py-3 border-b border-gray-100">
            <h3 className="text-sm font-semibold text-gray-700">פירוט אחזקות</h3>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="bg-gray-50">
                <tr>
                  <th className="text-right px-4 py-2 font-medium text-gray-500">נייר ערך</th>
                  <th className="text-right px-4 py-2 font-medium text-gray-500">סה״כ הושקע</th>
                  <th className="text-right px-4 py-2 font-medium text-gray-500">סה״כ נמכר</th>
                  <th className="text-right px-4 py-2 font-medium text-gray-500">דיבידנדים</th>
                  <th className="text-right px-4 py-2 font-medium text-gray-500">עמלות</th>
                  <th className="text-right px-4 py-2 font-medium text-gray-500">רווח/הפסד</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {Object.values(summary.bySymbol)
                  .sort((a, b) => b.totalBought - a.totalBought)
                  .map(h => {
                    const pnl = h.totalSold - h.totalBought + h.dividends;
                    return (
                      <tr key={h.symbol} className="hover:bg-gray-50">
                        <td className="px-4 py-2.5">
                          <span className="font-bold text-gray-800">{h.symbol}</span>
                          {h.name && <span className="text-gray-400 mr-1 text-xs"> · {h.name}</span>}
                        </td>
                        <td className="px-4 py-2.5 text-blue-600 font-medium">{fmt(h.totalBought)}</td>
                        <td className="px-4 py-2.5 text-green-600">{h.totalSold > 0 ? fmt(h.totalSold) : '—'}</td>
                        <td className="px-4 py-2.5 text-yellow-600">{h.dividends > 0 ? fmt(h.dividends) : '—'}</td>
                        <td className="px-4 py-2.5 text-red-500">{h.fees > 0 ? fmt(h.fees) : '—'}</td>
                        <td className={`px-4 py-2.5 font-semibold ${pnl >= 0 ? 'text-green-600' : 'text-red-500'}`}>
                          {pnl >= 0 ? '+' : ''}{fmt(pnl)}
                        </td>
                      </tr>
                    );
                  })}
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
