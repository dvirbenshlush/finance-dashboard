import { type FC, useState } from 'react';
import type { Asset, Loan, Portfolio } from '../../types';

const fILS = (v: number) =>
  new Intl.NumberFormat('he-IL', { style: 'currency', currency: 'ILS', maximumFractionDigits: 0 }).format(v);

const USD_TO_ILS = 3.7;
const toILS = (v: number, currency: 'ILS' | 'USD') => (currency === 'USD' ? v * USD_TO_ILS : v);

const DEFAULT_LOANS: Loan[] = [
  { id: 'loan-1', name: 'משכנתא - ראשון לציון', type: 'mortgage',
    principal: 900_000, outstanding: 750_000, interestRate: 4.5,
    currency: 'ILS', monthlyPayment: 4_800, propertyValue: 2_200_000, linkedAssetId: 'asset-1' },
  { id: 'loan-2', name: 'הלוואה - נכס קליבלנד', type: 'mortgage',
    principal: 120_000, outstanding: 100_000, interestRate: 7.0,
    currency: 'USD', monthlyPayment: 800, propertyValue: 180_000, linkedAssetId: 'asset-2' },
];

const ltvBg = (ltv: number) => ltv < 50 ? 'bg-green-100 text-green-700' : ltv < 70 ? 'bg-orange-100 text-orange-700' : 'bg-red-100 text-red-700';

interface LoansTabProps {
  portfolio: Portfolio;
  onPortfolioChange: (p: Portfolio) => void;
}

