import { type FC, useState, useMemo } from 'react';
import type { Transaction, TransactionCategory, GeminiInsight } from '../../types';
import { api } from '../../services/api';

interface CategorizationTabProps {
  transactions: Transaction[];
  onCategoryUpdate: (id: string, category: TransactionCategory) => void;
  onCategorizeAll: () => Promise<void>;
  categorizing: boolean;
  categorizeError: string | null;
}

// ---- Category metadata ----
export const CATEGORY_LABELS: Record<string, string> = {
  // Income
  salary:          '💰 משכורת',
  rental_income:   '🏘️ שכר דירה (מתקבל)',
  refund:          '↩️ החזר / זיכוי',
  transfer_in:     '↘️ העברה נכנסת',
  // Housing
  mortgage:        '🏦 משכנתא',
  rent_paid:       '🏠 שכר דירה (משולם)',
  home_expenses:   '🔧 הוצאות בית',
  // Food
  food_restaurant: '🍽️ אוכל בחוץ',
  groceries:       '🛒 סופרמרקט',
  // Transport
  car:             '🚗 רכב',
  public_transport:'🚌 תחב"צ',
  // Spending
  shopping:        '🛍️ קניות',
  subscriptions:   '🔄 מנויים',
  health:          '💊 בריאות',
  utilities:       '💡 חשבונות שוטפים',
  education:       '📚 חינוך',
  entertainment:   '🎬 בידור',
  travel:          '✈️ טיסות ונסיעות',
  investment:      '📈 השקעות',
  other:           '📦 אחר',
};

const CATEGORY_COLORS: Record<string, string> = {
  salary: '#10b981', rental_income: '#059669', refund: '#34d399', transfer_in: '#6ee7b7',
  mortgage: '#1d4ed8', rent_paid: '#3b82f6', home_expenses: '#60a5fa',
  food_restaurant: '#f97316', groceries: '#fb923c',
  car: '#06b6d4', public_transport: '#0ea5e9',
  shopping: '#f59e0b', subscriptions: '#8b5cf6', health: '#ec4899',
  utilities: '#14b8a6', education: '#6366f1', entertainment: '#a855f7',
  travel: '#84cc16', investment: '#22c55e', other: '#9ca3af',
};

const INCOME_CATS = new Set<TransactionCategory>(['salary', 'rental_income', 'refund', 'transfer_in']);

const fmt = (v: number) =>
  new Intl.NumberFormat('he-IL', { style: 'currency', currency: 'ILS', maximumFractionDigits: 0 }).format(v);

const ALL_CATS = Object.keys(CATEGORY_LABELS) as TransactionCategory[];

// ---- Category group card ----
const TX_LIMIT = 10;

