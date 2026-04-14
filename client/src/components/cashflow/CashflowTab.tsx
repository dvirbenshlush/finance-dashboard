import { type FC, useMemo, useState } from 'react';
import type { Transaction, TransactionCategory } from '../../types';
import { CATEGORY_LABELS } from '../categorization/CategorizationTab';
import CategorizationTab from '../categorization/CategorizationTab';
import DualFileUpload from '../upload/DualFileUpload';

interface CashflowTabProps {
  transactions: Transaction[];
  onTransactionsLoaded: (txs: Transaction[]) => void;
  onCategoryUpdate: (id: string, category: TransactionCategory) => void;
  onCategorizeAll: () => Promise<void>;
  categorizing: boolean;
  categorizeError: string | null;
}

const fmt = (v: number) =>
  new Intl.NumberFormat('he-IL', { style: 'currency', currency: 'ILS', maximumFractionDigits: 0 }).format(v);

const LS_GOAL = 'otzar_monthly_goal';
const LS_CASH = 'otzar_cash_balance';

// Category buckets
const INCOME_CATS = new Set(['salary', 'rental_income', 'refund', 'transfer_in']);
const FIXED_CATS  = new Set(['mortgage', 'rent_paid', 'home_expenses', 'utilities', 'subscriptions', 'education']);
const GROCERY_CATS = new Set(['groceries']);
// anything else with a category is variable; uncategorized goes to variable too

function getWeekOfMonth(dateStr: string): number {
  const day = parseInt(dateStr.slice(8, 10), 10);
  return Math.ceil(day / 7);
}

const WEEK_LABELS = ['', 'שבוע 1 (1–7)', 'שבוע 2 (8–14)', 'שבוע 3 (15–21)', 'שבוע 4 (22–28)', 'שבוע 5 (29+)'];

// ---- Sub-components ----

const BigCard: FC<{
  label: string;
  value: number;
  sub?: string;
  positive?: boolean;
  neutral?: boolean;
}> = ({ label, value, sub, positive, neutral }) => {
  const color = neutral ? 'text-gray-700'
    : positive === undefined ? 'text-gray-700'
    : value >= 0 ? 'text-green-600' : 'text-red-500';
  return (
    <div className="bg-white rounded-xl border border-gray-200 p-5 flex flex-col gap-1">
      <p className="text-xs text-gray-400">{label}</p>
      <p className={`text-2xl font-bold ${color}`}>{fmt(value)}</p>
      {sub && <p className="text-xs text-gray-400">{sub}</p>}
    </div>
  );
};

const BucketCard: FC<{
  title: string;
  icon: string;
  total: number;
  transactions: Transaction[];
  colorClass: string;
}> = ({ title, icon, total, transactions, colorClass }) => {
  const [open, setOpen] = useState(false);
  const sorted = [...transactions].sort((a, b) => b.amount - a.amount);
  return (
    <div className="bg-white rounded-xl border border-gray-200 flex flex-col">
      <button
        onClick={() => setOpen(o => !o)}
        className="flex items-center justify-between px-4 py-3 hover:bg-gray-50 rounded-xl transition-colors"
      >
        <div className="flex items-center gap-2">
          <span className="text-lg">{icon}</span>
          <div className="text-right">
            <p className="text-xs text-gray-400">{title}</p>
            <p className={`text-lg font-bold ${colorClass}`}>{fmt(total)}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-gray-400">{transactions.length} פעולות</span>
          <span className="text-gray-300 text-xs">{open ? '▲' : '▼'}</span>
        </div>
      </button>
      {open && (
        <div className="border-t border-gray-100 max-h-52 overflow-y-auto divide-y divide-gray-50">
          {sorted.map(tx => (
            <div key={tx.id} className="flex items-center gap-2 px-4 py-1.5 hover:bg-gray-50">
              <span className="text-xs text-gray-400 w-12 shrink-0">{tx.date.slice(5)}</span>
              <span className="text-xs text-gray-600 flex-1 truncate">{tx.description}</span>
              <span className="text-xs font-medium text-gray-700 shrink-0">
                {tx.category ? (CATEGORY_LABELS[tx.category]?.slice(0, 2) ?? '') : '⏳'}
              </span>
              <span className={`text-xs font-semibold shrink-0 ${colorClass}`}>
                {fmt(tx.amount)}
              </span>
            </div>
          ))}
          {transactions.length === 0 && (
            <p className="px-4 py-3 text-xs text-gray-400 text-center">אין פעולות</p>
          )}
        </div>
      )}
    </div>
  );
};