const LoansTab: FC<LoansTabProps> = ({ portfolio, onPortfolioChange }) => {
  const [loans, setLoans] = useState<Loan[]>(
    portfolio.loans.length > 0 ? portfolio.loans : DEFAULT_LOANS
  );

  const numFields: (keyof Loan)[] = ['outstanding', 'principal', 'interestRate', 'monthlyPayment', 'propertyValue'];

  const updateLoan = (id: string, field: keyof Loan, rawValue: string) => {
    setLoans((prev) => {
      const next = prev.map((l) =>
        l.id === id
          ? { ...l, [field]: numFields.includes(field) ? parseFloat(rawValue) || 0 : rawValue }
          : l
      );
      const totalLiabilitiesILS = next.reduce((s, l) => s + toILS(l.outstanding, l.currency), 0);
      onPortfolioChange({ ...portfolio, loans: next, totalLiabilitiesILS, netWorthILS: portfolio.totalAssetsILS - totalLiabilitiesILS });
      return next;
    });
  };

  const totalMonthly = loans.reduce((s, l) => s + toILS(l.monthlyPayment, l.currency), 0);
  const totalOutstanding = loans.reduce((s, l) => s + toILS(l.outstanding, l.currency), 0);
  const totalPaid = loans.reduce((s, l) => s + toILS(l.principal - l.outstanding, l.currency), 0);

  // Find linked asset to get rental income
  const getLinkedAsset = (loan: Loan): Asset | undefined =>
    portfolio.assets.find((a) => a.id === loan.linkedAssetId);

  const totalMonthlyRent = loans.reduce((s, l) => {
    const asset = getLinkedAsset(l);
    return s + toILS(asset?.monthlyRentalIncome ?? 0, l.currency);
  }, 0);

  const netMonthly = totalMonthlyRent - totalMonthly;

  return (
    <div className="space-y-6">
      {/* Summary */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <SummaryCard label="חוב כולל פתוח" value={fILS(totalOutstanding)} color="text-red-500" />
        <SummaryCard label="שולם עד כה" value={fILS(totalPaid)} color="text-blue-600" />
        <SummaryCard label="החזר חודשי כולל" value={fILS(totalMonthly)} color="text-orange-500" />
        <SummaryCard
          label="תזרים נטו חודשי"
          value={fILS(netMonthly)}
          color={netMonthly >= 0 ? 'text-green-600' : 'text-red-500'}
          sub={totalMonthlyRent > 0 ? `שכירות: ${fILS(totalMonthlyRent)}` : 'הזן שכירות בלשונית נכסים'}
        />
      </div>

      {/* Loan cards */}
      {loans.map((loan) => {
        const outstandingILS = toILS(loan.outstanding, loan.currency);
        const paidILS = toILS(loan.principal - loan.outstanding, loan.currency);
        const propValueILS = loan.propertyValue ? toILS(loan.propertyValue, loan.currency) : null;
        const ltv = propValueILS && propValueILS > 0 ? (outstandingILS / propValueILS) * 100 : null;
        const equity = propValueILS ? propValueILS - outstandingILS : null;
        const pctPaid = loan.principal > 0 ? ((loan.principal - loan.outstanding) / loan.principal) * 100 : 0;
        const sym = loan.currency === 'USD' ? '$' : '₪';

        // Linked asset
        const linkedAsset = getLinkedAsset(loan);
        const monthlyRent = linkedAsset?.monthlyRentalIncome ?? 0;
        const monthlyRentILS = toILS(monthlyRent, loan.currency);
        const monthlyPaymentILS = toILS(loan.monthlyPayment, loan.currency);
        const netCashFlow = monthlyRentILS - monthlyPaymentILS;
        const annualRent = monthlyRentILS * 12;
        const grossYield = propValueILS && propValueILS > 0 ? (annualRent / propValueILS) * 100 : 0;

        return (
          <div key={loan.id} className="bg-white rounded-xl border border-gray-200 p-6 space-y-5">
            {/* Header */}
            <div className="flex items-start justify-between flex-wrap gap-2">
              <div>
                <h3 className="text-base font-semibold text-gray-800">{loan.name}</h3>
                <p className="text-xs text-gray-400">{loan.type === 'mortgage' ? 'משכנתא' : 'הלוואה פרטית'} · ריבית {loan.interestRate}% · {loan.currency}</p>
              </div>
              {ltv !== null && (
                <span className={`text-sm font-bold px-3 py-1 rounded-full ${ltvBg(ltv)}`}>
                  LTV {ltv.toFixed(1)}%
                </span>
              )}
            </div>

            {/* Editable fields */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <NumField label={`יתרת חוב (${sym})`} value={loan.outstanding} step="1000"
                onChange={(v) => updateLoan(loan.id, 'outstanding', v)} />
              <NumField label={`קרן מקורית (${sym})`} value={loan.principal} step="1000"
                onChange={(v) => updateLoan(loan.id, 'principal', v)} />
              <NumField label="תשלום חודשי" value={loan.monthlyPayment} step="100"
                onChange={(v) => updateLoan(loan.id, 'monthlyPayment', v)} />
              <NumField label="ריבית (%)" value={loan.interestRate} step="0.1"
                onChange={(v) => updateLoan(loan.id, 'interestRate', v)} />
              {loan.propertyValue !== undefined && (
                <NumField label={`שווי נכס (${sym})`} value={loan.propertyValue} step="10000"
                  onChange={(v) => updateLoan(loan.id, 'propertyValue', v)} />
              )}
            </div>

            {/* KPI row */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <InfoBlock label="שולם עד כה" value={fILS(paidILS)} sub={`${pctPaid.toFixed(0)}% מהקרן`} color="text-blue-700" />
              {equity !== null && (
                <InfoBlock label="הון עצמי בנכס" value={fILS(equity)} color={equity > 0 ? 'text-green-600' : 'text-red-500'} />
              )}
              {monthlyRent > 0 && (
                <InfoBlock
                  label="תזרים נטו חודשי"
                  value={fILS(netCashFlow)}
                  color={netCashFlow >= 0 ? 'text-green-600' : 'text-red-500'}
                  sub={`שכ׳: ${fILS(monthlyRentILS)} | משכנתא: ${fILS(monthlyPaymentILS)}`}
                />
              )}
              {grossYield > 0 && (
                <InfoBlock label="תשואה גולמית" value={`${grossYield.toFixed(2)}%`} color="text-purple-600" sub="לשנה" />
              )}
            </div>

            {/* Payoff progress */}
            <div>
              <div className="flex justify-between text-xs text-gray-500 mb-1.5">
                <span>שולם: {sym}{(loan.principal - loan.outstanding).toLocaleString()}</span>
                <span>{pctPaid.toFixed(0)}%</span>
                <span>נותר: {sym}{loan.outstanding.toLocaleString()}</span>
              </div>
              <div className="w-full bg-gray-100 rounded-full h-3">
                <div
                  className="bg-gradient-to-l from-blue-500 to-blue-400 h-3 rounded-full transition-all"
                  style={{ width: `${Math.min(100, pctPaid)}%` }}
                />
              </div>
            </div>
          </div>
        );
      })}

      {/* Net worth footer */}
      <div className="bg-gradient-to-l from-gray-700 to-gray-900 rounded-xl p-6 text-white">
        <div className="flex flex-wrap gap-6">
          <div>
            <p className="text-gray-300 text-sm">שווי נקי כולל</p>
            <p className="text-3xl font-bold mt-1">{fILS(portfolio.netWorthILS)}</p>
          </div>
          <div>
            <p className="text-gray-300 text-sm">נכסים</p>
            <p className="text-xl font-bold mt-1 text-green-400">{fILS(portfolio.totalAssetsILS)}</p>
          </div>
          <div>
            <p className="text-gray-300 text-sm">התחייבויות</p>
            <p className="text-xl font-bold mt-1 text-red-400">{fILS(portfolio.totalLiabilitiesILS)}</p>
          </div>
        </div>
      </div>
    </div>
  );
};

const SummaryCard: FC<{ label: string; value: string; color: string; sub?: string }> = ({ label, value, color, sub }) => (
  <div className="bg-white rounded-xl border border-gray-200 p-4">
    <p className="text-xs text-gray-500">{label}</p>
    <p className={`text-xl font-bold mt-1 ${color}`}>{value}</p>
    {sub && <p className="text-xs text-gray-400 mt-0.5">{sub}</p>}
  </div>
);

const InfoBlock: FC<{ label: string; value: string; color?: string; sub?: string }> = ({ label, value, color = 'text-gray-800', sub }) => (
  <div className="bg-gray-50 rounded-lg p-3">
    <p className="text-xs text-gray-500 mb-1">{label}</p>
    <p className={`font-bold text-base ${color}`}>{value}</p>
    {sub && <p className="text-xs text-gray-400 mt-0.5">{sub}</p>}
  </div>
);

const NumField: FC<{ label: string; value: number; onChange: (v: string) => void; step?: string }> = ({ label, value, onChange, step = '1000' }) => (
  <div>
    <label className="block text-xs text-gray-500 mb-1">{label}</label>
    <input type="number" step={step} value={value}
      onChange={(e) => onChange(e.target.value)}
      className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
  </div>
);

export default LoansTab;
