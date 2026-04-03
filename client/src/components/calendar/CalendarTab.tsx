import { type FC, useMemo, useState } from 'react';
import type { Transaction } from '../../types';
import { CATEGORY_LABELS } from '../categorization/CategorizationTab';

interface CalendarTabProps {
  transactions: Transaction[];
}

const fmt = (v: number) =>
  new Intl.NumberFormat('he-IL', { style: 'currency', currency: 'ILS', maximumFractionDigits: 0 }).format(v);

const HEBREW_DAYS = ['א׳', 'ב׳', 'ג׳', 'ד׳', 'ה׳', 'ו׳', 'ש׳'];
const HEBREW_MONTHS = [
  'ינואר', 'פברואר', 'מרץ', 'אפריל', 'מאי', 'יוני',
  'יולי', 'אוגוסט', 'ספטמבר', 'אוקטובר', 'נובמבר', 'דצמבר',
];

// ---- Similarity search ----
const tokenize = (s: string): string[] => {
  return s
    .toLowerCase()
    .replace(/[^\u05d0-\u05eaa-z0-9 ]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 2);
};

const findSimilar = (target: Transaction, all: Transaction[]): Transaction[] => {
  const targetTokens = new Set(tokenize(target.description));
  if (targetTokens.size === 0) return [];

  return all
    .filter((tx) => tx.id !== target.id)
    .map((tx) => {
      const hits = tokenize(tx.description).filter((t) => targetTokens.has(t)).length;
      return { tx, hits };
    })
    .filter(({ hits }) => hits > 0)
    .sort((a, b) => b.hits - a.hits || b.tx.amount - a.tx.amount)
    .map(({ tx }) => tx);
};

// ---- Day cell ----
interface DayData {
  date: string; // YYYY-MM-DD
  income: number;
  expenses: number;
  count: number;
}

const DayCell: FC<{
  day: number | null;
  data: DayData | null;
  isToday: boolean;
  isSelected: boolean;
  onClick: () => void;
}> = ({ day, data, isToday, isSelected, onClick }) => {
  if (day === null) {
    return <div className="h-20 bg-gray-50 rounded-lg" />;
  }

  const hasActivity = data && data.count > 0;

  return (
    <button
      onClick={onClick}
      className={`h-20 rounded-lg p-2 text-right flex flex-col transition-all border ${
        isSelected
          ? 'border-blue-500 bg-blue-50 shadow-md'
          : isToday
          ? 'border-blue-200 bg-blue-50'
          : hasActivity
          ? 'border-gray-200 bg-white hover:border-blue-300 hover:bg-blue-50'
          : 'border-transparent bg-gray-50 hover:bg-gray-100'
      }`}
    >
      <span className={`text-sm font-semibold leading-none ${isToday ? 'text-blue-600' : 'text-gray-700'}`}>
        {day}
      </span>
      {hasActivity && (
        <div className="mt-auto space-y-0.5 w-full">
          {data!.income > 0 && (
            <div className="text-right text-xs font-medium text-green-600 truncate">
              +{fmt(data!.income)}
            </div>
          )}
          {data!.expenses > 0 && (
            <div className="text-right text-xs font-medium text-red-500 truncate">
              -{fmt(data!.expenses)}
            </div>
          )}
        </div>
      )}
    </button>
  );
};