const WeeklyList: FC<{ transactions: Transaction[] }> = ({ transactions }) => {
  const weeks = useMemo(() => {
    const map = new Map<number, Transaction[]>();
    for (const tx of transactions) {
      if (!tx.isDebit) continue;
      const w = getWeekOfMonth(tx.date);
      if (!map.has(w)) map.set(w, []);
      map.get(w)!.push(tx);
    }
    return Array.from(map.entries()).sort(([a], [b]) => b - a); // latest week first
  }, [transactions]);

  if (weeks.length === 0) return null;

  return (
    <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
      <div className="px-4 py-3 border-b border-gray-100">
        <h3 className="text-sm font-semibold text-gray-700">הוצאות לפי שבועות — החודש הנוכחי</h3>
      </div>
      <div className="divide-y divide-gray-100">
        {weeks.map(([week, txs]) => {
          const total = txs.reduce((s, t) => s + t.amount, 0);
          const sorted = [...txs].sort((a, b) => b.amount - a.amount);
          return (
            <details key={week} open={week === weeks[0]?.[0]}>
              <summary className="flex items-center justify-between px-4 py-3 cursor-pointer hover:bg-gray-50 select-none">
                <div className="flex items-center gap-3">
                  <span className="text-xs font-semibold text-gray-600">{WEEK_LABELS[week] ?? `שבוע ${week}`}</span>
                  <span className="text-xs text-gray-400">{txs.length} הוצאות</span>
                </div>
                <span className="text-sm font-bold text-red-500">{fmt(total)}</span>
              </summary>
              <div className="border-t border-gray-50 divide-y divide-gray-50 max-h-56 overflow-y-auto">
                {sorted.map(tx => (
                  <div key={tx.id} className="flex items-center gap-3 px-5 py-1.5 hover:bg-gray-50">
                    <span className="text-xs text-gray-400 w-12 shrink-0">{tx.date.slice(5)}</span>
                    <span className={`text-xs px-1.5 py-0.5 rounded shrink-0 ${
                      tx.source === 'credit_card' ? 'bg-purple-50 text-purple-600' : 'bg-gray-100 text-gray-500'
                    }`}>
                      {tx.source === 'credit_card' ? 'ויזה' : 'חשבון'}
                    </span>
                    <span className="text-xs text-gray-600 flex-1 truncate">{tx.description}</span>
                    {tx.category && (
                      <span className="text-xs text-gray-400 shrink-0">
                        {CATEGORY_LABELS[tx.category]?.split(' ').slice(1).join(' ') ?? tx.category}
                      </span>
                    )}
                    <span className="text-xs font-semibold text-red-500 shrink-0">{fmt(tx.amount)}</span>
                  </div>
                ))}
              </div>
            </details>
          );
        })}
      </div>
    </div>
  );
};

