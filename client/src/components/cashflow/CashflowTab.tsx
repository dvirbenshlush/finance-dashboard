import { type FC, useMemo, useState, useRef, useEffect } from 'react';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  Legend, ResponsiveContainer, Cell,
} from 'recharts';
import type { MonthlyData, Transaction } from '../../types';
import { CATEGORY_LABELS } from '../categorization/CategorizationTab';
import DualFileUpload from '../upload/DualFileUpload';

interface CashflowTabProps {
  transactions: Transaction[];
  onTransactionsLoaded: (txs: Transaction[]) => void;
}

const fmt = (v: number) =>
  new Intl.NumberFormat('he-IL', { style: 'currency', currency: 'ILS', maximumFractionDigits: 0 }).format(v);

// ---- Month detail panel ----
const MonthDetail: FC<{
  monthKey: string; label: string; transactions: Transaction[]; onClose: () => void;
}> = ({ monthKey, label, transactions, onClose }) => {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { ref.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }); }, []);

  const monthTxs = transactions.filter((tx) => tx.date.startsWith(monthKey));
  const income = monthTxs.filter((t) => !t.isDebit);
  const expenses = monthTxs.filter((t) => t.isDebit);
  const totalIn = income.reduce((s, t) => s + t.amount, 0);
  const totalOut = expenses.reduce((s, t) => s + t.amount, 0);

  const byCategory = expenses.reduce<Record<string, number>>((acc, tx) => {
    const cat = tx.category ?? 'other';
    acc[cat] = (acc[cat] ?? 0) + tx.amount;
    return acc;
  }, {});
  const categoryList = Object.entries(byCategory).sort(([, a], [, b]) => b - a);

  return (
    <div ref={ref} className="bg-white rounded-xl border-2 border-blue-400 p-6 space-y-5">
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-bold text-gray-800">📅 פירוט חודש: {label}</h3>
        <button onClick={onClose} className="text-gray-400 hover:text-gray-700 text-xl font-bold leading-none">✕</button>
      </div>

      <div className="grid grid-cols-3 gap-3">
        <div className="bg-green-50 rounded-lg p-3 text-center">
          <p className="text-xs text-green-600">הכנסות</p>
          <p className="text-lg font-bold text-green-700">{fmt(totalIn)}</p>
          <p className="text-xs text-green-500">{income.length} פעולות</p>
        </div>
        <div className="bg-red-50 rounded-lg p-3 text-center">
          <p className="text-xs text-red-600">הוצאות</p>
          <p className="text-lg font-bold text-red-600">{fmt(totalOut)}</p>
          <p className="text-xs text-red-400">{expenses.length} פעולות</p>
        </div>
        <div className={`rounded-lg p-3 text-center ${totalIn - totalOut >= 0 ? 'bg-blue-50' : 'bg-orange-50'}`}>
          <p className="text-xs text-gray-500">יתרה</p>
          <p className={`text-lg font-bold ${totalIn - totalOut >= 0 ? 'text-blue-700' : 'text-orange-600'}`}>
            {fmt(totalIn - totalOut)}
          </p>
        </div>
      </div>

      {categoryList.length > 0 && (
        <div>
          <p className="text-sm font-semibold text-gray-700 mb-2">פילוח הוצאות</p>
          <div className="space-y-2">
            {categoryList.map(([cat, total]) => (
              <div key={cat} className="flex items-center gap-2">
                <span className="text-xs text-gray-600 w-36 truncate">
                  {CATEGORY_LABELS[cat] ?? cat}
                </span>
                <div className="flex-1 bg-gray-100 rounded-full h-2">
                  <div className="bg-blue-500 h-2 rounded-full"
                    style={{ width: `${Math.min(100, (total / totalOut) * 100)}%` }} />
                </div>
                <span className="text-xs font-medium text-gray-700 w-20 text-left">{fmt(total)}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div>
        <p className="text-sm font-semibold text-gray-700 mb-2">הוצאות ({expenses.length})</p>
        <div className="max-h-64 overflow-y-auto rounded-lg border border-gray-100 divide-y divide-gray-50">
          {[...expenses].sort((a, b) => b.amount - a.amount).map((tx) => (
            <div key={tx.id} className="flex items-center gap-3 px-3 py-2 hover:bg-gray-50">
              <span className="text-xs text-gray-400 w-20 shrink-0">{tx.date.slice(5)}</span>
              <span className={`text-xs px-1.5 py-0.5 rounded shrink-0 ${tx.source === 'credit_card' ? 'bg-purple-50 text-purple-600' : 'bg-gray-100 text-gray-500'}`}>
                {tx.source === 'credit_card' ? 'ויזה' : 'חשבון'}
              </span>
              <span className="text-xs text-gray-700 flex-1 truncate">{tx.description}</span>
              <span className="text-xs font-semibold text-red-500 shrink-0">-{fmt(tx.amount)}</span>
            </div>
          ))}
        </div>
      </div>

      {income.length > 0 && (
        <div>
          <p className="text-sm font-semibold text-gray-700 mb-2">הכנסות ({income.length})</p>
          <div className="max-h-40 overflow-y-auto rounded-lg border border-gray-100 divide-y divide-gray-50">
            {[...income].sort((a, b) => b.amount - a.amount).map((tx) => (
              <div key={tx.id} className="flex items-center gap-3 px-3 py-2 hover:bg-gray-50">
                <span className="text-xs text-gray-400 w-20 shrink-0">{tx.date.slice(5)}</span>
                <span className="text-xs text-gray-700 flex-1 truncate">{tx.description}</span>
                <span className="text-xs font-semibold text-green-600 shrink-0">+{fmt(tx.amount)}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

// ---- Main tab ----
const CashflowTab: FC<CashflowTabProps> = ({ transactions, onTransactionsLoaded }) => {
  const [selectedMonthKey, setSelectedMonthKey] = useState<string | null>(null);

  const { monthlyData, validCount, invalidCount } = useMemo(() => {
    const map = new Map<string, { income: number; expenses: number }>();
    let valid = 0, invalid = 0;

    for (const tx of transactions) {
      if (!/^\d{4}-\d{2}-\d{2}/.test(tx.date)) { invalid++; continue; }
      valid++;
      const key = tx.date.slice(0, 7);
      if (!map.has(key)) map.set(key, { income: 0, expenses: 0 });
      const e = map.get(key)!;
      if (tx.isDebit) e.expenses += tx.amount; else e.income += tx.amount;
    }

    const HM = ['', 'ינו', 'פבר', 'מרץ', 'אפר', 'מאי', 'יוני', 'יולי', 'אוג', 'ספט', 'אוק', 'נוב', 'דצמ'];
    const data: MonthlyData[] = Array.from(map.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, { income, expenses }]) => {
        const [y, m] = key.split('-');
        return { month: `${HM[parseInt(m)] ?? m} ${y}`, monthKey: key, income, expenses, balance: income - expenses };
      });

    return { monthlyData: data, validCount: valid, invalidCount: invalid };
  }, [transactions]);

  const totalIncome = monthlyData.reduce((s, m) => s + m.income, 0);
  const totalExpenses = monthlyData.reduce((s, m) => s + m.expenses, 0);
  const avgBurn = monthlyData.length > 0 ? totalExpenses / monthlyData.length : 0;
  const selectedEntry = selectedMonthKey ? monthlyData.find((m) => m.monthKey === selectedMonthKey) ?? null : null;

  const handleBarClick = (data: MonthlyData) =>
    setSelectedMonthKey((prev) => prev === data.monthKey ? null : data.monthKey);

  return (
    <div className="space-y-6">
      {/* KPI cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Kpi label='סה"כ הכנסות' value={fmt(totalIncome)} color="text-green-600" />
        <Kpi label='סה"כ הוצאות' value={fmt(totalExpenses)} color="text-red-500" />
        <Kpi label="שריפה חודשית ממוצעת" value={fmt(avgBurn)} color="text-orange-500" />
      </div>

      {/* Date parse warning */}
      {transactions.length > 0 && invalidCount > 0 && (
        <div className="bg-orange-50 border border-orange-200 rounded-xl px-4 py-3 text-sm text-orange-700">
          ⚠️ {validCount} תנועות תקינות | {invalidCount} תנועות עם תאריך לא מזוהה (מסוננות מהגרפים).
          <br /><span className="text-xs">ייצא מהבנק כ-Excel (.xlsx) ולא PDF — ובדוק בתצוגה המקדימה שהתאריך בפורמט DD/MM/YYYY.</span>
        </div>
      )}

      {/* Charts */}
      {monthlyData.length > 0 ? (
        <>
          <div className="bg-white rounded-xl border border-gray-200 p-6">
            <h3 className="text-base font-semibold text-gray-700 mb-1">הכנסות מול הוצאות לפי חודש</h3>
            <p className="text-xs text-gray-400 mb-4">לחץ על עמודה לפירוט מלא של אותו חודש</p>
            <ResponsiveContainer width="100%" height={280}>
              <BarChart
                data={monthlyData}
                onClick={(p) => p?.activePayload && handleBarClick(p.activePayload[0].payload as MonthlyData)}
              >
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="month" tick={{ fontSize: 11 }} />
                <YAxis tickFormatter={(v) => `₪${(v / 1000).toFixed(0)}k`} tick={{ fontSize: 11 }} />
                <Tooltip formatter={(v: number) => fmt(v)} contentStyle={{ direction: 'rtl', borderRadius: 8 }} cursor={{ fill: 'rgba(59,130,246,0.07)' }} />
                <Legend />
                <Bar dataKey="income" name="הכנסות" radius={[4, 4, 0, 0]}>
                  {monthlyData.map((e) => <Cell key={e.monthKey} fill={e.monthKey === selectedMonthKey ? '#16a34a' : '#22c55e'} />)}
                </Bar>
                <Bar dataKey="expenses" name="הוצאות" radius={[4, 4, 0, 0]}>
                  {monthlyData.map((e) => <Cell key={e.monthKey} fill={e.monthKey === selectedMonthKey ? '#dc2626' : '#ef4444'} />)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>

        </>
      ) : (
        <div className="bg-blue-50 border border-blue-200 rounded-xl p-6 text-center text-blue-600">
          <p className="text-lg">📤 טען קובץ מהבנק כדי לראות את הגרפים</p>
        </div>
      )}

      {/* Month detail panel */}
      {selectedEntry && (
        <MonthDetail
          monthKey={selectedEntry.monthKey}
          label={selectedEntry.month}
          transactions={transactions}
          onClose={() => setSelectedMonthKey(null)}
        />
      )}

      {/* Dual upload */}
      <DualFileUpload onTransactionsLoaded={onTransactionsLoaded} />
    </div>
  );
};

const Kpi: FC<{ label: string; value: string; color: string }> = ({ label, value, color }) => (
  <div className="bg-white rounded-xl border border-gray-200 p-5">
    <p className="text-sm text-gray-500">{label}</p>
    <p className={`text-2xl font-bold mt-1 ${color}`}>{value}</p>
  </div>
);

export default CashflowTab;
