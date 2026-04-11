import { useState, useEffect, useCallback, useMemo } from 'react';
import TabNav, { type TabId } from './components/layout/TabNav';
import CashflowTab from './components/cashflow/CashflowTab';
import PortfolioTab from './components/portfolio/PortfolioTab';
import AssetsTab from './components/assets/AssetsTab';
import LoansTab from './components/loans/LoansTab';
import CalendarTab from './components/calendar/CalendarTab';
import type { Transaction, TransactionCategory, Portfolio } from './types';
import { api } from './services/api';

type DateRange = 'week' | 'month' | 'year' | 'all' | 'custom';

const DATE_RANGE_OPTIONS: { id: DateRange; label: string }[] = [
  { id: 'week',   label: 'שבוע'    },
  { id: 'month',  label: 'חודש'    },
  { id: 'year',   label: 'שנה'     },
  { id: 'all',    label: 'הכל'     },
  { id: 'custom', label: 'בחר חודש' },
];

const HEBREW_MONTHS = ['ינואר','פברואר','מרץ','אפריל','מאי','יוני','יולי','אוגוסט','ספטמבר','אוקטובר','נובמבר','דצמבר'];

const filterByRange = (
  txs: Transaction[], range: DateRange,
  customYear?: number, customMonth?: number
): Transaction[] => {
  if (range === 'custom' && customYear != null && customMonth != null) {
    const prefix = `${customYear}-${String(customMonth + 1).padStart(2, '0')}`;
    return txs.filter((t) => t.date.startsWith(prefix));
  }
  if (range === 'all') return txs;
  const now = new Date();
  const cutoff = new Date(now);
  if (range === 'week')  cutoff.setDate(now.getDate() - 7);
  if (range === 'month') cutoff.setMonth(now.getMonth() - 1);
  if (range === 'year')  cutoff.setFullYear(now.getFullYear() - 1);
  return txs.filter((t) => t.date >= cutoff.toISOString().slice(0, 10));
};

const fmt = (v: number) =>
  new Intl.NumberFormat('he-IL', { style: 'currency', currency: 'ILS', maximumFractionDigits: 0 }).format(v);

const EMPTY_PORTFOLIO: Portfolio = {
  assets: [],
  loans: [],
  totalAssetsILS: 0,
  totalLiabilitiesILS: 0,
  netWorthILS: 0,
};