// ---- Main tab ----
const CashflowTab: FC<CashflowTabProps> = ({
  transactions, onTransactionsLoaded,
  onCategoryUpdate, onCategorizeAll, categorizing, categorizeError,
}) => {
  const [monthlyGoal, setMonthlyGoal] = useState<number>(
    () => parseFloat(localStorage.getItem(LS_GOAL) ?? '0') || 0
  );
  const [cashBalance, setCashBalance] = useState<number>(
    () => parseFloat(localStorage.getItem(LS_CASH) ?? '0') || 0
  );
  const [goalInput, setGoalInput] = useState(monthlyGoal > 0 ? String(monthlyGoal) : '');
  const [cashInput, setCashInput] = useState(cashBalance > 0 ? String(cashBalance) : '');

  const saveGoal = (val: string) => {
    const n = parseFloat(val.replace(/[,\s]/g, '')) || 0;
    setMonthlyGoal(n);
    localStorage.setItem(LS_GOAL, String(n));
  };
  const saveCash = (val: string) => {
    const n = parseFloat(val.replace(/[,\s]/g, '')) || 0;
    setCashBalance(n);
    localStorage.setItem(LS_CASH, String(n));
  };

  const today = new Date();
  const monthPrefix = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}`;
  const dayOfMonth = today.getDate();
  const daysInMonth = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate();
  const daysRemaining = daysInMonth - dayOfMonth;

  // Week bounds (Monday–Sunday)
  const dayOfWeek = today.getDay(); // 0=Sun
  const mondayOffset = (dayOfWeek + 6) % 7;
  const startOfWeek = new Date(today);
  startOfWeek.setDate(today.getDate() - mondayOffset);
  startOfWeek.setHours(0, 0, 0, 0);
  const startOfWeekStr = startOfWeek.toISOString().slice(0, 10);
  const daysRemainingWeek = 7 - mondayOffset - 1; // days after today in this week

  const {
    incomeTxs, fixedTxs, groceryTxs, variableTxs,
    totalIncome, totalFixed, totalGrocery, totalVariable,
    weekSpent,
  } = useMemo(() => {
    const inc: Transaction[] = [], fix: Transaction[] = [], groc: Transaction[] = [], vari: Transaction[] = [];
    let weekSpent = 0;

    for (const tx of transactions) {
      if (!tx.date.startsWith(monthPrefix)) continue;
      const cat = tx.category;

      if (!tx.isDebit || (cat && INCOME_CATS.has(cat))) {
        inc.push(tx);
      } else if (cat && FIXED_CATS.has(cat)) {
        fix.push(tx);
        if (tx.date >= startOfWeekStr) weekSpent += tx.amount;
      } else if (cat && GROCERY_CATS.has(cat)) {
        groc.push(tx);
        if (tx.date >= startOfWeekStr) weekSpent += tx.amount;
      } else if (tx.isDebit) {
        vari.push(tx);
        if (tx.date >= startOfWeekStr) weekSpent += tx.amount;
      }
    }

    return {
      incomeTxs: inc, fixedTxs: fix, groceryTxs: groc, variableTxs: vari,
      totalIncome:   inc.reduce((s, t) => s + t.amount, 0),
      totalFixed:    fix.reduce((s, t) => s + t.amount, 0),
      totalGrocery:  groc.reduce((s, t) => s + t.amount, 0),
      totalVariable: vari.reduce((s, t) => s + t.amount, 0),
      weekSpent,
    };
  }, [transactions, monthPrefix, startOfWeekStr]);

  const totalSpentMonth = totalFixed + totalGrocery + totalVariable;
  const remainingMonth  = monthlyGoal > 0 ? monthlyGoal - totalSpentMonth : 0;

  // Weekly budget = proportional share of monthly goal
  const weeklyBudget   = monthlyGoal > 0 ? (monthlyGoal / daysInMonth) * 7 : 0;
  const remainingWeek  = weeklyBudget - weekSpent;

  // End-of-month projection: current daily burn × days remaining
  const dailyBurn        = dayOfMonth > 0 ? totalSpentMonth / dayOfMonth : 0;
  const projectedSpend   = dailyBurn * daysRemaining;
  const projectedBalance = cashBalance > 0
    ? cashBalance - projectedSpend
    : (monthlyGoal > 0 ? remainingMonth - projectedSpend : 0);

  const currentMonthTxs = transactions.filter(t => t.date.startsWith(monthPrefix));

  return (
    <div className="space-y-4">

      {/* ── Goal + Cash inputs ─────────────────────────────────── */}
      <div className="bg-white rounded-xl border border-gray-200 px-5 py-4 flex flex-wrap gap-4 items-end">
        <div className="flex flex-col gap-1">
          <label className="text-xs text-gray-500 font-medium">🎯 יעד הוצאות חודשי</label>
          <div className="flex items-center gap-1">
            <span className="text-sm text-gray-400">₪</span>
            <input
              type="number"
              value={goalInput}
              onChange={e => setGoalInput(e.target.value)}
              onBlur={e => saveGoal(e.target.value)}
              placeholder="לדוג׳ 8000"
              className="w-32 border border-gray-300 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400"
            />
          </div>
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-xs text-gray-500 font-medium">💵 יתרה בחשבון כרגע</label>
          <div className="flex items-center gap-1">
            <span className="text-sm text-gray-400">₪</span>
            <input
              type="number"
              value={cashInput}
              onChange={e => setCashInput(e.target.value)}
              onBlur={e => saveCash(e.target.value)}
              placeholder="לדוג׳ 12000"
              className="w-32 border border-gray-300 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400"
            />
          </div>
        </div>

        {monthlyGoal > 0 && (
          <div className="flex-1 min-w-0">
            <div className="flex items-center justify-between text-xs text-gray-400 mb-1">
              <span>ניצול יעד חודשי</span>
              <span>{monthlyGoal > 0 ? Math.round((totalSpentMonth / monthlyGoal) * 100) : 0}%</span>
            </div>
            <div className="w-full bg-gray-100 rounded-full h-2">
              <div
                className={`h-2 rounded-full transition-all ${
                  totalSpentMonth / monthlyGoal > 0.9 ? 'bg-red-500' :
                  totalSpentMonth / monthlyGoal > 0.7 ? 'bg-orange-400' : 'bg-green-500'
                }`}
                style={{ width: `${Math.min(100, (totalSpentMonth / monthlyGoal) * 100)}%` }}
              />
            </div>
          </div>
        )}
      </div>

      {/* ── 3 Big summary cards ────────────────────────────────── */}
      {transactions.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <BigCard
            label={`נותר להוצאות החודש · ${daysRemaining} ימים`}
            value={remainingMonth}
            sub={monthlyGoal > 0 ? `מתוך יעד ${fmt(monthlyGoal)}` : 'הגדר יעד חודשי למעלה'}
          />
          <BigCard
            label={`נותר להוצאות השבוע · ${daysRemainingWeek} ימים נותרו`}
            value={remainingWeek}
            sub={weeklyBudget > 0 ? `תקציב שבועי ${fmt(weeklyBudget)} · הוצאת ${fmt(weekSpent)}` : 'הגדר יעד חודשי'}
          />
          <BigCard
            label="צפי יתרה לסוף חודש"
            value={projectedBalance}
            sub={cashBalance > 0
              ? `שריפה יומית: ${fmt(dailyBurn)} · צפי הוצ׳ נוספות: ${fmt(projectedSpend)}`
              : 'הזן יתרה נוכחית לחישוב'}
          />
        </div>
      )}

      {/* ── 4 Bucket breakdown ─────────────────────────────────── */}
      {transactions.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-3">
          <BucketCard
            title="הכנסות"
            icon="💰"
            total={totalIncome}
            transactions={incomeTxs}
            colorClass="text-green-600"
          />
          <BucketCard
            title="הוצאות קבועות"
            icon="🏠"
            total={totalFixed}
            transactions={fixedTxs}
            colorClass="text-blue-600"
          />
          <BucketCard
            title="סופרמרקט"
            icon="🛒"
            total={totalGrocery}
            transactions={groceryTxs}
            colorClass="text-orange-500"
          />
          <BucketCard
            title="הוצאות משתנות"
            icon="📊"
            total={totalVariable}
            transactions={variableTxs}
            colorClass="text-red-500"
          />
        </div>
      )}

      {/* ── Weekly breakdown ────────────────────────────────────── */}
      {currentMonthTxs.length > 0 && <WeeklyList transactions={currentMonthTxs} />}

      {/* ── Categorization ─────────────────────────────────────── */}
      {transactions.length > 0 && (
        <div className="space-y-3">
          <h2 className="text-sm font-bold text-gray-500 uppercase tracking-wide px-1">🏷️ סיווג פעולות</h2>
          <CategorizationTab
            transactions={transactions}
            onCategoryUpdate={onCategoryUpdate}
            onCategorizeAll={onCategorizeAll}
            categorizing={categorizing}
            categorizeError={categorizeError}
          />
        </div>
      )}

      {/* ── Upload ─────────────────────────────────────────────── */}
      <DualFileUpload onTransactionsLoaded={onTransactionsLoaded} />
    </div>
  );
};

export default CashflowTab;
