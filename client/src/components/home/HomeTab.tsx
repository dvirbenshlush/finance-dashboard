import { type FC, useMemo, useState, useEffect } from 'react';
import type { Portfolio } from '../../types';

// ── Formatters ─────────────────────────────────────────────────────────────────
const fILS = (v: number) =>
  new Intl.NumberFormat('he-IL', { style: 'currency', currency: 'ILS', maximumFractionDigits: 0 }).format(v);

const fUSD = (v: number) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(v);

const FALLBACK_RATE = 3.73; // used only until live rate loads
const toILS = (value: number, currency: 'ILS' | 'USD', rate: number) =>
  currency === 'USD' ? value * rate : value;

const BASE = (import.meta.env.VITE_API_URL ?? 'http://localhost:3001') + '/api';

// ── Sub-components ─────────────────────────────────────────────────────────────
const KPI: FC<{
  label: string;
  value: string;
  sub?: string;
  sub2?: string;
  color?: string;
  bg?: string;
  icon?: string;
  onClick?: () => void;
}> = ({ label, value, sub, sub2, color = 'text-gray-900', bg = 'bg-white', icon, onClick }) => (
  <div
    onClick={onClick}
    className={`${bg} rounded-2xl border border-gray-200 p-6 shadow-sm ${onClick ? 'cursor-pointer hover:shadow-md transition-shadow' : ''}`}
  >
    {icon && <div className="text-2xl mb-3">{icon}</div>}
    <p className="text-xs text-gray-500 mb-1 font-medium">{label}</p>
    <p className={`text-2xl font-bold ${color}`}>{value}</p>
    {sub  && <p className="text-xs text-gray-400 mt-1">{sub}</p>}
    {sub2 && <p className="text-xs text-gray-400">{sub2}</p>}
  </div>
);

// ── Props ──────────────────────────────────────────────────────────────────────
interface HomeTabProps {
  portfolio: Portfolio;
  stockPortfolioILS: number;
  onNavigate: (tab: string) => void;
}