const GroupCard: FC<{
  categoryKey: string;
  txs: Transaction[];
  onCategoryUpdate: (id: string, cat: TransactionCategory) => void;
  isIncome: boolean;
}> = ({ categoryKey, txs, onCategoryUpdate, isIncome }) => {
  const [open, setOpen]           = useState(false);
  const [expanded, setExpanded]   = useState(false);
  const total = txs.reduce((s, t) => s + t.amount, 0);
  const color = CATEGORY_COLORS[categoryKey] ?? '#9ca3af';
  const label = CATEGORY_LABELS[categoryKey] ?? categoryKey;
  const sorted  = [...txs].sort((a, b) => b.amount - a.amount);
  const visible = expanded ? sorted : sorted.slice(0, TX_LIMIT);
  const hidden  = sorted.length - TX_LIMIT;

  return (
    <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
      <button
        onClick={() => setOpen((p) => !p)}
        className="w-full flex items-center gap-3 px-5 py-3.5 hover:bg-gray-50 transition-colors text-right"
      >
        <span className="w-3 h-3 rounded-full shrink-0" style={{ background: color }} />
        <span className="font-semibold text-gray-800 flex-1 text-right text-sm">{label}</span>
        <span className="text-xs text-gray-400 shrink-0">{txs.length} פעולות</span>
        <span className={`font-bold shrink-0 ${isIncome ? 'text-green-600' : 'text-red-500'}`}>
          {isIncome ? '+' : '-'}{fmt(total)}
        </span>
        <span className="text-gray-300 text-sm shrink-0">{open ? '▲' : '▼'}</span>
      </button>

      {open && (
        <div className="border-t border-gray-100 divide-y divide-gray-50">
          {visible.map((tx) => (
            <div key={tx.id} className="flex items-center gap-2 px-5 py-2.5 hover:bg-gray-50">
              <span className="text-xs text-gray-400 w-24 shrink-0">{tx.date}</span>
              <span className={`text-xs px-1.5 py-0.5 rounded shrink-0 ${
                tx.source === 'credit_card' ? 'bg-purple-50 text-purple-500' : 'bg-gray-100 text-gray-400'
              }`}>
                {tx.source === 'credit_card' ? 'ויזה' : 'עו"ש'}
              </span>
              <span className="text-sm text-gray-700 flex-1 truncate">{tx.description}</span>
              <span className={`text-sm font-medium shrink-0 ${isIncome ? 'text-green-600' : 'text-red-500'}`}>
                {isIncome ? '+' : '-'}{fmt(tx.amount)}
              </span>
              <select
                value={tx.category ?? 'other'}
                onClick={(e) => e.stopPropagation()}
                onChange={(e) => onCategoryUpdate(tx.id, e.target.value as TransactionCategory)}
                style={{ borderColor: color }}
                className="border rounded px-1.5 py-0.5 text-xs shrink-0 focus:outline-none bg-white w-40"
              >
                {ALL_CATS.map((c) => (
                  <option key={c} value={c}>{CATEGORY_LABELS[c]}</option>
                ))}
              </select>
            </div>
          ))}
          {sorted.length > TX_LIMIT && (
            <div className="px-5 py-2">
              <button
                onClick={() => setExpanded(v => !v)}
                className="flex items-center gap-1.5 text-xs text-blue-500 hover:text-blue-700 transition-colors"
              >
                <span className={`transition-transform duration-150 ${expanded ? 'rotate-180' : ''}`}>▾</span>
                {expanded ? 'הסתר פעולות' : `הצג עוד ${hidden} פעולות`}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

// ---- Main component ----
const CategorizationTab: FC<CategorizationTabProps> = ({
  transactions, onCategoryUpdate, onCategorizeAll, categorizing, categorizeError,
}) => {
  const [insights, setInsights] = useState<GeminiInsight[]>([]);
  const [analyzing, setAnalyzing] = useState(false);
  const [analyzeError, setAnalyzeError] = useState<string | null>(null);

  const categorizedGroups = useMemo(() => {
    const incomeMap = new Map<string, Transaction[]>();
    const expenseMap = new Map<string, Transaction[]>();
    const pendingList: Transaction[] = [];

    for (const tx of transactions) {
      if (!tx.category) {
        // No category yet — AI hasn't decided; show in a separate pending group
        pendingList.push(tx);
        continue;
      }
      const isIncomeCategory = INCOME_CATS.has(tx.category);
      const map = isIncomeCategory ? incomeMap : expenseMap;
      if (!map.has(tx.category)) map.set(tx.category, []);
      map.get(tx.category)!.push(tx);
    }

    const sortByTotal = (map: Map<string, Transaction[]>) =>
      Array.from(map.entries()).sort(
        ([, a], [, b]) => b.reduce((s, t) => s + t.amount, 0) - a.reduce((s, t) => s + t.amount, 0)
      );

    return {
      income: sortByTotal(incomeMap),
      expenses: sortByTotal(expenseMap),
      pending: pendingList,
    };
  }, [transactions]);

  const totalIncome = transactions
    .filter((t) => t.category && INCOME_CATS.has(t.category))
    .reduce((s, t) => s + t.amount, 0);
  const totalExpenses = transactions
    .filter((t) => t.category && !INCOME_CATS.has(t.category))
    .reduce((s, t) => s + t.amount, 0);
  const uncategorized = transactions.filter((t) => !t.category).length;

  const categoryTotals = categorizedGroups.expenses.reduce<Record<string, number>>(
    (acc, [cat, txs]) => { acc[cat] = txs.reduce((s, t) => s + t.amount, 0); return acc; }, {}
  );
  const months = useMemo(() => {
    const s = new Set(transactions.filter((t) => /^\d{4}-\d{2}/.test(t.date)).map((t) => t.date.slice(0, 7)));
    return s.size || 1;
  }, [transactions]);
  const avgBurn = totalExpenses / months;

  const handleAnalyze = async () => {
    setAnalyzing(true); setAnalyzeError(null);
    try { setInsights(await api.analyze(categoryTotals, avgBurn)); }
    catch (e) { setAnalyzeError(e instanceof Error ? e.message : String(e)); }
    finally { setAnalyzing(false); }
  };

  if (transactions.length === 0) {
    return (
      <div className="bg-blue-50 border border-blue-200 rounded-xl p-8 text-center text-blue-600">
        <p className="text-lg font-medium">📤 טען קובץ בנק בלשונית תזרים מזומנים</p>
        <p className="text-sm mt-1">הקטגוריות יתמלאו אוטומטית</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* AI banner */}
      <div className={`rounded-xl border p-4 flex items-center justify-between gap-4 ${
        categorizeError ? 'bg-red-50 border-red-200' :
        uncategorized > 0 ? 'bg-blue-50 border-blue-200' : 'bg-green-50 border-green-200'
      }`}>
        <div className="flex-1">
          {categorizeError
            ? <p className="text-sm font-medium text-red-700">⚠️ {categorizeError}</p>
            : uncategorized > 0
            ? <><p className="text-sm font-semibold text-blue-800">🤖 {uncategorized} פעולות ממתינות לסיווג AI</p>
               <p className="text-xs text-blue-500 mt-0.5">הסיווג האוטומטי ע"י מילות מפתח מכסה ~80%. לחץ לסיווג שאר הפעולות עם Gemini.</p></>
            : <p className="text-sm font-semibold text-green-700">✅ כל הפעולות מסווגות ({transactions.length})</p>
          }
        </div>
        <button
          onClick={onCategorizeAll} disabled={categorizing}
          className={`shrink-0 px-5 py-2 rounded-lg text-sm font-semibold transition-colors disabled:opacity-50 ${
            categorizeError ? 'bg-red-600 text-white' :
            uncategorized > 0 ? 'bg-blue-600 text-white' : 'bg-green-600 text-white'
          }`}
        >
          {categorizing ? '⏳ מסווג...' : categorizeError ? 'נסה שוב' : uncategorized > 0 ? 'קטגרז עם AI' : 'קטגרז מחדש'}
        </button>
      </div>

      {/* Totals */}
      <div className="grid grid-cols-2 gap-4">
        <div className="bg-white rounded-xl border border-gray-200 p-4">
          <p className="text-xs text-gray-500">סה"כ הכנסות</p>
          <p className="text-2xl font-bold text-green-600 mt-1">{fmt(totalIncome)}</p>
          <p className="text-xs text-gray-400">{transactions.filter(t => t.category && INCOME_CATS.has(t.category)).length} פעולות</p>
        </div>
        <div className="bg-white rounded-xl border border-gray-200 p-4">
          <p className="text-xs text-gray-500">סה"כ הוצאות</p>
          <p className="text-2xl font-bold text-red-500 mt-1">{fmt(totalExpenses)}</p>
          <p className="text-xs text-gray-400">{transactions.filter(t => t.category && !INCOME_CATS.has(t.category)).length} פעולות</p>
        </div>
      </div>

      {/* Income groups */}
      {categorizedGroups.income.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-sm font-bold text-gray-500 uppercase tracking-wide px-1">הכנסות</h2>
          {categorizedGroups.income.map(([cat, txs]) => (
            <GroupCard key={cat} categoryKey={cat} txs={txs}
              onCategoryUpdate={onCategoryUpdate} isIncome />
          ))}
        </section>
      )}

      {/* Expense groups */}
      {categorizedGroups.expenses.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-sm font-bold text-gray-500 uppercase tracking-wide px-1">הוצאות</h2>
          {categorizedGroups.expenses.map(([cat, txs]) => (
            <GroupCard key={cat} categoryKey={cat} txs={txs}
              onCategoryUpdate={onCategoryUpdate} isIncome={false} />
          ))}
        </section>
      )}

      {/* Pending AI categorization */}
      {categorizedGroups.pending.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-sm font-bold text-amber-500 uppercase tracking-wide px-1">
            ⏳ ממתין לסיווג AI ({categorizedGroups.pending.length} פעולות)
          </h2>
          <div className="bg-white rounded-xl border border-amber-200 overflow-hidden">
            <div className="border-t border-gray-100 divide-y divide-gray-50">
              {[...categorizedGroups.pending]
                .sort((a, b) => b.amount - a.amount)
                .map((tx) => (
                  <div key={tx.id} className="flex items-center gap-2 px-5 py-2.5 hover:bg-gray-50">
                    <span className="text-xs text-gray-400 w-24 shrink-0">{tx.date}</span>
                    <span className={`text-xs px-1.5 py-0.5 rounded shrink-0 ${
                      tx.source === 'credit_card' ? 'bg-purple-50 text-purple-500' : 'bg-gray-100 text-gray-400'
                    }`}>
                      {tx.source === 'credit_card' ? 'ויזה' : 'עו"ש'}
                    </span>
                    <span className="text-sm text-gray-700 flex-1 truncate">{tx.description}</span>
                    <span className="text-sm font-medium text-gray-500 shrink-0">
                      {tx.isDebit ? '-' : '+'}{fmt(tx.amount)}
                    </span>
                    <select
                      value=""
                      onClick={(e) => e.stopPropagation()}
                      onChange={(e) => onCategoryUpdate(tx.id, e.target.value as TransactionCategory)}
                      className="border rounded px-1.5 py-0.5 text-xs shrink-0 focus:outline-none bg-white w-40 border-amber-300"
                    >
                      <option value="" disabled>בחר קטגוריה...</option>
                      {ALL_CATS.map((c) => (
                        <option key={c} value={c}>{CATEGORY_LABELS[c]}</option>
                      ))}
                    </select>
                  </div>
                ))}
            </div>
          </div>
        </section>
      )}

      {/* Gemini anomaly analysis */}
      <div className="bg-white rounded-xl border border-gray-200 p-5">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h3 className="text-sm font-semibold text-gray-700">🤖 ניתוח חריגות — Gemini</h3>
            <p className="text-xs text-gray-400">שריפה ממוצעת לחודש: ₪{Math.round(avgBurn).toLocaleString()}</p>
          </div>
          <button onClick={handleAnalyze} disabled={analyzing}
            className="bg-blue-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-50">
            {analyzing ? '🔄 מנתח...' : 'נתח הוצאות'}
          </button>
        </div>
        {analyzeError && <p className="text-red-500 text-sm mb-2">{analyzeError}</p>}
        {insights.length > 0 ? (
          <div className="space-y-3">
            {insights.map((ins, i) => (
              <div key={i} className={`rounded-lg p-4 border-r-4 ${
                ins.severity === 'high' ? 'bg-red-50 border-red-500' :
                ins.severity === 'medium' ? 'bg-orange-50 border-orange-400' :
                'bg-yellow-50 border-yellow-400'
              }`}>
                <p className="font-semibold text-gray-800 text-sm">{ins.title}</p>
                <p className="text-sm text-gray-600 mt-1">{ins.description}</p>
              </div>
            ))}
          </div>
        ) : (!analyzing && !analyzeError &&
          <p className="text-gray-400 text-sm">לחץ "נתח הוצאות" לקבלת תובנות AI</p>
        )}
      </div>
    </div>
  );
};

export default CategorizationTab;