// ---- Similar panel ----
const SimilarPanel: FC<{
  target: Transaction;
  similar: Transaction[];
  onClose: () => void;
}> = ({ target, similar, onClose }) => (
  <div className="bg-white rounded-xl border-2 border-purple-300 p-5 space-y-4">
    <div className="flex items-start justify-between gap-3">
      <div className="flex-1 min-w-0">
        <p className="text-xs text-purple-500 font-medium mb-1">תנועות דומות ל:</p>
        <p className="font-semibold text-gray-800 truncate">{target.description}</p>
        <p className="text-xs text-gray-400 mt-0.5">{target.date} · {fmt(target.amount)}</p>
      </div>
      <button onClick={onClose} className="text-gray-400 hover:text-gray-700 text-xl leading-none shrink-0">✕</button>
    </div>

    {similar.length === 0 ? (
      <p className="text-sm text-gray-400 text-center py-4">לא נמצאו תנועות דומות</p>
    ) : (
      <>
        <p className="text-xs text-gray-500">{similar.length} תנועות דומות נמצאו:</p>
        <div className="max-h-64 overflow-y-auto divide-y divide-gray-100 rounded-lg border border-gray-100">
          {similar.map((tx) => (
            <div key={tx.id} className="flex items-center gap-3 px-4 py-3 hover:bg-gray-50">
              <span className="text-xs text-gray-400 w-24 shrink-0">{tx.date}</span>
              <span className="text-sm text-gray-700 flex-1 truncate">{tx.description}</span>
              {tx.category && (
                <span className="text-xs bg-gray-100 text-gray-500 px-2 py-0.5 rounded shrink-0">
                  {CATEGORY_LABELS[tx.category] ?? tx.category}
                </span>
              )}
              <span className={`text-sm font-semibold shrink-0 ${tx.isDebit ? 'text-red-500' : 'text-green-600'}`}>
                {tx.isDebit ? '-' : '+'}{fmt(tx.amount)}
              </span>
            </div>
          ))}
        </div>
        <div className="bg-gray-50 rounded-lg px-4 py-2 flex justify-between text-xs text-gray-500">
          <span>סה"כ הוצאות: <strong className="text-red-500">{fmt(similar.filter(t => t.isDebit).reduce((s, t) => s + t.amount, 0))}</strong></span>
          <span>סה"כ הכנסות: <strong className="text-green-600">{fmt(similar.filter(t => !t.isDebit).reduce((s, t) => s + t.amount, 0))}</strong></span>
        </div>
      </>
    )}
  </div>
);

// ---- Day detail panel ----
const DayDetail: FC<{
  date: string;
  transactions: Transaction[];
  allTransactions: Transaction[];
  onClose: () => void;
  onSearchSimilar: (tx: Transaction) => void;
}> = ({ date, transactions, onClose, onSearchSimilar }) => {
  const income = transactions.filter((t) => !t.isDebit);
  const expenses = transactions.filter((t) => t.isDebit);
  const totalIn = income.reduce((s, t) => s + t.amount, 0);
  const totalOut = expenses.reduce((s, t) => s + t.amount, 0);

  const [d, m, y] = date.split('-').reverse();
  const displayDate = `${d}/${m}/${y}`;

  const TxRow = ({ tx }: { tx: Transaction }) => (
    <div className="flex items-center gap-3 px-4 py-3 hover:bg-gray-50 group">
      <span className={`text-xs px-1.5 py-0.5 rounded shrink-0 ${tx.source === 'credit_card' ? 'bg-purple-50 text-purple-500' : 'bg-gray-100 text-gray-400'}`}>
        {tx.source === 'credit_card' ? 'ויזה' : 'עו"ש'}
      </span>
      <span className="text-sm text-gray-800 flex-1 truncate">{tx.description}</span>
      {tx.category && (
        <span className="text-xs bg-gray-100 text-gray-500 px-2 py-0.5 rounded shrink-0 hidden group-hover:inline">
          {CATEGORY_LABELS[tx.category] ?? tx.category}
        </span>
      )}
      <span className={`text-sm font-semibold shrink-0 ${tx.isDebit ? 'text-red-500' : 'text-green-600'}`}>
        {tx.isDebit ? '-' : '+'}{fmt(tx.amount)}
      </span>
      <button
        onClick={() => onSearchSimilar(tx)}
        className="shrink-0 text-xs text-purple-500 hover:text-purple-700 border border-purple-200 hover:border-purple-400 rounded px-2 py-1 transition-colors whitespace-nowrap"
        title="חפש תנועות דומות"
      >
        🔍 דומות
      </button>
    </div>
  );

  return (
    <div className="bg-white rounded-xl border-2 border-blue-300 p-5 space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-base font-bold text-gray-800">📅 {displayDate}</h3>
        <div className="flex items-center gap-4">
          {totalIn > 0 && <span className="text-sm font-semibold text-green-600">+{fmt(totalIn)}</span>}
          {totalOut > 0 && <span className="text-sm font-semibold text-red-500">-{fmt(totalOut)}</span>}
          <button onClick={onClose} className="text-gray-400 hover:text-gray-700 text-xl leading-none">✕</button>
        </div>
      </div>

      <div className="rounded-lg border border-gray-100 divide-y divide-gray-50 overflow-hidden">
        {income.length > 0 && (
          <>
            <div className="px-4 py-2 bg-green-50">
              <span className="text-xs font-semibold text-green-700">הכנסות ({income.length})</span>
            </div>
            {income.map((tx) => <TxRow key={tx.id} tx={tx} />)}
          </>
        )}
        {expenses.length > 0 && (
          <>
            <div className="px-4 py-2 bg-red-50">
              <span className="text-xs font-semibold text-red-700">הוצאות ({expenses.length})</span>
            </div>
            {[...expenses].sort((a, b) => b.amount - a.amount).map((tx) => <TxRow key={tx.id} tx={tx} />)}
          </>
        )}
      </div>
    </div>
  );
};

