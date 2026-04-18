import { type FC, useMemo } from 'react';
import type { Portfolio } from '../../types';

// ── Formatters ─────────────────────────────────────────────────────────────────
const fILS = (v: number) =>
  new Intl.NumberFormat('he-IL', { style: 'currency', currency: 'ILS', maximumFractionDigits: 0 }).format(v);

const fPct = (v: number) => `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`;

const USD_TO_ILS = 3.73;
const toILS = (value: number, currency: 'ILS' | 'USD') =>
  currency === 'USD' ? value * USD_TO_ILS : value;

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

  const summary = useMemo(() => {
    const realEstateAssets = portfolio.assets.filter(a => a.type === 'real_estate');
    const savingsAssets    = portfolio.assets.filter(a => a.type === 'savings');

    // Real estate: gross value and equity (value minus all outstanding loans)
    const realEstateValueILS = realEstateAssets.reduce(
      (s, a) => s + toILS(a.value, a.currency), 0
    );
    const totalLoansILS = portfolio.loans.reduce(
      (s, l) => s + toILS(l.outstanding, l.currency), 0
    );
    const realEstateEquityILS = realEstateValueILS - totalLoansILS;

    // Savings (pension, keren hishtalmut, etc.)
    const savingsValueILS = savingsAssets.reduce(
      (s, a) => s + toILS(a.value, a.currency), 0
    );

    // Total gross assets (everything we own)
    const totalAssetsILS = realEstateValueILS + savingsValueILS + stockPortfolioILS;

    // Net worth = assets minus liabilities
    const netWorthILS = realEstateEquityILS + savingsValueILS + stockPortfolioILS;

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
  }, [portfolio, stockPortfolioILS]);

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
          ].filter(Boolean).join(' · ')}
          color="text-gray-900"
          bg="bg-gray-50"
        />
      </div>

      {/* ── Breakdown row ── */}
      {(summary.realEstateValueILS > 0 || hasStockData || summary.savingsValueILS > 0) && (
        <div className="bg-white rounded-2xl border border-gray-200 p-5">
          <p className="text-sm font-semibold text-gray-700 mb-4">פירוט שווי נכסים</p>
          <div className="space-y-3">

            {summary.realEstateValueILS > 0 && (
              <div className="flex items-center gap-3">
                <span className="w-24 text-xs text-gray-500 shrink-0">נדל"ן</span>
                <div className="flex-1 bg-gray-100 rounded-full h-3 overflow-hidden">
                  <div
                    className="bg-blue-500 h-full rounded-full"
                    style={{ width: `${summary.totalAssetsILS > 0 ? (summary.realEstateValueILS / summary.totalAssetsILS) * 100 : 0}%` }}
                  />
                </div>
                <span className="text-xs font-semibold text-gray-700 w-28 text-left shrink-0">
                  {fILS(summary.realEstateValueILS)}
                  <span className="text-gray-400 font-normal mr-1">
                    ({summary.totalAssetsILS > 0 ? ((summary.realEstateValueILS / summary.totalAssetsILS) * 100).toFixed(0) : 0}%)
                  </span>
                </span>
              </div>
            )}

            {hasStockData && (
              <div className="flex items-center gap-3">
                <span className="w-24 text-xs text-gray-500 shrink-0">שוק ההון</span>
                <div className="flex-1 bg-gray-100 rounded-full h-3 overflow-hidden">
                  <div
                    className="bg-indigo-500 h-full rounded-full"
                    style={{ width: `${summary.totalAssetsILS > 0 ? (stockPortfolioILS / summary.totalAssetsILS) * 100 : 0}%` }}
                  />
                </div>
                <span className="text-xs font-semibold text-gray-700 w-28 text-left shrink-0">
                  {fILS(stockPortfolioILS)}
                  <span className="text-gray-400 font-normal mr-1">
                    ({summary.totalAssetsILS > 0 ? ((stockPortfolioILS / summary.totalAssetsILS) * 100).toFixed(0) : 0}%)
                  </span>
                </span>
              </div>
            )}

            {summary.savingsValueILS > 0 && (
              <div className="flex items-center gap-3">
                <span className="w-24 text-xs text-gray-500 shrink-0">חסכונות</span>
                <div className="flex-1 bg-gray-100 rounded-full h-3 overflow-hidden">
                  <div
                    className="bg-green-500 h-full rounded-full"
                    style={{ width: `${summary.totalAssetsILS > 0 ? (summary.savingsValueILS / summary.totalAssetsILS) * 100 : 0}%` }}
                  />
                </div>
                <span className="text-xs font-semibold text-gray-700 w-28 text-left shrink-0">
                  {fILS(summary.savingsValueILS)}
                  <span className="text-gray-400 font-normal mr-1">
                    ({summary.totalAssetsILS > 0 ? ((summary.savingsValueILS / summary.totalAssetsILS) * 100).toFixed(0) : 0}%)
                  </span>
                </span>
              </div>
            )}

            {summary.totalLoansILS > 0 && (
              <div className="flex items-center gap-3 pt-2 border-t border-gray-100">
                <span className="w-24 text-xs text-red-400 shrink-0">התחייבויות</span>
                <div className="flex-1 bg-gray-100 rounded-full h-3 overflow-hidden">
                  <div
                    className="bg-red-400 h-full rounded-full"
                    style={{ width: `${summary.totalAssetsILS > 0 ? Math.min(100, (summary.totalLoansILS / summary.totalAssetsILS) * 100) : 0}%` }}
                  />
                </div>
                <span className="text-xs font-semibold text-red-500 w-28 text-left shrink-0">
                  -{fILS(summary.totalLoansILS)}
                </span>
              </div>
            )}
          </div>

          {/* Net worth summary line */}
          <div className="mt-4 pt-3 border-t border-gray-100 flex items-center justify-between">
            <span className="text-sm text-gray-500">שווי נקי (נכסים פחות התחייבויות)</span>
            <span className={`text-lg font-bold ${summary.netWorthILS >= 0 ? 'text-gray-900' : 'text-red-600'}`}>
              {fILS(summary.netWorthILS)}
            </span>
          </div>
        </div>
      )}

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
