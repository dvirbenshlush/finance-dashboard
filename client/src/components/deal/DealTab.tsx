import React, { type FC, useState, useMemo, useRef, type ReactNode } from 'react';
import type { Portfolio, MortgageTrack } from '../../types';

// ── Formatters ────────────────────────────────────────────────────────────────
const fILS = (v: number) =>
  new Intl.NumberFormat('he-IL', { style: 'currency', currency: 'ILS', maximumFractionDigits: 0 }).format(v);
const fPct = (v: number, d = 2) => `${v.toFixed(d)}%`;

// ── Types ─────────────────────────────────────────────────────────────────────
interface DealInputs {
  // Deal basics
  purchasePrice: number;
  equity: number;
  interestRate: number;       // annual %
  loanTermYears: number;
  annualAppreciationPct: number; // % annual price growth → salePrice computed
  holdingYears: number;       // for שבח linear calc

  // Costs
  renovationCost: number;     // השקעה בפרויקט
  lawyerPct: number;          // שכ"ט עו"ד as % of purchase price
  registrationFee: number;    // רישום + טאבו (fixed ₪)
  agentPct: number;           // תיווך (% of sale price at exit)
  inspectionFee: number;      // בדק בית (fixed ₪, +18% VAT)
  appraiserFee: number;       // שמאי (fixed ₪, +18% VAT)
  brokeragePurchasePct: number; // תיווך קנייה (% of purchase price, +18% VAT)

  // Insurance
  buildingInsuranceAnnual: number;
  lifeInsuranceMonthly: number;

  // Rental cashflow
  monthlyRent: number;
  vacancyMonths: number;
  annualRentGrowthPct: number;  // % annual rent increase for projections

  // Recurring operating costs
  maintenanceCostAnnual: number; // שוטפות ותיקונים (₪/שנה)
  extraExpenses: ExtraExpense[]; // custom fixed recurring expenses

  // Toggles
  includePurchaseTax: boolean;
  includeCapitalGains: boolean;
  showEquityCalc: boolean;

  // Purchase date
  purchaseYear: number;

  // Mortgage mix
  mortgageTracks: MortgageTrack[];
}

interface ExtraExpense {
  id: string;
  label: string;
  amountMonthly: number;
}

// ── Constants ─────────────────────────────────────────────────────────────────
const LS_DEAL = 'otzar_deal_calc';

const DEFAULT: DealInputs = {
  purchasePrice: 1_500_000,
  equity: 400_000,
  interestRate: 4.5,
  loanTermYears: 25,
  annualAppreciationPct: 5,
  holdingYears: 10,
  renovationCost: 80_000,
  lawyerPct: 0.5,
  registrationFee: 5_000,
  agentPct: 1.5,
  inspectionFee: 2_500,
  appraiserFee: 2_500,
  brokeragePurchasePct: 2,
  buildingInsuranceAnnual: 3_600,
  lifeInsuranceMonthly: 300,
  monthlyRent: 5_000,
  vacancyMonths: 1,
  annualRentGrowthPct: 2,
  maintenanceCostAnnual: 3_000,
  extraExpenses: [],
  includePurchaseTax: false,
  includeCapitalGains: true,
  showEquityCalc: true,
  mortgageTracks: [],
  purchaseYear: new Date().getFullYear(),
};

function loadDeal(): DealInputs {
  try {
    const raw = localStorage.getItem(LS_DEAL);
    return raw ? { ...DEFAULT, ...JSON.parse(raw) } : DEFAULT;
  } catch { return DEFAULT; }
}

// ── Finance helpers ───────────────────────────────────────────────────────────

/** Purchase tax (מס רכישה) — investor / non-first-home bracket (2024) */
function calcPurchaseTax(price: number): number {
  // Up to ₪1,978,745 → 8%, above → 10%
  const T1 = 1_978_745;
  if (price <= T1) return price * 0.08;
  return T1 * 0.08 + (price - T1) * 0.10;
}

/**
 * Capital gains tax (מס שבח) — linear exemption method.
 * The portion of the gain earned before 1/1/2014 is exempt.
 * The rest is taxed at 25%.
 */
function calcCapitalGainsTax(gain: number, holdingYears: number): number {
  if (gain <= 0) return 0;
  const CURRENT_YEAR = 2026;
  const purchaseYear = CURRENT_YEAR - holdingYears;
  const yearsAfter2014 = Math.max(0, CURRENT_YEAR - Math.max(purchaseYear, 2014));
  const taxableFraction = holdingYears > 0 ? yearsAfter2014 / holdingYears : 1;
  return gain * taxableFraction * 0.25;
}

/** Monthly mortgage payment — standard PMT formula */
function pmt(principal: number, annualRate: number, termYears: number): number {
  const r = annualRate / 100 / 12;
  const n = termYears * 12;
  if (r === 0 || n === 0) return principal / (n || 1);
  return principal * r * Math.pow(1 + r, n) / (Math.pow(1 + r, n) - 1);
}

interface AmorRow {
  month: number;
  opening: number;
  payment: number;
  interest: number;
  principal: number;
  closing: number;
}

function buildAmortization(principal: number, annualRate: number, termYears: number): AmorRow[] {
  const r = annualRate / 100 / 12;
  const n = termYears * 12;
  const payment = pmt(principal, annualRate, termYears);
  const rows: AmorRow[] = [];
  let balance = principal;
  for (let m = 1; m <= n; m++) {
    const interest  = balance * r;
    const prinPart  = payment - interest;
    const closing   = Math.max(0, balance - prinPart);
    rows.push({ month: m, opening: balance, payment, interest, principal: prinPart, closing });
    balance = closing;
    if (balance < 0.01) break;
  }
  return rows;
}

// ── Sub-components ────────────────────────────────────────────────────────────
const NF: FC<{
  label: string; value: number; step?: string; suffix?: string; prefix?: string;
  onChange: (v: number) => void; hint?: string; readOnly?: boolean;
}> = ({ label, value, step = '1000', suffix, prefix, onChange, hint, readOnly }) => (
  <div>
    <label className="block text-xs text-gray-500 mb-1">
      {label}{hint && <span className="text-gray-400 mr-1">({hint})</span>}
    </label>
    <div className="relative flex items-center">
      {prefix && <span className="absolute right-2.5 text-xs text-gray-400 pointer-events-none">{prefix}</span>}
      <input
        type="number" step={step} value={value} readOnly={readOnly}
        onChange={e => onChange(parseFloat(e.target.value) || 0)}
        className={`w-full border rounded-lg py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 ${
          readOnly ? 'bg-gray-50 border-gray-100 text-blue-700 font-semibold cursor-not-allowed' : 'border-gray-200 bg-white'
        } ${prefix ? 'pr-7 pl-3' : suffix ? 'pr-3 pl-7' : 'px-3'}`}
      />
      {suffix && <span className="absolute left-2.5 text-xs text-gray-400 pointer-events-none">{suffix}</span>}
    </div>
  </div>
);

const Toggle: FC<{ label: string; value: boolean; onChange: (v: boolean) => void; color: string }> = ({
  label, value, onChange, color,
}) => (
  <button
    onClick={() => onChange(!value)}
    className={`flex items-center gap-2 px-3 py-1.5 rounded-xl text-xs font-semibold border transition-all ${
      value ? `${color} text-white border-transparent shadow-sm` : 'bg-white/10 text-white/80 border-white/20 hover:bg-white/20'
    }`}
  >
    <span className={`w-3.5 h-3.5 rounded-full border-2 flex items-center justify-center shrink-0 ${
      value ? 'border-white' : 'border-white/50'
    }`}>
      {value && <span className="w-1.5 h-1.5 rounded-full bg-white block" />}
    </span>
    {label}
  </button>
);

const KPI: FC<{ label: string; value: string; sub?: string; color?: string; bg?: string }> = ({
  label, value, sub, color = 'text-gray-800', bg = 'bg-gray-50',
}) => (
  <div className={`${bg} rounded-xl p-4`}>
    <p className="text-xs text-gray-500 mb-1">{label}</p>
    <p className={`text-xl font-bold ${color}`}>{value}</p>
    {sub && <p className="text-xs text-gray-400 mt-0.5">{sub}</p>}
  </div>
);

type SubTab = 'basic' | 'profit' | 'cashflow' | 'amortization' | 'mortgage_mix';

const SUB_TABS: { id: SubTab; label: string; icon: string }[] = [
  { id: 'basic',        label: 'מידע בסיסי',    icon: '📋' },
  { id: 'profit',       label: 'רווח עסקה',     icon: '💰' },
  { id: 'cashflow',     label: 'תזרים',          icon: '📊' },
  { id: 'amortization', label: 'לוח סילוקין',   icon: '🏦' },
  { id: 'mortgage_mix', label: 'תמהיל משכנתא',  icon: '🏗️' },
];

const AMOR_PAGE = 24;

const Tooltip: FC<{ text: string; children: ReactNode }> = ({ text, children }) => (
  <span className="relative group inline-flex items-center">
    {children}
    <span className="pointer-events-none absolute bottom-full right-0 mb-2 w-72 rounded-xl bg-gray-900/95 text-white text-xs leading-relaxed px-3 py-2.5 shadow-xl opacity-0 group-hover:opacity-100 transition-opacity duration-150 z-50 whitespace-pre-line">
      {text}
    </span>
  </span>
);

// ── Main component ────────────────────────────────────────────────────────────
interface DealTabProps {
  portfolio: Portfolio;
  onPortfolioChange: (p: Portfolio) => void;
  focusAssetId?: string | null;
}