// ---- Main CalendarTab ----
const CalendarTab: FC<CalendarTabProps> = ({ transactions }) => {
  const today = new Date();
  const [viewYear, setViewYear] = useState(today.getFullYear());
  const [viewMonth, setViewMonth] = useState(today.getMonth()); // 0-indexed
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [similarTarget, setSimilarTarget] = useState<Transaction | null>(null);

  // Index transactions by date
  const byDate = useMemo(() => {
    const map = new Map<string, Transaction[]>();
    for (const tx of transactions) {
      if (!/^\d{4}-\d{2}-\d{2}/.test(tx.date)) continue;
      if (!map.has(tx.date)) map.set(tx.date, []);
      map.get(tx.date)!.push(tx);
    }
    return map;
  }, [transactions]);

  // Build calendar grid for current month
  const { weeks, dayDataMap } = useMemo(() => {
    const firstDay = new Date(viewYear, viewMonth, 1);
    const lastDay = new Date(viewYear, viewMonth + 1, 0);
    const startDow = firstDay.getDay(); // 0=Sun
    const daysInMonth = lastDay.getDate();

    const dayDataMap = new Map<number, DayData>();
    for (let d = 1; d <= daysInMonth; d++) {
      const dateStr = `${viewYear}-${String(viewMonth + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      const txs = byDate.get(dateStr) ?? [];
      dayDataMap.set(d, {
        date: dateStr,
        income: txs.filter((t) => !t.isDebit).reduce((s, t) => s + t.amount, 0),
        expenses: txs.filter((t) => t.isDebit).reduce((s, t) => s + t.amount, 0),
        count: txs.length,
      });
    }

    // Build 6-week grid (nulls for padding)
    const cells: (number | null)[] = [
      ...Array(startDow).fill(null),
      ...Array.from({ length: daysInMonth }, (_, i) => i + 1),
    ];
    while (cells.length % 7 !== 0) cells.push(null);

    const weeks: (number | null)[][] = [];
    for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));

    return { weeks, dayDataMap };
  }, [viewYear, viewMonth, byDate]);

  const monthTotal = useMemo(() => {
    const prefix = `${viewYear}-${String(viewMonth + 1).padStart(2, '0')}`;
    const monthTxs = transactions.filter((t) => t.date.startsWith(prefix));
    return {
      income: monthTxs.filter((t) => !t.isDebit).reduce((s, t) => s + t.amount, 0),
      expenses: monthTxs.filter((t) => t.isDebit).reduce((s, t) => s + t.amount, 0),
      count: monthTxs.length,
    };
  }, [transactions, viewYear, viewMonth]);

  const selectedTxs = selectedDate ? (byDate.get(selectedDate) ?? []) : [];

  const similarResults = useMemo(
    () => (similarTarget ? findSimilar(similarTarget, transactions) : []),
    [similarTarget, transactions]
  );

  const prevMonth = () => {
    if (viewMonth === 0) { setViewYear((y) => y - 1); setViewMonth(11); }
    else setViewMonth((m) => m - 1);
    setSelectedDate(null); setSimilarTarget(null);
  };

  const nextMonth = () => {
    if (viewMonth === 11) { setViewYear((y) => y + 1); setViewMonth(0); }
    else setViewMonth((m) => m + 1);
    setSelectedDate(null); setSimilarTarget(null);
  };

  const handleDayClick = (day: number) => {
    const dateStr = `${viewYear}-${String(viewMonth + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    const has = byDate.get(dateStr)?.length ?? 0;
    if (!has) return;
    setSelectedDate((prev) => prev === dateStr ? null : dateStr);
    setSimilarTarget(null);
  };

  if (transactions.length === 0) {
    return (
      <div className="bg-blue-50 border border-blue-200 rounded-xl p-8 text-center text-blue-600">
        <p className="text-lg font-medium">📤 טען קובץ בנק בלשונית תזרים מזומנים</p>
        <p className="text-sm mt-1">הלוח שנה יופיע לאחר טעינת הנתונים</p>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {/* Month navigation */}
      <div className="bg-white rounded-xl border border-gray-200 p-5">
        <div className="flex items-center justify-between mb-4">
          <button onClick={prevMonth} className="p-2 hover:bg-gray-100 rounded-lg transition-colors text-gray-600">
            ‹ חודש קודם
          </button>
          <div className="text-center">
            <h2 className="text-lg font-bold text-gray-800">
              {HEBREW_MONTHS[viewMonth]} {viewYear}
            </h2>
            <div className="flex items-center gap-4 justify-center mt-1">
              <span className="text-xs text-green-600 font-medium">+{fmt(monthTotal.income)}</span>
              <span className="text-xs text-red-500 font-medium">-{fmt(monthTotal.expenses)}</span>
              <span className="text-xs text-gray-400">{monthTotal.count} תנועות</span>
            </div>
          </div>
          <button onClick={nextMonth} className="p-2 hover:bg-gray-100 rounded-lg transition-colors text-gray-600">
            חודש הבא ›
          </button>
        </div>

        {/* Day headers */}
        <div className="grid grid-cols-7 gap-1 mb-1">
          {HEBREW_DAYS.map((d) => (
            <div key={d} className="text-center text-xs font-semibold text-gray-400 py-1">{d}</div>
          ))}
        </div>

        {/* Calendar grid */}
        <div className="space-y-1">
          {weeks.map((week, wi) => (
            <div key={wi} className="grid grid-cols-7 gap-1">
              {week.map((day, di) => {
                const data = day ? dayDataMap.get(day) ?? null : null;
                const dateStr = day
                  ? `${viewYear}-${String(viewMonth + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`
                  : null;
                const isToday = !!(day && today.getFullYear() === viewYear && today.getMonth() === viewMonth && today.getDate() === day);
                const isSelected = dateStr === selectedDate;
                return (
                  <DayCell
                    key={di}
                    day={day}
                    data={data}
                    isToday={isToday}
                    isSelected={isSelected}
                    onClick={() => day && handleDayClick(day)}
                  />
                );
              })}
            </div>
          ))}
        </div>

        {/* Legend */}
        <div className="flex items-center gap-4 mt-3 justify-center text-xs text-gray-400">
          <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-green-400 inline-block" /> הכנסה</span>
          <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-red-400 inline-block" /> הוצאה</span>
          <span>לחץ על יום עם תנועות לפירוט</span>
        </div>
      </div>

      {/* Day detail panel */}
      {selectedDate && selectedTxs.length > 0 && (
        <DayDetail
          date={selectedDate}
          transactions={selectedTxs}
          allTransactions={transactions}
          onClose={() => { setSelectedDate(null); setSimilarTarget(null); }}
          onSearchSimilar={(tx) => setSimilarTarget((prev) => prev?.id === tx.id ? null : tx)}
        />
      )}

      {/* Similar transactions panel */}
      {similarTarget && (
        <SimilarPanel
          target={similarTarget}
          similar={similarResults}
          onClose={() => setSimilarTarget(null)}
        />
      )}
    </div>
  );
};

export default CalendarTab;