function App() {
  const [activeTab, setActiveTab] = useState<TabId>('cashflow' as TabId);
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [portfolio, setPortfolio] = useState<Portfolio>(EMPTY_PORTFOLIO);
  const [dbStatus, setDbStatus] = useState<'loading' | 'ready' | 'offline'>('loading');
  const [categorizing, setCategorizing] = useState(false);
  const [categorizeError, setCategorizeError] = useState<string | null>(null);
  const [dateRange, setDateRange] = useState<DateRange>('all');
  const today = new Date();
  const [customYear, setCustomYear]   = useState(today.getFullYear());
  const [customMonth, setCustomMonth] = useState(today.getMonth());

  const filteredTransactions = useMemo(
    () => filterByRange(transactions, dateRange, customYear, customMonth),
    [transactions, dateRange, customYear, customMonth]
  );

  // ── Stats widget (always based on full transactions) ──────────────────────
  const stats = useMemo(() => {
    const now = new Date();
    const monthPrefix = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const weekAgo = new Date(now); weekAgo.setDate(now.getDate() - 7);
    const weekStr = weekAgo.toISOString().slice(0, 10);

    const monthTxs = transactions.filter(t => t.date.startsWith(monthPrefix));
    const monthIncome   = monthTxs.filter(t => !t.isDebit).reduce((s, t) => s + t.amount, 0);
    const monthExpenses = monthTxs.filter(t =>  t.isDebit).reduce((s, t) => s + t.amount, 0);
    const monthSavings  = monthIncome - monthExpenses;

    const weekTxs      = transactions.filter(t => t.isDebit && t.date >= weekStr);
    const weekExpenses = weekTxs.reduce((s, t) => s + t.amount, 0);

    // Average weekly spend from all data
    const allMonths = new Set(transactions.filter(t => /^\d{4}-\d{2}/.test(t.date)).map(t => t.date.slice(0, 7)));
    const numWeeks  = Math.max(1, (allMonths.size * 30) / 7);
    const totalSpend = transactions.filter(t => t.isDebit).reduce((s, t) => s + t.amount, 0);
    const avgWeek    = totalSpend / numWeeks;
    const weekDiff   = avgWeek > 0 ? ((weekExpenses - avgWeek) / avgWeek) * 100 : 0;

    return { monthSavings, monthIncome, monthExpenses, weekExpenses, avgWeek, weekDiff };
  }, [transactions]);

  /** Shared categorization runner — used on upload, DB load, and manual trigger */
  const runCategorize = useCallback(async (toTag: Transaction[]) => {
    if (toTag.length === 0) return;
    console.log('[AI] Starting categorization for', toTag.length, 'transactions');
    setCategorizing(true);
    setCategorizeError(null);
    try {
      const categorized = await api.categorize(
        toTag.map(({ id, description, amount, isDebit }) => ({ id, description, amount, isDebit }))
      );
      console.log('[AI] Received', categorized.length, 'categorized results:', categorized.slice(0, 3));
      if (categorized.length > 0) {
        const categoryMap = new Map(categorized.map((c) => [c.id, c.category]));
        setTransactions((prev) =>
          prev.map((tx) => {
            const cat = categoryMap.get(tx.id);
            return cat ? { ...tx, category: cat } : tx;
          })
        );
      }
    } catch (e) {
      console.error('[AI] Error:', e);
      setCategorizeError(e instanceof Error ? e.message : String(e));
    } finally {
      setCategorizing(false);
    }
  }, []);

  // Load persisted data on startup, then auto-categorize anything still uncategorized
  useEffect(() => {
    const load = async () => {
      try {
        const [savedTxs, savedPortfolio] = await Promise.all([
          api.getTransactions(),
          api.getPortfolio(),
        ]);
        if (savedTxs.length > 0) setTransactions(savedTxs);
        if (savedPortfolio) setPortfolio(savedPortfolio);
        setDbStatus('ready'); // mark ready before AI so persist effect catches categorized results
        const needsAI = savedTxs.filter((t) => !t.category);
        if (needsAI.length > 0) await runCategorize(needsAI);
      } catch {
        setDbStatus('offline');
      }
    };
    load();
  }, [runCategorize]);

  // Persist portfolio whenever it changes
  useEffect(() => {
    if (dbStatus !== 'ready') return;
    api.savePortfolio(portfolio).catch(() => {/* silent */});
  }, [portfolio, dbStatus]);

  /**
   * Called when FileUpload gives us new transactions.
   * Deduplicates against existing, sends fresh ones to server (server merges),
   * then categorizes the newly added ones.
   */
  const handleTransactionsLoaded = useCallback(async (incoming: Transaction[]) => {
    let fresh: Transaction[] = [];
    setTransactions((prev) => {
      const existingIds = new Set(prev.map((t) => t.id));
      fresh = incoming.filter((t) => !existingIds.has(t.id));
      return [...prev, ...fresh];
    });
    // Persist only the fresh ones — server merges with existing on disk
    if (fresh.length > 0 && dbStatus === 'ready') {
      api.saveTransactions(fresh).catch(() => {});
    }
    // Categorize fresh transactions
    if (incoming.length > 0) await runCategorize(incoming);
  }, [runCategorize, dbStatus]);

  /** Manual re-categorize — sends everything without a real category to AI */
  const handleCategorizeAll = useCallback(async () => {
    const uncategorized = transactions.filter((t) => !t.category);
    await runCategorize(uncategorized);
  }, [transactions, runCategorize]);

  const handleCategoryUpdate = useCallback((id: string, category: TransactionCategory) => {
    setTransactions((prev) =>
      prev.map((tx) => (tx.id === id ? { ...tx, category } : tx))
    );
  }, []);

  const handleClearTransactions = useCallback(async () => {
    setTransactions([]);
    try { await api.clearTransactions(); } catch {/* offline */}
  }, []);

  const debitCount = filteredTransactions.filter((t) => t.isDebit).length;
  const showRangeFilter = ['cashflow', 'calendar'].includes(activeTab) && transactions.length > 0;

  return (
    <div dir="rtl" className="min-h-screen bg-gray-50 font-sans">
      {/* Header */}
      <header className="bg-white border-b border-gray-200 px-6 py-4 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-gray-900">🚀 RiseUp — מרכז הפיקוד הפיננסי</h1>
          <p className="text-sm text-gray-500 mt-0.5">ניהול נכסים, תזרים והלוואות — הכל במקום אחד</p>
        </div>
        <div className="flex items-center gap-4">
          {categorizing && (
            <span className="text-xs text-blue-500 animate-pulse">🤖 מקטגרז עם AI...</span>
          )}
          {categorizeError && !categorizing && (
            <span className="text-xs text-red-500 max-w-xs truncate" title={categorizeError}>
              ⚠️ שגיאת AI: {categorizeError.slice(0, 60)}
            </span>
          )}
          {transactions.length > 0 && (
            <button
              onClick={handleClearTransactions}
              className="text-xs text-red-400 hover:text-red-600 underline"
            >
              נקה תנועות
            </button>
          )}
          <div className="text-left text-xs text-gray-400 space-y-0.5">
            <p className="flex items-center gap-1">
              <span className={`w-2 h-2 rounded-full inline-block ${
                dbStatus === 'ready' ? 'bg-green-400' :
                dbStatus === 'offline' ? 'bg-orange-400' : 'bg-gray-300'
              }`} />
              {dbStatus === 'ready' ? 'מחובר ל-DB' : dbStatus === 'offline' ? 'מצב לא מקוון' : 'טוען...'}
            </p>
            <p>{filteredTransactions.length} תנועות ({debitCount} הוצאות){dateRange !== 'all' ? ` · ${DATE_RANGE_OPTIONS.find(o => o.id === dateRange)?.label}` : ''}</p>
            <p>שווי נקי: ₪{portfolio.netWorthILS.toLocaleString()}</p>
          </div>
        </div>
      </header>

      <TabNav activeTab={activeTab} onTabChange={setActiveTab} />

      {/* Stats widget */}
      {transactions.length > 0 && (
        <div className="bg-white border-b border-gray-100 px-6 py-2 flex items-center gap-6 overflow-x-auto">
          {/* Monthly savings */}
          <div className="flex items-center gap-2 shrink-0">
            <span className="text-xs text-gray-400">חיסכון החודש:</span>
            <span className={`text-sm font-bold ${stats.monthSavings >= 0 ? 'text-green-600' : 'text-red-500'}`}>
              {stats.monthSavings >= 0 ? '+' : ''}{fmt(stats.monthSavings)}
            </span>
            <span className="text-xs text-gray-300">({fmt(stats.monthIncome)} הכנסה · {fmt(stats.monthExpenses)} הוצאה)</span>
          </div>

          <div className="w-px h-6 bg-gray-200 shrink-0" />

          {/* Weekly spend vs average */}
          <div className="flex items-center gap-2 shrink-0">
            <span className="text-xs text-gray-400">הוצאות השבוע:</span>
            <span className="text-sm font-bold text-gray-700">{fmt(stats.weekExpenses)}</span>
            {stats.avgWeek > 0 && (
              <span className={`text-xs font-semibold px-1.5 py-0.5 rounded-full ${
                stats.weekDiff > 15  ? 'bg-red-100 text-red-600' :
                stats.weekDiff < -15 ? 'bg-green-100 text-green-600' :
                                       'bg-gray-100 text-gray-500'
              }`}>
                {stats.weekDiff > 0 ? '▲' : '▼'} {Math.abs(stats.weekDiff).toFixed(0)}% מהממוצע
              </span>
            )}
            <span className="text-xs text-gray-300">(ממוצע שבועי: {fmt(stats.avgWeek)})</span>
          </div>
        </div>
      )}

      {/* Date range filter bar */}
      {showRangeFilter && (
        <div className="bg-white border-b border-gray-100 px-6 py-2 flex items-center gap-2 flex-wrap">
          <span className="text-xs text-gray-400 ml-1">טווח זמן:</span>
          {DATE_RANGE_OPTIONS.map((opt) => (
            <button
              key={opt.id}
              onClick={() => setDateRange(opt.id)}
              className={`px-3 py-1 rounded-full text-xs font-medium transition-colors ${
                dateRange === opt.id
                  ? 'bg-blue-600 text-white'
                  : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
              }`}
            >
              {opt.label}
            </button>
          ))}

          {/* Custom month/year picker */}
          {dateRange === 'custom' && (
            <div className="flex items-center gap-1 mr-2">
              <select
                value={customMonth}
                onChange={e => setCustomMonth(Number(e.target.value))}
                className="text-xs border border-blue-300 rounded px-2 py-1 focus:outline-none bg-white"
              >
                {HEBREW_MONTHS.map((m, i) => <option key={i} value={i}>{m}</option>)}
              </select>
              <select
                value={customYear}
                onChange={e => setCustomYear(Number(e.target.value))}
                className="text-xs border border-blue-300 rounded px-2 py-1 focus:outline-none bg-white"
              >
                {Array.from({ length: 5 }, (_, i) => today.getFullYear() - i).map(y =>
                  <option key={y} value={y}>{y}</option>
                )}
              </select>
            </div>
          )}

          {dateRange !== 'all' && (
            <span className="text-xs text-gray-400">
              ({filteredTransactions.length} מתוך {transactions.length} תנועות)
            </span>
          )}
        </div>
      )}

      <main className="max-w-6xl mx-auto px-4 py-6">
        {activeTab === 'cashflow' && (
          <CashflowTab
            transactions={filteredTransactions}
            onTransactionsLoaded={handleTransactionsLoaded}
            onCategoryUpdate={handleCategoryUpdate}
            onCategorizeAll={handleCategorizeAll}
            categorizing={categorizing}
            categorizeError={categorizeError}
          />
        )}
        {activeTab === 'stock_portfolio' && <PortfolioTab />}
        {activeTab === 'assets' && (
          <AssetsTab portfolio={portfolio} onPortfolioChange={setPortfolio} />
        )}
        {activeTab === 'loans' && (
          <LoansTab portfolio={portfolio} onPortfolioChange={setPortfolio} />
        )}
        {activeTab === 'calendar' && (
          <CalendarTab transactions={filteredTransactions} />
        )}
      </main>
    </div>
  );
}

export default App;