const USD_TO_ILS = 3.73;

const DealTab: FC<DealTabProps> = ({ portfolio, onPortfolioChange, focusAssetId }) => {
  const [d, setDRaw]    = useState<DealInputs>(loadDeal);
  const [sub, setSub]   = useState<SubTab>('basic');
  const [page, setPage] = useState(0);
  const [dealName, setDealName]           = useState('');
  const [saveMsg, setSaveMsg]             = useState<string | null>(null);
  const [newExpLabel, setNewExpLabel]     = useState('');
  const [newExpAmt, setNewExpAmt]         = useState('');
  const [cashflowExpanded, setCashflowExpanded] = useState(false);

  // Mortgage track editing
  const [addingTrack,    setAddingTrack]    = useState(false);
  const [editingTrackId, setEditingTrackId] = useState<string | null>(null);
  const [trackDraft, setTrackDraft] = useState<{
    name: string; trackType: MortgageTrack['trackType'];
    principal: string; outstanding: string;
    interestRate: string; monthsTotal: string; monthlyPayment: string;
  }>({ name: '', trackType: 'fixed', principal: '', outstanding: '', interestRate: '', monthsTotal: '', monthlyPayment: '' });

  // When navigated from an asset card, seed deal inputs from the asset
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const seedFromAsset = (assetId: string) => {
    const asset = portfolio.assets.find(a => a.id === assetId);
    if (!asset) return;
    const linkedLoan = portfolio.loans.find(l => l.linkedAssetId === assetId);
    const toILS = (v: number) => asset.currency === 'USD' ? v * USD_TO_ILS : v;
    const price = toILS(asset.purchasePrice ?? asset.value);
    const loanPrincipal = linkedLoan
      ? (linkedLoan.currency === 'USD' ? linkedLoan.principal * USD_TO_ILS : linkedLoan.principal)
      : 0;
    setDRaw(prev => {
      const next: DealInputs = {
        ...prev,
        purchasePrice: Math.round(price),
        equity: Math.round(Math.max(0, price - loanPrincipal)),
        monthlyRent: asset.monthlyRentalIncome ?? prev.monthlyRent,
        purchaseYear: asset.purchaseYear ?? prev.purchaseYear,
        ...(linkedLoan ? {
          interestRate: linkedLoan.interestRate,
          loanTermYears: linkedLoan.termMonths ? Math.round(linkedLoan.termMonths / 12) : prev.loanTermYears,
          ...(linkedLoan.tracks?.length ? { mortgageTracks: linkedLoan.tracks } : {}),
        } : {}),
      };
      localStorage.setItem(LS_DEAL, JSON.stringify(next));
      return next;
    });
  };

  // Seed when focusAssetId first appears
  const prevFocusRef = useRef<string | null | undefined>(undefined);
  if (focusAssetId && focusAssetId !== prevFocusRef.current) {
    prevFocusRef.current = focusAssetId;
    seedFromAsset(focusAssetId);
  }

  const set = (patch: Partial<DealInputs>) => {
    setDRaw(prev => {
      const next = { ...prev, ...patch };
      localStorage.setItem(LS_DEAL, JSON.stringify(next));
      return next;
    });
  };

  const addExpense = () => {
    const amt = parseFloat(newExpAmt);
    if (!newExpLabel.trim() || isNaN(amt) || amt <= 0) return;
    set({ extraExpenses: [...d.extraExpenses, { id: Date.now().toString(), label: newExpLabel.trim(), amountMonthly: amt }] });
    setNewExpLabel('');
    setNewExpAmt('');
  };

  const removeExpense = (id: string) =>
    set({ extraExpenses: d.extraExpenses.filter(e => e.id !== id) });

  const saveToPortfolio = () => {
    const loanAmount = Math.max(0, d.purchasePrice - d.equity);

    // ── Update existing asset (navigated from AssetsTab) ──
    if (focusAssetId) {
      const existingAsset = portfolio.assets.find(a => a.id === focusAssetId);
      if (!existingAsset) return;
      const updatedAsset = {
        ...existingAsset,
        value: d.purchasePrice,
        purchasePrice: d.purchasePrice,
        monthlyRentalIncome: d.monthlyRent,
        purchaseYear: d.purchaseYear,
      };
      const existingLoan = portfolio.loans.find(l => l.linkedAssetId === focusAssetId);
      let updatedLoans = portfolio.loans;
      if (loanAmount > 0) {
        const loanPatch = {
          principal: loanAmount,
          outstanding: d.mortgageTracks.length > 0
            ? d.mortgageTracks.reduce((s, t) => s + t.outstanding, 0)
            : loanAmount,
          interestRate: d.interestRate,
          monthlyPayment: c.monthly,
          termMonths: d.loanTermYears * 12,
          ...(d.mortgageTracks.length > 0 ? { tracks: d.mortgageTracks } : {}),
        };
        if (existingLoan) {
          updatedLoans = portfolio.loans.map(l =>
            l.id === existingLoan.id ? { ...l, ...loanPatch } : l
          );
        } else {
          updatedLoans = [...portfolio.loans, {
            id: `deal-loan-${Date.now()}`,
            name: `משכנתא — ${existingAsset.name}`,
            type: 'mortgage' as const,
            currency: 'ILS' as const,
            linkedAssetId: focusAssetId,
            ...loanPatch,
          }];
        }
      }
      const updatedPortfolio: Portfolio = {
        ...portfolio,
        assets: portfolio.assets.map(a => a.id === focusAssetId ? updatedAsset : a),
        loans: updatedLoans,
      };
      // Recompute totals
      const totalAssets = updatedPortfolio.assets
        .filter(a => a.type !== 'savings')
        .reduce((s, a) => s + (a.currency === 'USD' ? a.value * USD_TO_ILS : a.value), 0);
      const totalLiabilities = updatedPortfolio.loans
        .reduce((s, l) => s + (l.currency === 'USD' ? l.outstanding * USD_TO_ILS : l.outstanding), 0);
      onPortfolioChange({
        ...updatedPortfolio,
        totalAssetsILS: totalAssets,
        totalLiabilitiesILS: totalLiabilities,
        netWorthILS: totalAssets - totalLiabilities,
      });
      setSaveMsg(`✅ "${existingAsset.name}" עודכן בתיק הנכסים`);
      setTimeout(() => setSaveMsg(null), 4000);
      return;
    }

    // ── Add new asset ──
    const name = dealName.trim() || `נכס ${fILS(d.purchasePrice)}`;
    const assetId = `deal-asset-${Date.now()}`;
    const newAsset = {
      id: assetId,
      name,
      type: 'real_estate' as const,
      value: d.purchasePrice,
      currency: 'ILS' as const,
      purchasePrice: d.purchasePrice,
      monthlyRentalIncome: d.monthlyRent,
      purchaseYear: d.purchaseYear,
    };
    const newLoan = loanAmount > 0 ? {
      id: `deal-loan-${Date.now() + 1}`,
      name: `משכנתא — ${name}`,
      type: 'mortgage' as const,
      principal: loanAmount,
      outstanding: d.mortgageTracks.length > 0
        ? d.mortgageTracks.reduce((s, t) => s + t.outstanding, 0)
        : loanAmount,
      interestRate: d.interestRate,
      currency: 'ILS' as const,
      monthlyPayment: c.monthly,
      linkedAssetId: assetId,
      termMonths: d.loanTermYears * 12,
      ...(d.mortgageTracks.length > 0 ? { tracks: d.mortgageTracks } : {}),
    } : null;
    const newPortfolio: Portfolio = {
      ...portfolio,
      assets: [...portfolio.assets, newAsset],
      loans: newLoan ? [...portfolio.loans, newLoan] : portfolio.loans,
      totalAssetsILS: portfolio.totalAssetsILS + d.purchasePrice,
      totalLiabilitiesILS: portfolio.totalLiabilitiesILS + loanAmount,
      netWorthILS: portfolio.netWorthILS + d.purchasePrice - loanAmount,
    };
    onPortfolioChange(newPortfolio);
    setSaveMsg(`✅ "${name}" נוסף לתיק הנכסים${d.mortgageTracks.length > 0 ? ` (${d.mortgageTracks.length} מסלולים)` : ''}`);
    setTimeout(() => setSaveMsg(null), 4000);
  };

  // ── Calculations ────────────────────────────────────────────────────────────
  const c = useMemo(() => {
    const loanAmount  = Math.max(0, d.purchasePrice - d.equity);
    const tracksTotalMonthly = d.mortgageTracks.reduce((s, t) => s + t.monthlyPayment, 0);
    const monthly = loanAmount > 0
      ? (d.mortgageTracks.length > 0 && tracksTotalMonthly > 0 ? tracksTotalMonthly : pmt(loanAmount, d.interestRate, d.loanTermYears))
      : 0;
    const totalPmts   = monthly * d.loanTermYears * 12;
    const totalInterest = totalPmts - loanAmount;

    // Sale price computed from annual appreciation
    const salePrice = d.purchasePrice * Math.pow(1 + d.annualAppreciationPct / 100, d.holdingYears);

    const lawyerAmt       = d.purchasePrice * (d.lawyerPct / 100);
    const lawyerAmtWithVAT = lawyerAmt * 1.18;
    const purchaseTax     = d.includePurchaseTax ? calcPurchaseTax(d.purchasePrice) : 0;
    const lifeAnnual      = d.lifeInsuranceMonthly * 12;
    const agentAmt        = salePrice * (d.agentPct / 100);

    // Acquisition costs with VAT
    const inspectionWithVAT  = d.inspectionFee * 1.18;
    const appraiserWithVAT   = d.appraiserFee * 1.18;
    const brokerageWithVAT   = d.purchasePrice * (d.brokeragePurchasePct / 100) * 1.18;

    // Transaction costs (fees on top of purchase price, all VAT-inclusive)
    const transactionCosts =
      d.renovationCost + lawyerAmtWithVAT + d.registrationFee + purchaseTax +
      inspectionWithVAT + appraiserWithVAT + brokerageWithVAT;

    // Cash actually invested by the buyer (equity portion + all fees)
    // The loan amount is NOT included — it flows through monthly payments & closingBalance
    const investedCash   = d.equity + transactionCosts;
    // Full property cost (for reference / % column base)
    const acquisitionCost = d.purchasePrice + transactionCosts;

    // Amortization
    const holdingMonths  = Math.min(d.holdingYears * 12, d.loanTermYears * 12);
    const amortSched     = buildAmortization(loanAmount, d.interestRate, d.loanTermYears);
    const interestPaid   = amortSched.slice(0, holdingMonths).reduce((s, r) => s + r.interest, 0);
    const closingBalance = amortSched[holdingMonths - 1]?.closing ?? loanAmount;

    const netSaleProceeds = salePrice - closingBalance - agentAmt;

    // Capital gains tax
    const nominalGain    = Math.max(0, salePrice - d.purchasePrice - transactionCosts);
    const capitalGainsTax = d.includeCapitalGains
      ? calcCapitalGainsTax(nominalGain, d.holdingYears) : 0;

    // Annual operating cashflow — year 0 (before rent growth)
    const effectiveMonths  = 12 - d.vacancyMonths;
    const annualRent       = d.monthlyRent * effectiveMonths;   // year-1 rent
    const extraMonthly     = d.extraExpenses.reduce((s, e) => s + e.amountMonthly, 0);
    // Annual expenses are fixed (mortgage, insurance, maintenance don't grow with rent)
    const annualExpenses   = monthly * 12 + d.buildingInsuranceAnnual + lifeAnnual +
      d.maintenanceCostAnnual + extraMonthly * 12;
    const annualCashflow   = annualRent - annualExpenses;       // year-1 cashflow
    const monthlyCashflow  = annualCashflow / 12;
    const cashflowYield    = acquisitionCost > 0 ? (annualRent / acquisitionCost) * 100 : 0;
    const breakEvenOcc     = annualExpenses > 0 && d.monthlyRent > 0
      ? (annualExpenses / (d.monthlyRent * 12)) * 100 : 0;

    // Cumulative cashflow with rent growth (geometric series for rent, flat for expenses)
    // sum of annualRent × (1+g)^i for i=0..n-1  =  annualRent × ((1+g)^n − 1) / g  (g≠0)
    const g = d.annualRentGrowthPct / 100;
    const rentMultiplier = g > 0
      ? (Math.pow(1 + g, d.holdingYears) - 1) / g
      : d.holdingYears;
    const cumulativeRent     = annualRent * rentMultiplier;
    const cumulativeExpenses = annualExpenses * d.holdingYears;
    const cumulativeCashflow = cumulativeRent - cumulativeExpenses;

    // ── Net profit ─────────────────────────────────────────────────────────────
    // Formula (matches tooltip):
    //   salePrice
    //   + principalRepaid          (equity built up via mortgage payments)
    //   + cumulativeRent           (rent collected with growth)
    //   − cumulativeExpenses       (all running costs incl. full mortgage payment)
    //   − closingBalance           (remaining mortgage paid off at sale)
    //   − investedCash             (equity + fees paid upfront)
    const principalRepaid = Math.max(0, loanAmount - closingBalance);
    const netProfit = salePrice + principalRepaid + cumulativeRent - cumulativeExpenses - closingBalance - investedCash;

    const roiBase     = d.equity > 0 ? d.equity : investedCash;
    const roiOnEquity = roiBase > 0 ? (netProfit / roiBase) * 100 : 0;
    const annualROI   = d.holdingYears > 0 ? roiOnEquity / d.holdingYears : 0;

    const equityAtSale = netSaleProceeds;

    return {
      loanAmount, monthly, totalPmts, totalInterest,
      salePrice, netSaleProceeds,
      lawyerAmt, lawyerAmtWithVAT, purchaseTax, lifeAnnual, agentAmt,
      inspectionWithVAT, appraiserWithVAT, brokerageWithVAT,
      transactionCosts, investedCash, acquisitionCost, capitalGainsTax,
      interestPaid, cumulativeCashflow, cumulativeRent, cumulativeExpenses,
      netProfit, roiOnEquity, annualROI,
      annualRent, annualExpenses, annualCashflow, extraMonthly,
      monthlyCashflow, cashflowYield, breakEvenOcc,
      equityAtSale, closingBalance,
      amortSched,
    };
  }, [d]);

  const amorSlice = c.amortSched.slice(page * AMOR_PAGE, (page + 1) * AMOR_PAGE);
  const amorPages = Math.ceil(c.amortSched.length / AMOR_PAGE);

  // ── Asset focus summary ─────────────────────────────────────────────────────
  const focusSummary = useMemo(() => {
    if (!focusAssetId) return null;
    const asset = portfolio.assets.find(a => a.id === focusAssetId);
    if (!asset) return null;
    const toILS = (v: number) => asset.currency === 'USD' ? v * USD_TO_ILS : v;
    const linkedLoan = portfolio.loans.find(l => l.linkedAssetId === asset.id);
    const loanPrincipal   = linkedLoan ? (linkedLoan.currency === 'USD' ? linkedLoan.principal   * USD_TO_ILS : linkedLoan.principal)   : 0;
    const loanOutstanding = linkedLoan ? (linkedLoan.currency === 'USD' ? linkedLoan.outstanding * USD_TO_ILS : linkedLoan.outstanding) : 0;
    const purchasePriceILS = toILS(asset.purchasePrice ?? asset.value);
    const currentValueILS  = toILS(asset.value);
    const invested  = purchasePriceILS - loanPrincipal;   // equity at purchase
    const equityNow = currentValueILS  - loanOutstanding; // current equity
    return { asset, invested, equityNow, loanOutstanding, currentValueILS };
  }, [focusAssetId, portfolio.assets, portfolio.loans]);

  // ── Render ──────────────────────────────────────────────────────────────────
  return (
    <div className="space-y-4" dir="rtl">

      {/* ── Asset focus panel ── */}
      {focusSummary && (
        <div className="bg-gradient-to-l from-blue-700 to-indigo-800 rounded-2xl p-5 text-white">
          <p className="text-blue-200 text-xs mb-3 font-medium">סיכום נכס — {focusSummary.asset.name}</p>
          <div className="flex flex-wrap gap-6 items-end">
            <div>
              <p className="text-white/60 text-xs mb-1">סכום שהושקע (הון עצמי)</p>
              <p className="text-3xl font-bold">
                {new Intl.NumberFormat('he-IL', { style: 'currency', currency: 'ILS', maximumFractionDigits: 0 }).format(focusSummary.invested)}
              </p>
              <p className="text-white/50 text-xs mt-0.5">מחיר רכישה פחות הלוואה מקורית</p>
            </div>
            <div className="w-px bg-white/20 self-stretch hidden md:block" />
            <div>
              <p className="text-white/60 text-xs mb-1">הון עצמי כרגע</p>
              <p className={`text-3xl font-bold ${focusSummary.equityNow >= 0 ? 'text-green-200' : 'text-red-200'}`}>
                {new Intl.NumberFormat('he-IL', { style: 'currency', currency: 'ILS', maximumFractionDigits: 0 }).format(focusSummary.equityNow)}
              </p>
              <p className="text-white/50 text-xs mt-0.5">שווי נוכחי פחות יתרת הלוואה</p>
            </div>
            {focusSummary.equityNow > focusSummary.invested && (
              <>
                <div className="w-px bg-white/20 self-stretch hidden md:block" />
                <div>
                  <p className="text-white/60 text-xs mb-1">רווח על ההון</p>
                  <p className="text-2xl font-bold text-yellow-200">
                    +{new Intl.NumberFormat('he-IL', { style: 'currency', currency: 'ILS', maximumFractionDigits: 0 }).format(focusSummary.equityNow - focusSummary.invested)}
                  </p>
                  <p className="text-white/50 text-xs mt-0.5">
                    {((focusSummary.equityNow - focusSummary.invested) / focusSummary.invested * 100).toFixed(1)}% תשואה על הון
                  </p>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* ── Summary banner ── */}
      <div className={`rounded-2xl p-5 text-white ${
        c.netProfit >= 0 ? 'bg-gradient-to-l from-emerald-700 to-teal-800' : 'bg-gradient-to-l from-red-700 to-rose-800'
      }`}>
        <div className="flex flex-wrap gap-5 items-end mb-4">
          <div>
            <p className="text-white/60 text-xs mb-1 flex items-center gap-1">
              רווח נקי (לפני תיווך ומיסים)
              <Tooltip text={
`נוסחה:
מחיר מכירה משוער
+ קרן ששולמה (= הלוואה − יתרת סגירה)
+ תזרים שכ"ד מצטבר (כולל עליית שכ"ד)
− הוצאות שוטפות מצטברות (משכנתא, ביטוח, תחזוקה)
− יתרת משכנתא בסגירה
− כסף שהושקע (הון עצמי + עלויות)

תיווך ביציאה ומס שבח מוצגים בנפרד.`
              }>
                <span className="cursor-help text-white/40 hover:text-white/80 transition-colors text-xs border border-white/30 rounded-full w-4 h-4 flex items-center justify-center leading-none">?</span>
              </Tooltip>
            </p>
            <p className="text-4xl font-bold">{c.netProfit >= 0 ? '+' : ''}{fILS(c.netProfit)}</p>
          </div>
          <div className="w-px bg-white/20 self-stretch hidden md:block" />
          <div>
            <p className="text-white/60 text-xs mb-1">ROI על הון עצמי</p>
            <p className="text-2xl font-bold">{fPct(c.roiOnEquity, 1)}</p>
            <p className="text-white/50 text-xs">{fPct(c.annualROI)}/שנה</p>
          </div>
          <div>
            <p className="text-white/60 text-xs mb-1">תזרים חודשי</p>
            <p className={`text-2xl font-bold ${c.monthlyCashflow >= 0 ? 'text-green-200' : 'text-red-200'}`}>
              {c.monthlyCashflow >= 0 ? '+' : ''}{fILS(c.monthlyCashflow)}
            </p>
          </div>
          <div>
            <p className="text-white/60 text-xs mb-1">תשואת שכ"ד</p>
            <p className="text-2xl font-bold">{fPct(c.cashflowYield)}</p>
          </div>
          {d.showEquityCalc && (
            <div>
              <p className="text-white/60 text-xs mb-1">הון עצמי בסוף אחזקה</p>
              <p className="text-2xl font-bold text-yellow-200">{fILS(c.equityAtSale)}</p>
              <p className="text-white/50 text-xs">לאחר פירעון + מכירה</p>
            </div>
          )}
        </div>

        {/* Toggles */}
        <div className="flex flex-wrap gap-2 pt-3 border-t border-white/20">
          <Toggle label="מס רכישה" value={d.includePurchaseTax}
            onChange={v => set({ includePurchaseTax: v })} color="bg-orange-500" />
          <Toggle label="מס שבח" value={d.includeCapitalGains}
            onChange={v => set({ includeCapitalGains: v })} color="bg-purple-500" />
          <Toggle label="חישובי הון עצמי" value={d.showEquityCalc}
            onChange={v => set({ showEquityCalc: v })} color="bg-blue-500" />
        </div>
      </div>

      {/* ── Sub-tab nav ── */}
      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        <div className="flex border-b border-gray-200 overflow-x-auto">
          {SUB_TABS.map(t => (
            <button key={t.id} onClick={() => setSub(t.id)}
              className={`flex items-center gap-1.5 px-5 py-3.5 text-sm font-medium whitespace-nowrap border-b-2 transition-colors -mb-px ${
                sub === t.id
                  ? 'border-blue-600 text-blue-600 bg-blue-50/50'
                  : 'border-transparent text-gray-500 hover:text-gray-800 hover:bg-gray-50'
              }`}>
              <span>{t.icon}</span>
              <span>{t.label}</span>
            </button>
          ))}
        </div>

        <div className="p-6">

          {/* ══ מידע בסיסי ══ */}
          {sub === 'basic' && (
            <div className="space-y-7">

              <section>
                <h4 className="text-sm font-semibold text-gray-700 mb-3 flex items-center gap-1.5">
                  🏠 פרטי העסקה
                </h4>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                  <NF label="מחיר קנייה (₪)" value={d.purchasePrice}
                    onChange={v => set({ purchasePrice: v })} />
                  <NF label="הון עצמי (₪)" value={d.equity}
                    onChange={v => set({ equity: v })} />
                  <NF label="סכום הלוואה (₪)" value={c.loanAmount}
                    onChange={() => {}} readOnly hint="מחושב" />
                  <NF label="ריבית שנתית" value={d.interestRate} step="0.1"
                    suffix="%" onChange={v => set({ interestRate: v })} />
                  <NF label="תקופת משכנתא" value={d.loanTermYears} step="1"
                    suffix="שנה" onChange={v => set({ loanTermYears: v })} />
                  <NF label="עליית ערך שנתית משוערת" value={d.annualAppreciationPct} step="0.5"
                    suffix="%" onChange={v => set({ annualAppreciationPct: v })} />
                  <NF label="שנות אחזקה" value={d.holdingYears} step="1"
                    suffix="שנה" hint="לחישוב שבח" onChange={v => set({ holdingYears: v })} />
                  <NF label="שנת רכישה" value={d.purchaseYear} step="1"
                    hint={`${new Date().getFullYear() - d.purchaseYear} שנים שהוחזק`}
                    onChange={v => set({ purchaseYear: Math.round(v) })} />
                  <NF label="מחיר מכירה משוער (₪)" value={Math.round(c.salePrice)}
                    onChange={() => {}} readOnly hint="מחושב" />
                  <NF label="תיווך ביציאה" value={d.agentPct} step="0.5"
                    suffix="%" onChange={v => set({ agentPct: v })} />
                </div>
              </section>

              <section>
                <h4 className="text-sm font-semibold text-gray-700 mb-3">💸 עלויות רכישה</h4>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                  <NF label="השקעה בפרויקט / שיפוץ (₪)" value={d.renovationCost}
                    onChange={v => set({ renovationCost: v })} />
                  <NF label='שכ"ט עו"ד' value={d.lawyerPct} step="0.1"
                    suffix="%" hint={`+מע"מ ≈ ${fILS(c.lawyerAmtWithVAT)}`}
                    onChange={v => set({ lawyerPct: v })} />
                  <NF label="רישום + טאבו (₪)" value={d.registrationFee} step="500"
                    onChange={v => set({ registrationFee: v })} />
                  <NF label="בדק בית (₪)" value={d.inspectionFee} step="500"
                    hint={`+מע"מ ≈ ${fILS(c.inspectionWithVAT)}`}
                    onChange={v => set({ inspectionFee: v })} />
                  <NF label="שמאי (₪)" value={d.appraiserFee} step="500"
                    hint={`+מע"מ ≈ ${fILS(c.appraiserWithVAT)}`}
                    onChange={v => set({ appraiserFee: v })} />
                  <NF label="תיווך קנייה" value={d.brokeragePurchasePct} step="0.5"
                    suffix="%" hint={`+מע"מ ≈ ${fILS(c.brokerageWithVAT)}`}
                    onChange={v => set({ brokeragePurchasePct: v })} />
                  <div>
                    <label className="block text-xs text-gray-500 mb-1">מס רכישה</label>
                    <label className="flex items-center gap-2.5 border border-gray-200 bg-white rounded-lg px-3 py-2 cursor-pointer hover:bg-gray-50 transition-colors">
                      <input
                        type="checkbox"
                        checked={d.includePurchaseTax}
                        onChange={e => set({ includePurchaseTax: e.target.checked })}
                        className="w-4 h-4 accent-orange-500 cursor-pointer"
                      />
                      <span className="text-sm text-gray-700">
                        {d.includePurchaseTax
                          ? <span className="font-semibold text-orange-600">{fILS(c.purchaseTax)}</span>
                          : <span className="text-gray-400">8% עד ₪1.98M · 10% מעל</span>
                        }
                      </span>
                    </label>
                  </div>
                  <div>
                    <label className="block text-xs text-gray-500 mb-1">מס שבח</label>
                    <label className="flex items-center gap-2.5 border border-gray-200 bg-white rounded-lg px-3 py-2 cursor-pointer hover:bg-gray-50 transition-colors">
                      <input
                        type="checkbox"
                        checked={d.includeCapitalGains}
                        onChange={e => set({ includeCapitalGains: e.target.checked })}
                        className="w-4 h-4 accent-purple-500 cursor-pointer"
                      />
                      <span className="text-sm text-gray-700">
                        {d.includeCapitalGains
                          ? <span className="font-semibold text-purple-600">{fILS(c.capitalGainsTax)}</span>
                          : <span className="text-gray-400">שיטה לינארית · 25% על חלק לאחר 2014</span>
                        }
                      </span>
                    </label>
                  </div>
                </div>
              </section>

              <section>
                <h4 className="text-sm font-semibold text-gray-700 mb-3">🛡️ ביטוחים</h4>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                  <NF label="ביטוח מבנה (שנתי ₪)" value={d.buildingInsuranceAnnual} step="100"
                    onChange={v => set({ buildingInsuranceAnnual: v })} />
                  <NF label="ביטוח חיים (חודשי ₪)" value={d.lifeInsuranceMonthly} step="50"
                    onChange={v => set({ lifeInsuranceMonthly: v })} />
                </div>
              </section>

              <section>
                <h4 className="text-sm font-semibold text-gray-700 mb-3">🏘️ שכירות</h4>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                  <NF label="שכירות חודשית (₪)" value={d.monthlyRent} step="100"
                    onChange={v => set({ monthlyRent: v })} />
                  <NF label="חודשי ריקנות / שנה" value={d.vacancyMonths} step="0.5"
                    onChange={v => set({ vacancyMonths: v })} />
                  <NF label="צפי עליית שכירות שנתית" value={d.annualRentGrowthPct} step="0.5"
                    suffix="%" onChange={v => set({ annualRentGrowthPct: v })} />
                </div>
              </section>

              <section>
                <h4 className="text-sm font-semibold text-gray-700 mb-3">🔧 הוצאות שוטפות קבועות</h4>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-4">
                  <NF label="תחזוקה ותיקונים (₪/שנה)" value={d.maintenanceCostAnnual} step="500"
                    onChange={v => set({ maintenanceCostAnnual: v })} />
                </div>

                {/* Dynamic extra expenses */}
                {d.extraExpenses.length > 0 && (
                  <div className="mb-3 space-y-1.5">
                    {d.extraExpenses.map(e => (
                      <div key={e.id} className="flex items-center justify-between bg-gray-50 rounded-lg px-3 py-2 text-sm">
                        <span className="text-gray-700">{e.label}</span>
                        <div className="flex items-center gap-3">
                          <span className="text-red-500 font-medium tabular-nums">{fILS(e.amountMonthly)}/חודש</span>
                          <button onClick={() => removeExpense(e.id)}
                            className="text-gray-300 hover:text-red-500 transition-colors text-xs">✕</button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                <div className="flex gap-2 items-end">
                  <div className="flex-1">
                    <label className="block text-xs text-gray-500 mb-1">תיאור הוצאה</label>
                    <input type="text" value={newExpLabel} onChange={e => setNewExpLabel(e.target.value)}
                      placeholder='לדוג׳: ועד בית, ארנונה...'
                      className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
                  </div>
                  <div className="w-36">
                    <label className="block text-xs text-gray-500 mb-1">סכום חודשי (₪)</label>
                    <input type="number" value={newExpAmt} onChange={e => setNewExpAmt(e.target.value)}
                      placeholder="0"
                      className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
                  </div>
                  <button onClick={addExpense}
                    className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 transition-colors shrink-0">
                    + הוסף
                  </button>
                </div>
              </section>

            </div>
          )}

          {/* ══ רווח עסקה ══ */}
          {sub === 'profit' && (
            <div className="space-y-5">

              {/* KPI row */}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <KPI label="כסף שהושקע (הון + עלויות)" value={fILS(c.investedCash)}
                  sub={`עלות נכס כוללת: ${fILS(c.acquisitionCost)}`}
                  bg="bg-blue-50" color="text-blue-800" />
                {d.showEquityCalc && (
                  <KPI label="הלוואה" value={fILS(c.loanAmount)}
                    sub={`${((c.loanAmount / c.acquisitionCost) * 100).toFixed(1)}% מימון`}
                    bg="bg-indigo-50" color="text-indigo-800" />
                )}
                <KPI label={`תזרים מצטבר (${d.holdingYears} שנה · ${d.annualRentGrowthPct}%/שנה)`}
                  value={`${c.cumulativeCashflow >= 0 ? '+' : ''}${fILS(c.cumulativeCashflow)}`}
                  sub={`שכ"ד: +${fILS(c.cumulativeRent)} · הוצאות: -${fILS(c.cumulativeExpenses)}`}
                  color={c.cumulativeCashflow >= 0 ? 'text-teal-700' : 'text-orange-600'}
                  bg={c.cumulativeCashflow >= 0 ? 'bg-teal-50' : 'bg-orange-50'} />
                <KPI label="רווח נקי"
                  value={`${c.netProfit >= 0 ? '+' : ''}${fILS(c.netProfit)}`}
                  sub={`${fPct(c.annualROI)}/שנה על הון עצמי`}
                  color={c.netProfit >= 0 ? 'text-emerald-700' : 'text-red-600'}
                  bg={c.netProfit >= 0 ? 'bg-emerald-50' : 'bg-red-50'} />
              </div>

              {/* Full breakdown table */}
              <div className="rounded-xl border border-gray-200 overflow-hidden">
                <table className="w-full text-sm">
                  <thead className="bg-gray-50">
                    <tr>
                      <th className="text-right px-4 py-2.5 font-semibold text-gray-600">סעיף</th>
                      <th className="text-right px-4 py-2.5 font-semibold text-gray-600">סכום</th>
                      <th className="text-right px-4 py-2.5 font-semibold text-gray-600 hidden md:table-cell">% מהשקעה</th>
                    </tr>
                  </thead>
                  <tbody>

                    {/* 1. Invested cash (equity + fees — NOT the bank loan) */}
                    <GroupRow icon="🏠" label="כסף שהושקע בפועל (הון עצמי + עלויות)" />
                    {[
                      { label: 'הון עצמי',                                           val: d.equity },
                      { label: 'השקעה בפרויקט / שיפוץ',                             val: d.renovationCost },
                      { label: `שכ"ט עו"ד ${d.lawyerPct}% (+מע"מ)`,               val: c.lawyerAmtWithVAT },
                      { label: 'רישום + טאבו',                                       val: d.registrationFee },
                      { label: 'בדק בית (+מע"מ)',                                   val: c.inspectionWithVAT },
                      { label: 'שמאי (+מע"מ)',                                      val: c.appraiserWithVAT },
                      { label: `תיווך קנייה ${d.brokeragePurchasePct}% (+מע"מ)`,   val: c.brokerageWithVAT },
                      ...(d.includePurchaseTax ? [{ label: 'מס רכישה', val: c.purchaseTax }] : []),
                    ].filter(r => r.val > 0).map((r, i) => (
                      <CostRow key={i} label={r.label} val={r.val} base={c.investedCash} isDebit />
                    ))}
                    <tr className="bg-gray-50 text-xs text-gray-400 italic">
                      <td colSpan={3} className="px-4 py-1">
                        מחיר קנייה כולל: {fILS(d.purchasePrice)} (הלוואה: {fILS(c.loanAmount)} — נספרת דרך ההחזרים החודשיים ויתרת הסגירה)
                      </td>
                    </tr>
                    <SubtotalRow label='סה"כ כסף שהושקע' val={c.investedCash} positive={false} />

                    {/* 2. Cumulative cashflow over holding period (with rent growth) */}
                    <GroupRow icon="📊" label={`תזרים שנות אחזקה (${d.holdingYears} שנה · עליית שכ"ד ${d.annualRentGrowthPct}%/שנה)`} />
                    <CostRow
                      label={`הכנסה משכ"ד מצטברת (${12 - d.vacancyMonths} חודשי גבייה/שנה + עליית שכ"ד)`}
                      val={c.cumulativeRent} base={c.investedCash} isDebit={false} />
                    <CostRow
                      label={`הוצאות שוטפות מצטברות (משכנתא + ביטוח + תחזוקה)`}
                      val={c.cumulativeExpenses} base={c.investedCash} isDebit />
                    <SubtotalRow
                      label="תזרים נקי מצטבר"
                      val={Math.abs(c.cumulativeCashflow)}
                      positive={c.cumulativeCashflow >= 0} />

                    {/* 3. Sale */}
                    <GroupRow icon="📤" label={`מכירה (שנה ${d.holdingYears})`} />
                    <CostRow label={`מחיר מכירה משוער (${d.annualAppreciationPct}%/שנה)`}
                      val={c.salePrice} base={c.investedCash} isDebit={false} />
                    {c.closingBalance > 0 && (
                      <CostRow label="פירעון יתרת משכנתא" val={c.closingBalance} base={c.investedCash} isDebit />
                    )}

                    {/* Net profit (no agent / tax) */}
                    <tr className={`font-bold border-t-2 ${c.netProfit >= 0 ? 'bg-emerald-50 border-emerald-200' : 'bg-red-50 border-red-200'}`}>
                      <td className={`px-4 py-3 text-base ${c.netProfit >= 0 ? 'text-emerald-800' : 'text-red-700'}`}>
                        <Tooltip text={
`= מחיר מכירה (${fILS(c.salePrice)})
+ קרן ששולמה (${fILS(c.loanAmount - c.closingBalance)})
+ תזרים שכ"ד מצטבר (${fILS(c.cumulativeRent)})
− הוצאות מצטברות (${fILS(c.cumulativeExpenses)})
− יתרת משכנתא (${fILS(c.closingBalance)})
− כסף שהושקע (${fILS(c.investedCash)})`
                        }>
                          <span>💰 רווח נקי (לפני תיווך ומיסים) <span className="text-xs opacity-50 cursor-help">(?)</span></span>
                        </Tooltip>
                      </td>
                      <td className={`px-4 py-3 text-right text-lg tabular-nums ${c.netProfit >= 0 ? 'text-emerald-700' : 'text-red-600'}`}>
                        {c.netProfit >= 0 ? '+' : ''}{fILS(c.netProfit)}
                      </td>
                      <td className={`px-4 py-3 text-right text-sm hidden md:table-cell ${c.netProfit >= 0 ? 'text-emerald-600' : 'text-red-500'}`}>
                        {fPct(c.roiOnEquity, 1)} על הון עצמי · {fPct(c.annualROI)}/שנה
                      </td>
                    </tr>

                    {/* Optional deductions shown separately */}
                    {(c.agentAmt > 0 || (d.includeCapitalGains && c.capitalGainsTax > 0)) && (
                      <>
                        <GroupRow icon="📋" label="הפחתות אופציונליות (לא נכללות ברווח)" />
                        {c.agentAmt > 0 && (
                          <CostRow label={`תיווך ביציאה (${d.agentPct}%)`} val={c.agentAmt} base={c.investedCash} isDebit />
                        )}
                        {d.includeCapitalGains && c.capitalGainsTax > 0 && (
                          <CostRow label="מס שבח (שיטה לינארית)" val={c.capitalGainsTax} base={c.investedCash} isDebit />
                        )}
                      </>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* ══ תזרים ══ */}
          {sub === 'cashflow' && (
            <div className="space-y-5">

              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <KPI label="תזרים חודשי נקי"
                  value={`${c.monthlyCashflow >= 0 ? '+' : ''}${fILS(c.monthlyCashflow)}`}
                  color={c.monthlyCashflow >= 0 ? 'text-green-700' : 'text-red-600'}
                  bg={c.monthlyCashflow >= 0 ? 'bg-green-50' : 'bg-red-50'} />
                <KPI label='תשואת שכ"ד (גולמי)' value={fPct(c.cashflowYield)}
                  bg="bg-blue-50" color="text-blue-800" />
                <KPI label="% תפוסה להפסקת הפסד" value={`${c.breakEvenOcc.toFixed(1)}%`}
                  bg="bg-orange-50" color="text-orange-700" />
                <KPI label='הכנסת שכ"ד שנתית' value={fILS(c.annualRent)}
                  sub={`${12 - d.vacancyMonths} חודשים אפקטיביים`}
                  bg="bg-green-50" color="text-green-700" />
              </div>

              {/* Monthly breakdown */}
              <div className="rounded-xl border border-gray-200 overflow-hidden">
                <table className="w-full text-sm">
                  <thead className="bg-gray-50">
                    <tr>
                      <th className="text-right px-4 py-2.5 font-semibold text-gray-600">סעיף</th>
                      <th className="text-right px-4 py-2.5 font-semibold text-gray-600">חודשי</th>
                      <th className="text-right px-4 py-2.5 font-semibold text-gray-600">שנתי</th>
                    </tr>
                  </thead>
                  <tbody>
                    <GroupRow icon="📥" label="הכנסות" />
                    <tr className="hover:bg-gray-50">
                      <td className="px-4 py-2 text-gray-700 pr-8">שכירות ({12 - d.vacancyMonths} חודשים)</td>
                      <td className="px-4 py-2 text-right text-green-600 tabular-nums font-medium">+{fILS(d.monthlyRent)}</td>
                      <td className="px-4 py-2 text-right text-green-600 tabular-nums font-medium">+{fILS(c.annualRent)}</td>
                    </tr>

                    <GroupRow icon="📤" label="הוצאות שוטפות" />
                    {(() => {
                      const rows = [
                        { label: 'החזר משכנתא (קרן + ריבית)', m: c.monthly },
                        { label: 'ביטוח מבנה',                 m: d.buildingInsuranceAnnual / 12 },
                        { label: 'ביטוח חיים',                 m: d.lifeInsuranceMonthly },
                        { label: 'תחזוקה ותיקונים',            m: d.maintenanceCostAnnual / 12 },
                        ...d.extraExpenses.map(e => ({ label: e.label, m: e.amountMonthly })),
                      ].filter(r => r.m > 0);
                      const LIMIT = 10;
                      const visible = cashflowExpanded ? rows : rows.slice(0, LIMIT);
                      const hidden  = rows.length - LIMIT;
                      return (
                        <>
                          {visible.map((r, i) => (
                            <tr key={i} className="hover:bg-gray-50">
                              <td className="px-4 py-2 text-gray-700 pr-8">{r.label}</td>
                              <td className="px-4 py-2 text-right text-red-500 tabular-nums">-{fILS(r.m)}</td>
                              <td className="px-4 py-2 text-right text-red-500 tabular-nums">-{fILS(r.m * 12)}</td>
                            </tr>
                          ))}
                          {rows.length > LIMIT && (
                            <tr>
                              <td colSpan={3} className="px-4 py-1.5">
                                <button
                                  onClick={() => setCashflowExpanded(v => !v)}
                                  className="flex items-center gap-1.5 text-xs text-blue-500 hover:text-blue-700 transition-colors"
                                >
                                  <span className={`transition-transform duration-150 ${cashflowExpanded ? 'rotate-180' : ''}`}>▾</span>
                                  {cashflowExpanded
                                    ? 'הסתר הוצאות'
                                    : `הצג עוד ${hidden} הוצאות`}
                                </button>
                              </td>
                            </tr>
                          )}
                        </>
                      );
                    })()}

                    <tr className={`font-bold border-t-2 ${c.annualCashflow >= 0 ? 'bg-green-50 border-green-200' : 'bg-red-50 border-red-200'}`}>
                      <td className={`px-4 py-3 text-base ${c.annualCashflow >= 0 ? 'text-green-800' : 'text-red-700'}`}>
                        תזרים נקי
                      </td>
                      <td className={`px-4 py-3 text-right text-lg tabular-nums ${c.annualCashflow >= 0 ? 'text-green-700' : 'text-red-600'}`}>
                        {c.monthlyCashflow >= 0 ? '+' : ''}{fILS(c.monthlyCashflow)}
                      </td>
                      <td className={`px-4 py-3 text-right text-lg tabular-nums ${c.annualCashflow >= 0 ? 'text-green-700' : 'text-red-600'}`}>
                        {c.annualCashflow >= 0 ? '+' : ''}{fILS(c.annualCashflow)}
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>

              {/* 5-year projection */}
              <div>
                <p className="text-sm font-semibold text-gray-700 mb-2">תחזית 5 שנים <span className="text-xs font-normal text-gray-400">(עליית שכ"ד {d.annualRentGrowthPct}%/שנה)</span></p>
                <div className="rounded-xl border border-gray-200 overflow-hidden">
                  <table className="w-full text-xs">
                    <thead className="bg-gray-50">
                      <tr>
                        {['שנה', 'שכ"ד שנתי', 'הוצאות', 'תזרים נקי', 'מצטבר'].map(h => (
                          <th key={h} className="text-right px-3 py-2.5 font-semibold text-gray-600">{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                      {Array.from({ length: 5 }, (_, i) => {
                        const rg = Math.pow(1 + d.annualRentGrowthPct / 100, i);
                        const yr = d.monthlyRent * rg * (12 - d.vacancyMonths);
                        const net = yr - c.annualExpenses;
                        const cumulative = Array.from({ length: i + 1 }, (_, j) =>
                          d.monthlyRent * Math.pow(1 + d.annualRentGrowthPct / 100, j) * (12 - d.vacancyMonths) - c.annualExpenses
                        ).reduce((a, b) => a + b, 0);
                        return (
                          <tr key={i} className={i % 2 === 0 ? 'bg-white' : 'bg-gray-50/60'}>
                            <td className="px-3 py-2 text-center font-semibold text-gray-700">{i + 1}</td>
                            <td className="px-3 py-2 text-right text-green-600">+{fILS(yr)}</td>
                            <td className="px-3 py-2 text-right text-red-500">-{fILS(c.annualExpenses)}</td>
                            <td className={`px-3 py-2 text-right font-semibold ${net >= 0 ? 'text-green-700' : 'text-red-600'}`}>
                              {net >= 0 ? '+' : ''}{fILS(net)}
                            </td>
                            <td className={`px-3 py-2 text-right font-medium ${cumulative >= 0 ? 'text-blue-700' : 'text-red-600'}`}>
                              {cumulative >= 0 ? '+' : ''}{fILS(cumulative)}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}

          {/* ══ לוח סילוקין ══ */}
          {sub === 'amortization' && (
            <div className="space-y-4">
              {c.loanAmount === 0 ? (
                <p className="text-center text-gray-400 py-10 text-sm">
                  הזן הון עצמי הנמוך ממחיר הקנייה כדי לצפות בלוח הסילוקין
                </p>
              ) : (
                <>
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                    <KPI label="קרן הלוואה" value={fILS(c.loanAmount)} bg="bg-blue-50" color="text-blue-800" />
                    <KPI label="תשלום חודשי" value={fILS(c.monthly)} bg="bg-indigo-50" color="text-indigo-800" />
                    <KPI label="סה&quot;כ ריבית" value={fILS(c.totalInterest)} color="text-red-700" bg="bg-red-50" />
                    <KPI label="סה&quot;כ תשלומים" value={fILS(c.totalPmts)} bg="bg-gray-50" />
                  </div>

                  <div className="rounded-xl border border-gray-200 overflow-x-auto">
                    <table className="w-full text-xs whitespace-nowrap">
                      <thead className="bg-gray-50">
                        <tr>
                          {['חודש', 'יתרה פתיחה', 'תשלום', 'קרן', 'ריבית', 'יתרה סגירה', '% ריבית'].map(h => (
                            <th key={h} className="text-right px-3 py-2.5 font-semibold text-gray-600">{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-100">
                        {amorSlice.map(row => (
                          <tr key={row.month} className={
                            row.month % 12 === 0 ? 'bg-blue-50 font-semibold' : 'hover:bg-gray-50'
                          }>
                            <td className="px-3 py-1.5 text-center font-medium text-gray-700">
                              {row.month}
                              {row.month % 12 === 0 && (
                                <span className="text-blue-500 text-xs mr-1"> · שנה {row.month / 12}</span>
                              )}
                            </td>
                            <td className="px-3 py-1.5 text-right tabular-nums text-gray-500">{fILS(row.opening)}</td>
                            <td className="px-3 py-1.5 text-right tabular-nums font-medium">{fILS(row.payment)}</td>
                            <td className="px-3 py-1.5 text-right tabular-nums text-green-600">{fILS(row.principal)}</td>
                            <td className="px-3 py-1.5 text-right tabular-nums text-red-500">{fILS(row.interest)}</td>
                            <td className="px-3 py-1.5 text-right tabular-nums text-blue-700">{fILS(row.closing)}</td>
                            <td className="px-3 py-1.5 text-right text-gray-400">
                              {row.payment > 0 ? ((row.interest / row.payment) * 100).toFixed(1) : '0'}%
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>

                  {/* Pagination */}
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-gray-400">
                      חודשים {page * AMOR_PAGE + 1}–{Math.min((page + 1) * AMOR_PAGE, c.amortSched.length)} מתוך {c.amortSched.length}
                    </span>
                    <div className="flex gap-2">
                      <button disabled={page === 0} onClick={() => setPage(p => p - 1)}
                        className="px-3 py-1.5 border border-gray-200 rounded-lg disabled:opacity-30 hover:bg-gray-50">
                        → קודם
                      </button>
                      <button disabled={page >= amorPages - 1} onClick={() => setPage(p => p + 1)}
                        className="px-3 py-1.5 border border-gray-200 rounded-lg disabled:opacity-30 hover:bg-gray-50">
                        הבא ←
                      </button>
                    </div>
                  </div>
                </>
              )}
            </div>
          )}

          {/* ══ תמהיל משכנתא ══ */}
          {sub === 'mortgage_mix' && (
            <div className="space-y-5">

              {/* Summary KPIs */}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <KPI label="קרן הלוואה הכוללת" value={fILS(c.loanAmount)} bg="bg-blue-50" color="text-blue-800" />
                <KPI label="תשלום PMT (מסלול יחיד)"
                  value={fILS(pmt(c.loanAmount, d.interestRate, d.loanTermYears))}
                  sub={`${d.interestRate}% · ${d.loanTermYears} שנה`}
                  bg="bg-gray-50" color="text-gray-700" />
                {d.mortgageTracks.length > 0 && (
                  <>
                    <KPI label={'תשלום ע"פ תמהיל'}
                      value={fILS(d.mortgageTracks.reduce((s, t) => s + t.monthlyPayment, 0))}
                      sub={`${d.mortgageTracks.length} מסלולים`}
                      bg="bg-indigo-50" color="text-indigo-800" />
                    <KPI label={'יתרה כוללת (ע"פ תמהיל)'}
                      value={fILS(d.mortgageTracks.reduce((s, t) => s + t.outstanding, 0))}
                      bg="bg-orange-50" color="text-orange-700" />
                  </>
                )}
              </div>

              {d.mortgageTracks.length > 0 && (
                <p className="text-xs text-indigo-600 bg-indigo-50 rounded-lg px-3 py-2">
                  ✅ התזרים וחישובי הרווח משתמשים בתשלום מהתמהיל ({fILS(d.mortgageTracks.reduce((s, t) => s + t.monthlyPayment, 0))}/חודש) במקום ה-PMT הנ"ל.
                </p>
              )}

              {/* Tracks table */}
              {d.mortgageTracks.length > 0 && (
                <div className="rounded-xl border border-gray-200 overflow-hidden">
                  <table className="w-full text-sm">
                    <thead className="bg-gray-50">
                      <tr>
                        {['מסלול', 'קרן (₪)', 'יתרה (₪)', 'ריבית', 'החזר/חודש', 'חודשים נותרים', ''].map(h => (
                          <th key={h} className="text-right px-3 py-2.5 font-semibold text-gray-600 text-xs">{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                      {d.mortgageTracks.map(track => {
                        const isEditing = editingTrackId === track.id;
                        if (isEditing) return (
                          <tr key={track.id} className="bg-yellow-50">
                            <td colSpan={7} className="px-3 py-3">
                              <TrackForm
                                draft={trackDraft}
                                onChange={setTrackDraft}
                                onSave={() => {
                                  const principal  = parseFloat(trackDraft.principal)  || track.principal;
                                  const interestRate = parseFloat(trackDraft.interestRate) || track.interestRate;
                                  const monthsTotal  = parseInt(trackDraft.monthsTotal)  || track.monthsTotal;
                                  const outstanding  = parseFloat(trackDraft.outstanding) || track.outstanding;
                                  const autoPayment  = monthsTotal > 0
                                    ? pmt(principal, interestRate, monthsTotal / 12)
                                    : 0;
                                  const monthlyPayment = parseFloat(trackDraft.monthlyPayment) || autoPayment;
                                  const updated: MortgageTrack = {
                                    ...track,
                                    name:      trackDraft.name || track.name,
                                    trackType: trackDraft.trackType,
                                    principal, outstanding, interestRate, monthsTotal,
                                    monthlyPayment,
                                    monthsRemaining: monthsTotal,
                                  };
                                  set({ mortgageTracks: d.mortgageTracks.map(t => t.id === track.id ? updated : t) });
                                  setEditingTrackId(null);
                                }}
                                onCancel={() => setEditingTrackId(null)}
                              />
                            </td>
                          </tr>
                        );
                        return (
                          <tr key={track.id} className="hover:bg-gray-50">
                            <td className="px-3 py-2">
                              <div className="flex items-center gap-1.5">
                                <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${TRACK_TYPE_COLORS[track.trackType]}`}>
                                  {TRACK_TYPE_LABELS[track.trackType]}
                                </span>
                                {track.name && track.name !== TRACK_TYPE_LABELS[track.trackType] && (
                                  <span className="text-xs text-gray-500">{track.name}</span>
                                )}
                              </div>
                            </td>
                            <td className="px-3 py-2 text-right tabular-nums text-gray-700">{fILS(track.principal)}</td>
                            <td className="px-3 py-2 text-right tabular-nums text-orange-600">{fILS(track.outstanding)}</td>
                            <td className="px-3 py-2 text-right tabular-nums text-gray-600">{track.interestRate.toFixed(2)}%</td>
                            <td className="px-3 py-2 text-right tabular-nums font-semibold text-red-500">{fILS(track.monthlyPayment)}</td>
                            <td className="px-3 py-2 text-right tabular-nums text-gray-500">{track.monthsRemaining}</td>
                            <td className="px-3 py-2">
                              <div className="flex items-center gap-1.5 justify-end">
                                <button
                                  onClick={() => {
                                    setTrackDraft({
                                      name: track.name,
                                      trackType: track.trackType,
                                      principal: String(track.principal),
                                      outstanding: String(track.outstanding),
                                      interestRate: String(track.interestRate),
                                      monthsTotal: String(track.monthsTotal),
                                      monthlyPayment: String(track.monthlyPayment),
                                    });
                                    setEditingTrackId(track.id);
                                    setAddingTrack(false);
                                  }}
                                  className="text-xs text-blue-500 hover:text-blue-700 px-1.5 py-0.5 rounded hover:bg-blue-50"
                                >
                                  עריכה
                                </button>
                                <button
                                  onClick={() => set({ mortgageTracks: d.mortgageTracks.filter(t => t.id !== track.id) })}
                                  className="text-xs text-red-400 hover:text-red-600 px-1.5 py-0.5 rounded hover:bg-red-50"
                                >
                                  ✕
                                </button>
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                    <tfoot className="bg-gray-50 border-t-2 border-gray-200 font-semibold text-sm">
                      <tr>
                        <td className="px-3 py-2 text-gray-600">סה"כ</td>
                        <td className="px-3 py-2 text-right text-blue-700">{fILS(d.mortgageTracks.reduce((s, t) => s + t.principal, 0))}</td>
                        <td className="px-3 py-2 text-right text-orange-600">{fILS(d.mortgageTracks.reduce((s, t) => s + t.outstanding, 0))}</td>
                        <td className="px-3 py-2 text-right text-gray-500">
                          {d.mortgageTracks.length > 0
                            ? `${(d.mortgageTracks.reduce((s, t) => s + t.interestRate * t.principal, 0) / d.mortgageTracks.reduce((s, t) => s + t.principal, 0)).toFixed(2)}% ממוצע`
                            : '—'}
                        </td>
                        <td className="px-3 py-2 text-right text-red-600">{fILS(d.mortgageTracks.reduce((s, t) => s + t.monthlyPayment, 0))}</td>
                        <td colSpan={2} />
                      </tr>
                    </tfoot>
                  </table>
                </div>
              )}

              {/* Add track form */}
              {addingTrack && (
                <TrackForm
                  draft={trackDraft}
                  onChange={setTrackDraft}
                  onSave={() => {
                    const principal    = parseFloat(trackDraft.principal)    || 0;
                    const interestRate = parseFloat(trackDraft.interestRate) || 0;
                    const monthsTotal  = parseInt(trackDraft.monthsTotal)    || 0;
                    const outstanding  = parseFloat(trackDraft.outstanding)  || principal;
                    const autoPayment  = monthsTotal > 0 && principal > 0
                      ? pmt(principal, interestRate, monthsTotal / 12)
                      : 0;
                    const monthlyPayment = parseFloat(trackDraft.monthlyPayment) || autoPayment;
                    const ttype = trackDraft.trackType;
                    const newTrack: MortgageTrack = {
                      id:              `trk-${Date.now()}`,
                      name:            trackDraft.name || TRACK_TYPE_LABELS[ttype],
                      trackType:       ttype,
                      principal, outstanding, interestRate,
                      monthlyPayment,
                      monthsTotal,
                      monthsRemaining: monthsTotal,
                    };
                    set({ mortgageTracks: [...d.mortgageTracks, newTrack] });
                    setAddingTrack(false);
                    setTrackDraft({ name: '', trackType: 'fixed', principal: '', outstanding: '', interestRate: '', monthsTotal: '', monthlyPayment: '' });
                  }}
                  onCancel={() => {
                    setAddingTrack(false);
                    setTrackDraft({ name: '', trackType: 'fixed', principal: '', outstanding: '', interestRate: '', monthsTotal: '', monthlyPayment: '' });
                  }}
                />
              )}

              {!addingTrack && editingTrackId === null && (
                <button
                  onClick={() => {
                    setAddingTrack(true);
                    setEditingTrackId(null);
                  }}
                  className="flex items-center gap-2 px-4 py-2.5 border-2 border-dashed border-gray-300 rounded-xl text-sm text-gray-500 hover:border-blue-400 hover:text-blue-600 transition-colors w-full justify-center"
                >
                  + הוסף מסלול משכנתא
                </button>
              )}

              {d.mortgageTracks.length === 0 && !addingTrack && (
                <p className="text-xs text-gray-400 text-center py-2">
                  לחץ "+ הוסף מסלול" להגדרת תמהיל המשכנתא. כל עוד אין מסלולים, מחשבים לפי PMT יחיד.
                </p>
              )}

              {/* Distribute helper */}
              {d.mortgageTracks.length === 0 && c.loanAmount > 0 && !addingTrack && (
                <div className="bg-blue-50 rounded-xl px-4 py-3 text-xs text-blue-700">
                  <p className="font-semibold mb-1">💡 טיפ: תמהיל מקובל בישראל</p>
                  <p>לדוגמה: 30% פריים + 30% קל"צ + 40% קבוע</p>
                  <div className="flex gap-2 mt-2 flex-wrap">
                    {([
                      { type: 'prime' as const,    pct: 30, rate: 3.5, months: 300 },
                      { type: 'cpi' as const,      pct: 30, rate: 3.0, months: 300 },
                      { type: 'fixed' as const,    pct: 40, rate: 5.0, months: 300 },
                    ]).map(t => {
                      const p = Math.round(c.loanAmount * t.pct / 100 / 10000) * 10000;
                      const mp = pmt(p, t.rate, t.months / 12);
                      return (
                        <button
                          key={t.type}
                          onClick={() => set({
                            mortgageTracks: [...d.mortgageTracks, {
                              id: `trk-${Date.now()}-${t.type}`,
                              name: TRACK_TYPE_LABELS[t.type],
                              trackType: t.type,
                              principal: p, outstanding: p,
                              interestRate: t.rate,
                              monthlyPayment: mp,
                              monthsTotal: t.months,
                              monthsRemaining: t.months,
                            }],
                          })}
                          className="px-2 py-1 bg-blue-100 hover:bg-blue-200 rounded-lg font-medium transition-colors"
                        >
                          + {TRACK_TYPE_LABELS[t.type]} {t.pct}% ({fILS(p)})
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          )}

        </div>
      </div>

      {/* ── Save to portfolio ── */}
      <div className="bg-white rounded-xl border border-gray-200 p-5">
        <h4 className="text-sm font-semibold text-gray-700 mb-3">💾 שמור נכס בתיק</h4>
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex-1 min-w-48">
            <label className="block text-xs text-gray-500 mb-1">שם הנכס</label>
            <input
              type="text"
              value={dealName}
              onChange={e => setDealName(e.target.value)}
              placeholder={`נכס ${fILS(d.purchasePrice)}`}
              className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500"
            />
          </div>
          <button
            onClick={saveToPortfolio}
            className="px-5 py-2 bg-emerald-600 text-white rounded-lg text-sm font-semibold hover:bg-emerald-700 transition-colors shadow-sm"
          >
            שמור בתיק נכסים
          </button>
          {saveMsg && (
            <span className="text-sm text-emerald-600 font-medium">{saveMsg}</span>
          )}
        </div>
        <p className="text-xs text-gray-400 mt-2">
          יוסיף נכס נדל"ן עם מחיר קנייה {fILS(d.purchasePrice)} ושכירות {fILS(d.monthlyRent)}/חודש
          {c.loanAmount > 0 ? ` + משכנתא של ${fILS(c.loanAmount)}` : ''} לתיק הנכסים
        </p>
      </div>

    </div>
  );
};

// ── Track type helpers ────────────────────────────────────────────────────────
const TRACK_TYPE_LABELS: Record<MortgageTrack['trackType'], string> = {
  prime: 'פריים', fixed: 'קבוע', cpi: 'קל"צ', variable: 'משתנה', other: 'אחר',
};

const TRACK_TYPE_COLORS: Record<MortgageTrack['trackType'], string> = {
  prime:    'bg-blue-100 text-blue-700',
  fixed:    'bg-green-100 text-green-700',
  cpi:      'bg-orange-100 text-orange-700',
  variable: 'bg-purple-100 text-purple-700',
  other:    'bg-gray-100 text-gray-700',
};

interface TrackDraft {
  name: string; trackType: MortgageTrack['trackType'];
  principal: string; outstanding: string;
  interestRate: string; monthsTotal: string; monthlyPayment: string;
}

const TrackForm: FC<{
  draft: TrackDraft;
  onChange: (d: TrackDraft) => void;
  onSave: () => void;
  onCancel: () => void;
}> = ({ draft, onChange, onSave, onCancel }) => {
  // Auto-compute monthly payment when principal/rate/months change
  const autoPayment = (() => {
    const p = parseFloat(draft.principal) || 0;
    const r = parseFloat(draft.interestRate) || 0;
    const m = parseInt(draft.monthsTotal) || 0;
    if (p > 0 && r > 0 && m > 0) {
      const mr = r / 100 / 12;
      return p * mr * Math.pow(1 + mr, m) / (Math.pow(1 + mr, m) - 1);
    }
    return 0;
  })();

  return (
    <div className="border border-blue-200 rounded-xl p-4 bg-blue-50/30 space-y-3">
      <p className="text-xs font-semibold text-blue-700">הוספת / עריכת מסלול</p>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <div>
          <label className="block text-xs text-gray-500 mb-1">סוג מסלול</label>
          <select
            value={draft.trackType}
            onChange={e => onChange({ ...draft, trackType: e.target.value as MortgageTrack['trackType'] })}
            className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white"
          >
            {(Object.keys(TRACK_TYPE_LABELS) as MortgageTrack['trackType'][]).map(t => (
              <option key={t} value={t}>{TRACK_TYPE_LABELS[t]}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-xs text-gray-500 mb-1">שם (אופציונלי)</label>
          <input type="text" value={draft.name} onChange={e => onChange({ ...draft, name: e.target.value })}
            placeholder={TRACK_TYPE_LABELS[draft.trackType]}
            className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
        </div>
        <div>
          <label className="block text-xs text-gray-500 mb-1">קרן (₪)</label>
          <input type="number" step="10000" value={draft.principal} onChange={e => onChange({ ...draft, principal: e.target.value })}
            placeholder="0"
            className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
        </div>
        <div>
          <label className="block text-xs text-gray-500 mb-1">יתרה נוכחית (₪)</label>
          <input type="number" step="10000" value={draft.outstanding} onChange={e => onChange({ ...draft, outstanding: e.target.value })}
            placeholder="= קרן"
            className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
        </div>
        <div>
          <label className="block text-xs text-gray-500 mb-1">ריבית שנתית (%)</label>
          <input type="number" step="0.1" value={draft.interestRate} onChange={e => onChange({ ...draft, interestRate: e.target.value })}
            placeholder="4.5"
            className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
        </div>
        <div>
          <label className="block text-xs text-gray-500 mb-1">מספר חודשים</label>
          <input type="number" step="12" value={draft.monthsTotal} onChange={e => onChange({ ...draft, monthsTotal: e.target.value })}
            placeholder="300"
            className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
        </div>
        <div>
          <label className="block text-xs text-gray-500 mb-1">
            תשלום חודשי (₪)
            {autoPayment > 0 && (
              <button onClick={() => onChange({ ...draft, monthlyPayment: autoPayment.toFixed(0) })}
                className="mr-1 text-blue-500 hover:text-blue-700 text-xs underline">
                מחשב: {new Intl.NumberFormat('he-IL', { maximumFractionDigits: 0 }).format(autoPayment)}
              </button>
            )}
          </label>
          <input type="number" step="100" value={draft.monthlyPayment} onChange={e => onChange({ ...draft, monthlyPayment: e.target.value })}
            placeholder={autoPayment > 0 ? autoPayment.toFixed(0) : '0'}
            className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
        </div>
      </div>
      <div className="flex gap-2">
        <button onClick={onSave}
          className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 transition-colors">
          שמור מסלול
        </button>
        <button onClick={onCancel}
          className="px-4 py-2 bg-gray-100 text-gray-600 rounded-lg text-sm font-medium hover:bg-gray-200 transition-colors">
          ביטול
        </button>
      </div>
    </div>
  );
};

// ── Helper row components ─────────────────────────────────────────────────────
const GroupRow: FC<{ icon: string; label: string }> = ({ icon, label }) => (
  <tr className="bg-gray-50">
    <td colSpan={3} className="px-4 py-1.5 text-xs font-semibold text-gray-500 uppercase tracking-wide">
      {icon} {label}
    </td>
  </tr>
);

const CostRow: FC<{ label: string; val: number; base: number; isDebit: boolean }> = ({
  label, val, base, isDebit,
}) => (
  <tr className="hover:bg-gray-50">
    <td className="px-4 py-2 text-gray-700 pr-8">{label}</td>
    <td className={`px-4 py-2 text-right tabular-nums font-medium ${isDebit ? 'text-red-500' : 'text-green-600'}`}>
      {isDebit ? '-' : '+'}{fILS(val)}
    </td>
    <td className="px-4 py-2 text-right text-xs text-gray-400 hidden md:table-cell">
      {base > 0 ? `${((val / base) * 100).toFixed(1)}%` : '—'}
    </td>
  </tr>
);

const SubtotalRow: FC<{ label: string; val: number; positive: boolean }> = ({ label, val, positive }) => (
  <tr className={`font-semibold border-t border-gray-200 ${positive ? 'bg-green-50' : 'bg-blue-50'}`}>
    <td className={`px-4 py-2 ${positive ? 'text-green-800' : 'text-blue-800'}`}>{label}</td>
    <td className={`px-4 py-2 text-right tabular-nums ${positive ? 'text-green-700' : 'text-red-600'}`}>
      {positive ? '+' : '-'}{fILS(val)}
    </td>
    <td />
  </tr>
);

export default DealTab;