// ── Main component ─────────────────────────────────────────────────────────────
const HomeTab: FC<HomeTabProps> = ({ portfolio, stockPortfolioILS, onNavigate }) => {

  // Live forex rate — fetched from server on mount
  const [forexRate, setForexRate] = useState<number>(FALLBACK_RATE);
  const [forexLoading, setForexLoading] = useState(true);
  useEffect(() => {
    const today = new Date().toISOString().slice(0, 10);
    const token = localStorage.getItem('otzar_token') ?? '';
    fetch(`${BASE}/portfolio/forex-rates?from=${today}&to=${today}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then(r => r.json())
      .then((data: Record<string, number>) => {
        const rate = data[today] ?? Object.values(data).at(-1);
        if (rate && rate > 0) setForexRate(rate);
      })
      .catch(() => {/* keep fallback */})
      .finally(() => setForexLoading(false));
  }, []);

  // Bank account balances entered manually in the cashflow tab
  const bankBalanceILS = useMemo(() => {
    const raw = localStorage.getItem('otzar_bank_balance');
    return raw ? parseFloat(raw) || 0 : 0;
  }, []);
  const bankBalanceUSD = useMemo(() => {
    const raw = localStorage.getItem('otzar_bank_balance_usd');
    return raw ? parseFloat(raw) || 0 : 0;
  }, []);
  const bankBalanceUSDinILS = bankBalanceUSD * forexRate;
  const totalBankILS = bankBalanceILS + bankBalanceUSDinILS;

  const summary = useMemo(() => {
    const realEstateAssets = portfolio.assets.filter(a => a.type === 'real_estate');
    const savingsAssets    = portfolio.assets.filter(a => a.type === 'savings');

    // Real estate: gross value and equity (value minus all outstanding loans)
    const realEstateValueILS = realEstateAssets.reduce(
      (s, a) => s + toILS(a.value, a.currency, forexRate), 0
    );
    const totalLoansILS = portfolio.loans.reduce(
      (s, l) => s + toILS(l.outstanding, l.currency, forexRate), 0
    );
    const realEstateEquityILS = realEstateValueILS - totalLoansILS;

    // Savings (pension, keren hishtalmut, etc.)
    const savingsValueILS = savingsAssets.reduce(
      (s, a) => s + toILS(a.value, a.currency, forexRate), 0
    );

    // Total gross assets (everything we own)
    const totalAssetsILS = realEstateValueILS + savingsValueILS + stockPortfolioILS + totalBankILS;

    // Net worth = assets minus liabilities
    const netWorthILS = realEstateEquityILS + savingsValueILS + stockPortfolioILS + totalBankILS;

    // LTV across all real estate
    const ltvPct = realEstateValueILS > 0
      ? (totalLoansILS / realEstateValueILS) * 100
      : 0;

    return {
      realEstateValueILS,
      realEstateEquityILS,
      totalLoansILS,
      savingsValueILS,
      totalAssetsILS,
      netWorthILS,
      ltvPct,
    };
  }, [portfolio, stockPortfolioILS, totalBankILS, forexRate]);

  const hasStockData = stockPortfolioILS > 0;

  return (
    <div className="space-y-6" dir="rtl">

      {/* ── Hero net worth banner ── */}
      <div className="bg-gradient-to-l from-slate-800 to-blue-900 rounded-2xl p-7 text-white">
        <p className="text-blue-200 text-sm mb-1 font-medium">שווי נקי כולל</p>
        <p className="text-5xl font-bold mb-1">{fILS(summary.netWorthILS)}</p>
        <p className="text-blue-300 text-xs">
          סה"כ נכסים {fILS(summary.totalAssetsILS)} · התחייבויות {fILS(summary.totalLoansILS)}
          {!hasStockData && <span className="mr-2 opacity-60">(שוק ההון — ממתין לנתונים)</span>}
        </p>
      </div>

      {/* ── 3 main KPIs ── */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">

        {/* 1. Real estate equity */}
        <KPI
          icon="🏠"
          label="הון עצמי בנדל&quot;ן"
          value={fILS(summary.realEstateEquityILS)}
          sub={`שווי נכסים ${fILS(summary.realEstateValueILS)}`}
          sub2={summary.totalLoansILS > 0
            ? `יתרת הלוואות ${fILS(summary.totalLoansILS)} · LTV ${summary.ltvPct.toFixed(0)}%`
            : undefined}
          color={summary.realEstateEquityILS >= 0 ? 'text-blue-700' : 'text-red-600'}
          bg="bg-blue-50"
          onClick={() => onNavigate('assets')}
        />

        {/* 2. Stock portfolio */}
        <KPI
          icon="📈"
          label="שווי תיק שוק ההון"
          value={hasStockData ? fILS(stockPortfolioILS) : '—'}
          sub={hasStockData ? `כולל מזומן פנוי · לפי שערים עדכניים` : 'פתח את טאב שוק ההון לטעינת נתונים'}
          color={hasStockData ? 'text-indigo-700' : 'text-gray-400'}
          bg="bg-indigo-50"
          onClick={() => onNavigate('stock_portfolio')}
        />

        {/* 3. Total current asset value */}
        <KPI
          icon="💼"
          label="שווי נכסים כיום"
          value={fILS(summary.totalAssetsILS)}
          sub={[
            summary.realEstateValueILS > 0 ? `נדל"ן ${fILS(summary.realEstateValueILS)}` : null,
            stockPortfolioILS > 0          ? `שוק ההון ${fILS(stockPortfolioILS)}`       : null,
            summary.savingsValueILS > 0    ? `חסכונות ${fILS(summary.savingsValueILS)}`  : null,
            totalBankILS > 0 ? [
              `עו"ש ${fILS(bankBalanceILS)}`,
              bankBalanceUSD > 0 ? `+ $${bankBalanceUSD.toLocaleString()} (${fILS(bankBalanceUSDinILS)})` : null,
            ].filter(Boolean).join(' ') : null,
          ].filter(Boolean).join(' · ')}
          color="text-gray-900"
          bg="bg-gray-50"
        />
      </div>

      {/* ── Breakdown ── */}
      <div className="bg-white rounded-2xl border border-gray-200 p-5">
        <p className="text-sm font-semibold text-gray-700 mb-4">
          פירוט שווי נכסים
          {forexLoading && <span className="text-gray-300 text-xs font-normal mr-2">טוען שער מטח...</span>}
          {!forexLoading && <span className="text-gray-400 text-xs font-normal mr-2">1$ = ₪{forexRate.toFixed(2)}</span>}
        </p>

        {(() => {
          // Build ordered rows — positive rows for scale, loans shown separately
          const rows: { label: string; color: string; valueILS: number; sub?: string }[] = [];

          if (summary.realEstateValueILS > 0)
            rows.push({ label: '🏠 שווי נכסים', color: 'bg-blue-500', valueILS: summary.realEstateValueILS });

          if (hasStockData)
            rows.push({ label: '📈 שוק ההון', color: 'bg-indigo-500', valueILS: stockPortfolioILS });

          if (bankBalanceILS > 0)
            rows.push({ label: '💵 עו"ש שקלים', color: 'bg-teal-500', valueILS: bankBalanceILS });

          if (bankBalanceUSD > 0)
            rows.push({
              label: '💲 עו"ש דולרים',
              color: 'bg-teal-300',
              valueILS: bankBalanceUSDinILS,
              sub: `${fUSD(bankBalanceUSD)} × ${forexRate.toFixed(2)}`,
            });

          if (summary.savingsValueILS > 0)
            rows.push({ label: '💰 חסכונות', color: 'bg-green-500', valueILS: summary.savingsValueILS });

          const maxPositive = Math.max(...rows.map(r => r.valueILS), 1);

          return (
            <div className="space-y-2.5">
              {rows.map(row => (
                <div key={row.label} className="flex items-center gap-3">
                  <span className="w-32 text-xs text-gray-600 shrink-0">{row.label}</span>
                  <div className="flex-1 bg-gray-100 rounded-full h-2.5 overflow-hidden">
                    <div
                      className={`${row.color} h-full rounded-full transition-all`}
                      style={{ width: `${(row.valueILS / maxPositive) * 100}%` }}
                    />
                  </div>
                  <div className="text-right w-36 shrink-0">
                    <span className="text-xs font-semibold text-gray-800">{fILS(row.valueILS)}</span>
                    {row.sub && <p className="text-xs text-gray-400">{row.sub}</p>}
                  </div>
                </div>
              ))}

              {summary.totalLoansILS > 0 && (
                <div className="flex items-center gap-3 pt-2 border-t border-gray-100 mt-1">
                  <span className="w-32 text-xs text-red-500 shrink-0">🏦 הלוואות לתשלום</span>
                  <div className="flex-1 bg-gray-100 rounded-full h-2.5 overflow-hidden">
                    <div
                      className="bg-red-400 h-full rounded-full"
                      style={{ width: `${Math.min(100, (summary.totalLoansILS / maxPositive) * 100)}%` }}
                    />
                  </div>
                  <div className="text-right w-36 shrink-0">
                    <span className="text-xs font-semibold text-red-500">-{fILS(summary.totalLoansILS)}</span>
                  </div>
                </div>
              )}

              {/* Net worth summary line */}
              <div className="flex items-center justify-between pt-3 border-t border-gray-100 mt-1">
                <span className="text-sm text-gray-500">שווי נקי (נכסים פחות התחייבויות)</span>
                <span className={`text-lg font-bold ${summary.netWorthILS >= 0 ? 'text-gray-900' : 'text-red-600'}`}>
                  {fILS(summary.netWorthILS)}
                </span>
              </div>
            </div>
          );
        })()}
      </div>

      {/* ── Quick nav ── */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {[
          { id: 'cashflow',       icon: '📊', label: 'תזרים מזומנים' },
          { id: 'stock_portfolio',icon: '📈', label: 'שוק ההון'       },
          { id: 'assets',         icon: '🏠', label: 'תיק נכסים'      },
          { id: 'deal',           icon: '🧮', label: 'ניתוח עסקה'     },
        ].map(t => (
          <button
            key={t.id}
            onClick={() => onNavigate(t.id)}
            className="bg-white border border-gray-200 rounded-xl p-4 text-center hover:bg-gray-50 hover:border-blue-300 transition-colors"
          >
            <div className="text-xl mb-1">{t.icon}</div>
            <p className="text-xs font-medium text-gray-600">{t.label}</p>
          </button>
        ))}
      </div>
    </div>
  );
};

export default HomeTab;
