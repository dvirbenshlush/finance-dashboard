import { type FC, useState, useRef, useMemo } from 'react';
import type { Asset, Loan, MortgageTrack, Portfolio } from '../../types';
import { api } from '../../services/api';

// ── Formatters ────────────────────────────────────────────────────────────────
const fILS = (v: number) =>
  new Intl.NumberFormat('he-IL', { style: 'currency', currency: 'ILS', maximumFractionDigits: 0 }).format(v);
const fUSD = (v: number) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(v);

const USD_TO_ILS = 3.73;
const toILS = (a: Asset) => (a.currency === 'USD' ? a.value * USD_TO_ILS : a.value);
const loanToILS = (v: number, cur: 'ILS' | 'USD') => cur === 'USD' ? v * USD_TO_ILS : v;

// ── Cost types ────────────────────────────────────────────────────────────────
type CostCategory =
  | 'management' | 'insurance' | 'municipal_tax' | 'maintenance'
  | 'building_committee' | 'brokerage' | 'lawyer' | 'appraiser'
  | 'inspector' | 'mortgage_advisor' | 'other';

type CostFrequency = 'monthly' | 'annual' | 'one_time';

interface PropertyCost {
  id: string;
  category: CostCategory;
  name: string;
  amount: number;
  frequency: CostFrequency;
  currency: 'ILS' | 'USD';
  notes?: string;
}

interface PropertyDoc {
  id: string;
  assetId: string;
  filename: string;
  docType: 'clearing_report' | 'insurance' | 'municipal_tax' | 'other';
  date: string;
  amount?: number;
  notes?: string;
}

interface PropSettings {
  appreciationRate: number;
  vacancyMonths: number;
}

// ── Constants ─────────────────────────────────────────────────────────────────
const LS_COSTS     = 'otzar_property_costs';
const LS_DOCS      = 'otzar_property_docs';
const LS_PROP_SETS = 'otzar_property_settings';

const COST_META: Record<CostCategory, { label: string; icon: string }> = {
  management:        { label: 'חברת ניהול',      icon: '🏢' },
  insurance:         { label: 'ביטוח',            icon: '🛡️' },
  municipal_tax:     { label: 'ארנונה',           icon: '🏛️' },
  maintenance:       { label: 'תחזוקה ותיקונים',  icon: '🔧' },
  building_committee:{ label: 'ועד בית',          icon: '🏗️' },
  brokerage:         { label: 'תיווך',            icon: '🤝' },
  lawyer:            { label: 'עורך דין',          icon: '⚖️' },
  appraiser:         { label: 'שמאי',             icon: '📐' },
  inspector:         { label: 'בודק נכסים',        icon: '🔍' },
  mortgage_advisor:  { label: 'יועץ משכנאות',      icon: '📋' },
  other:             { label: 'אחר',              icon: '📝' },
};

const FREQ_LABEL: Record<CostFrequency, string> = {
  monthly: 'חודשי', annual: 'שנתי', one_time: 'חד פעמי',
};

const DOC_TYPE_LABEL: Record<PropertyDoc['docType'], string> = {
  clearing_report: 'דוח סליקה',
  insurance: 'פוליסת ביטוח',
  municipal_tax: 'ארנונה',
  other: 'אחר',
};

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

// ── Helpers ───────────────────────────────────────────────────────────────────
function loadLS<T>(key: string, fallback: T): T {
  try { const r = localStorage.getItem(key); return r ? JSON.parse(r) as T : fallback; }
  catch { return fallback; }
}

function toAnnualILS(c: PropertyCost): number {
  const amt = c.currency === 'USD' ? c.amount * USD_TO_ILS : c.amount;
  return c.frequency === 'monthly' ? amt * 12 : c.frequency === 'annual' ? amt : 0;
}

interface Forecast {
  annualGrossILS: number;
  annualCostsILS: number;    // manual costs only (no mortgage)
  annualMortgageILS: number; // from linked loans
  annualNetILS: number;      // gross - manual costs - mortgage
  grossYield: number;
  netYield: number;
  annualAppreciationILS: number;
  totalAnnualILS: number;
  totalYield: number;
  oneTimeILS: number;
  valueILS: number;
}

function calcForecast(
  asset: Asset,
  costs: PropertyCost[],
  settings: PropSettings,
  linkedLoans: Loan[],
): Forecast {
  const valueILS = asset.currency === 'USD' ? asset.value * USD_TO_ILS : asset.value;
  const rent = asset.monthlyRentalIncome ?? 0;
  const effectiveMonths = Math.max(0, 12 - (settings.vacancyMonths ?? 0));
  const annualGrossILS = (asset.currency === 'USD' ? rent * USD_TO_ILS : rent) * effectiveMonths;

  const recurring = costs.filter(c => c.frequency !== 'one_time');
  const oneTime   = costs.filter(c => c.frequency === 'one_time');
  const annualCostsILS = recurring.reduce((s, c) => s + toAnnualILS(c), 0);
  const oneTimeILS     = oneTime.reduce((s, c) =>
    s + (c.currency === 'USD' ? c.amount * USD_TO_ILS : c.amount), 0);

  // Mortgage: sum of all linked loans' monthly payments × 12
  const monthlyMortgage = linkedLoans.reduce((s, l) => {
    const monthly = l.tracks && l.tracks.length > 0
      ? l.tracks.reduce((ts, t) => ts + t.monthlyPayment, 0)
      : l.monthlyPayment;
    return s + loanToILS(monthly, l.currency);
  }, 0);
  const annualMortgageILS = monthlyMortgage * 12;

  const annualNetILS  = annualGrossILS - annualCostsILS - annualMortgageILS;
  const grossYield    = valueILS > 0 ? (annualGrossILS   / valueILS) * 100 : 0;
  const netYield      = valueILS > 0 ? (annualNetILS     / valueILS) * 100 : 0;
  const annualAppreciationILS = valueILS * ((settings.appreciationRate ?? 3) / 100);
  const totalAnnualILS = annualNetILS + annualAppreciationILS;
  const totalYield     = valueILS > 0 ? (totalAnnualILS / valueILS) * 100 : 0;

  return { annualGrossILS, annualCostsILS, annualMortgageILS, annualNetILS, grossYield, netYield, annualAppreciationILS, totalAnnualILS, totalYield, oneTimeILS, valueILS };
}

// ── Default assets ────────────────────────────────────────────────────────────
const DEFAULT_ASSETS: Asset[] = [
  { id: 'asset-1', name: 'דירה בראשון לציון', type: 'real_estate', value: 2_200_000, currency: 'ILS',
    address: 'ראשון לציון, ישראל', propertyType: 'apartment', purchasePrice: 1_500_000, monthlyRentalIncome: 0 },
  { id: 'asset-2', name: 'נכס בקליבלנד, אוהיו', type: 'real_estate', value: 180_000, currency: 'USD',
    address: 'Cleveland, Ohio, USA', propertyType: 'house', purchasePrice: 120_000, monthlyRentalIncome: 0 },
  { id: 'asset-5', name: 'קרן פנסיה',    type: 'savings', value: 0, currency: 'ILS', savingsType: 'pension' },
  { id: 'asset-6', name: 'קרן השתלמות', type: 'savings', value: 0, currency: 'ILS', savingsType: 'keren_hishtalmut' },
];

// ── Sub-components ────────────────────────────────────────────────────────────
const NF: FC<{ label: string; value: number; onChange: (v: string) => void; step?: string }> = ({
  label, value, onChange, step = '1000',
}) => (
  <div>
    <label className="block text-xs text-gray-500 mb-1">{label}</label>
    <input type="number" step={step} value={value} onChange={e => onChange(e.target.value)}
      className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
  </div>
);

const KPI: FC<{ label: string; value: string; sub?: string; color?: string; bg?: string }> = ({
  label, value, sub, color = 'text-gray-800', bg = 'bg-gray-50',
}) => (
  <div className={`${bg} rounded-xl p-3`}>
    <p className="text-xs text-gray-500 mb-0.5">{label}</p>
    <p className={`text-base font-bold ${color}`}>{value}</p>
    {sub && <p className="text-xs text-gray-400 mt-0.5">{sub}</p>}
  </div>
);

// ── Props ─────────────────────────────────────────────────────────────────────
interface AssetsTabProps {
  portfolio: Portfolio;
  onPortfolioChange: (p: Portfolio) => void;
}

// ── Main component ─────────────────────────────────────────────────────────────
const AssetsTab: FC<AssetsTabProps> = ({ portfolio, onPortfolioChange }) => {
  const [assets, setAssets] = useState<Asset[]>(() => {
    // Use portfolio assets if non-empty, else defaults
    return portfolio.assets.length > 0 ? portfolio.assets : DEFAULT_ASSETS;
  });

  const [allCosts,     setAllCosts]     = useState<Record<string, PropertyCost[]>>(() => loadLS(LS_COSTS,     {}));
  const [allDocs,      setAllDocs]      = useState<Record<string, PropertyDoc[]>> (() => loadLS(LS_DOCS,      {}));
  const [propSettings, setPropSettings] = useState<Record<string, PropSettings>>  (() => loadLS(LS_PROP_SETS, {}));

  // UI state
  const [expandedId,    setExpandedId]    = useState<string | null>(null);
  const [expandSection, setExpandSection] = useState<Record<string, 'costs' | 'mortgage' | null>>({});
  const [editingCost,   setEditingCost]   = useState<{ assetId: string; cost: PropertyCost } | null>(null);
  const [addingCostFor, setAddingCostFor] = useState<string | null>(null);
  const [costDraft,     setCostDraft]     = useState<Partial<PropertyCost & { amount: string }>>({});
  const [addingDocFor,  setAddingDocFor]  = useState<string | null>(null);
  const [docDraft,      setDocDraft]      = useState<Partial<PropertyDoc & { amount: string }>>({});
  const [pendingFile,   setPendingFile]   = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // PDF doc analysis
  interface ExtractedCostItem {
    category: string; name: string; amount: number;
    frequency: string; currency: string; confidence: string;
    selected: boolean;
  }
  const [pdfParsing,  setPdfParsing]  = useState<string | null>(null); // assetId being parsed
  const [pdfPreview,  setPdfPreview]  = useState<{
    assetId: string; filename: string; summary: string;
    items: ExtractedCostItem[];
  } | null>(null);

  // Mortgage track editing
  const [editingTrack, setEditingTrack] = useState<{ loanId: string; track: MortgageTrack } | null>(null);
  const [addingTrackFor, setAddingTrackFor] = useState<string | null>(null); // loanId
  const [trackDraft, setTrackDraft] = useState<Partial<MortgageTrack & { monthlyPayment: string; outstanding: string; interestRate: string }>>({});

  // ── Asset helpers ──────────────────────────────────────────────────────────
  const NUM_FIELDS: (keyof Asset)[] = ['value','units','pricePerUnit','avgBuyPrice','purchasePrice','monthlyRentalIncome'];

  const removeAsset = (id: string) => {
    const nextAssets = assets.filter(a => a.id !== id);
    const nextLoans  = portfolio.loans.filter(l => l.linkedAssetId !== id);
    const totalAssetsILS      = nextAssets.reduce((s, a) => s + toILS(a), 0);
    const totalLiabilitiesILS = nextLoans.reduce((s, l) => s + loanToILS(l.outstanding, l.currency), 0);
    setAssets(nextAssets);
    onPortfolioChange({
      ...portfolio, assets: nextAssets, loans: nextLoans,
      totalAssetsILS, totalLiabilitiesILS,
      netWorthILS: totalAssetsILS - totalLiabilitiesILS,
    });
  };

  const updateAsset = (id: string, field: keyof Asset, rawValue: string) => {
    setAssets(prev => {
      const next = prev.map(a => {
        if (a.id !== id) return a;
        const parsed = NUM_FIELDS.includes(field) ? (parseFloat(rawValue) || 0) : rawValue;
        const updated: Asset = { ...a, [field]: parsed };
        if (updated.type === 'stock') updated.value = (updated.units ?? 0) * (updated.pricePerUnit ?? 0);
        return updated;
      });
      const totalAssetsILS = next.reduce((s, a) => s + toILS(a), 0);
      onPortfolioChange({ ...portfolio, assets: next, totalAssetsILS,
        netWorthILS: totalAssetsILS - portfolio.totalLiabilitiesILS });
      return next;
    });
  };

  // ── Cost helpers ───────────────────────────────────────────────────────────
  const saveCosts = (assetId: string, costs: PropertyCost[]) => {
    const next = { ...allCosts, [assetId]: costs };
    setAllCosts(next);
    localStorage.setItem(LS_COSTS, JSON.stringify(next));
  };

  const commitCost = (assetId: string, isEdit: boolean) => {
    const base = isEdit ? editingCost!.cost : {} as Partial<PropertyCost>;
    const cat = (costDraft.category ?? base.category ?? 'other') as CostCategory;
    const merged: PropertyCost = {
      id:        base.id ?? `cost-${Date.now()}`,
      category:  cat,
      name:      costDraft.name ?? base.name ?? COST_META[cat]?.label ?? '',
      amount:    parseFloat(String(costDraft.amount ?? base.amount ?? 0)) || 0,
      frequency: (costDraft.frequency ?? base.frequency ?? 'monthly') as CostFrequency,
      currency:  (costDraft.currency  ?? base.currency  ?? 'ILS') as 'ILS' | 'USD',
      notes:     costDraft.notes ?? base.notes,
    };
    if (!merged.name) merged.name = COST_META[merged.category]?.label ?? '';
    const existing = allCosts[assetId] ?? [];
    saveCosts(assetId, isEdit ? existing.map(c => c.id === merged.id ? merged : c) : [...existing, merged]);
    setEditingCost(null); setAddingCostFor(null); setCostDraft({});
  };

  const deleteCost = (assetId: string, id: string) =>
    saveCosts(assetId, (allCosts[assetId] ?? []).filter(c => c.id !== id));

  // ── Doc helpers ────────────────────────────────────────────────────────────
  const saveDocs = (assetId: string, docs: PropertyDoc[]) => {
    const next = { ...allDocs, [assetId]: docs };
    setAllDocs(next);
    localStorage.setItem(LS_DOCS, JSON.stringify(next));
  };

  const commitDoc = (assetId: string) => {
    if (!pendingFile || !docDraft.docType || !docDraft.date) return;
    saveDocs(assetId, [...(allDocs[assetId] ?? []), {
      id: `doc-${Date.now()}`, assetId,
      filename: pendingFile,
      docType: docDraft.docType as PropertyDoc['docType'],
      date: docDraft.date,
      amount: docDraft.amount ? parseFloat(String(docDraft.amount)) : undefined,
      notes: docDraft.notes,
    }]);
    setAddingDocFor(null); setDocDraft({}); setPendingFile(null);
  };

  const deleteDoc = (assetId: string, id: string) =>
    saveDocs(assetId, (allDocs[assetId] ?? []).filter(d => d.id !== id));

  // ── Settings ───────────────────────────────────────────────────────────────
  const getSettings = (id: string): PropSettings =>
    propSettings[id] ?? { appreciationRate: 3, vacancyMonths: 0 };

  const updateSettings = (id: string, patch: Partial<PropSettings>) => {
    const next = { ...propSettings, [id]: { ...getSettings(id), ...patch } };
    setPropSettings(next);
    localStorage.setItem(LS_PROP_SETS, JSON.stringify(next));
  };

  // ── Mortgage track helpers ─────────────────────────────────────────────────
  const updateLoans = (loans: Loan[]) => {
    const totalAssetsILS = assets.reduce((s, a) => s + toILS(a), 0);
    const totalLiabilitiesILS = loans.reduce((s, l) => s + loanToILS(l.outstanding, l.currency), 0);
    onPortfolioChange({ ...portfolio, loans, totalLiabilitiesILS,
      netWorthILS: totalAssetsILS - totalLiabilitiesILS });
  };

  const commitTrack = (loanId: string, isEdit: boolean) => {
    const base = isEdit ? editingTrack!.track : {} as Partial<MortgageTrack>;
    const merged: MortgageTrack = {
      id:              base.id ?? `trk-${Date.now()}`,
      name:            trackDraft.name            ?? base.name            ?? '',
      trackType:       (trackDraft.trackType      ?? base.trackType       ?? 'fixed') as MortgageTrack['trackType'],
      principal:       Number(trackDraft.principal       ?? base.principal       ?? 0),
      outstanding:     parseFloat(String(trackDraft.outstanding  ?? base.outstanding  ?? 0)) || 0,
      interestRate:    parseFloat(String(trackDraft.interestRate  ?? base.interestRate  ?? 0)) || 0,
      monthlyPayment:  parseFloat(String(trackDraft.monthlyPayment ?? base.monthlyPayment ?? 0)) || 0,
      monthsTotal:     Number(trackDraft.monthsTotal     ?? base.monthsTotal     ?? 0),
      monthsRemaining: Number(trackDraft.monthsRemaining ?? base.monthsRemaining ?? 0),
    };
    if (!merged.name) merged.name = TRACK_TYPE_LABELS[merged.trackType];
    const nextLoans = portfolio.loans.map(l => {
      if (l.id !== loanId) return l;
      const tracks = l.tracks ?? [];
      return { ...l, tracks: isEdit ? tracks.map(t => t.id === merged.id ? merged : t) : [...tracks, merged],
        monthlyPayment: [...(isEdit ? (l.tracks ?? []).map(t => t.id === merged.id ? merged : t) : [...(l.tracks ?? []), merged])]
          .reduce((s, t) => s + t.monthlyPayment, 0),
        outstanding: [...(isEdit ? (l.tracks ?? []).map(t => t.id === merged.id ? merged : t) : [...(l.tracks ?? []), merged])]
          .reduce((s, t) => s + t.outstanding, 0),
      };
    });
    updateLoans(nextLoans);
    setEditingTrack(null); setAddingTrackFor(null); setTrackDraft({});
  };

  const deleteTrack = (loanId: string, trackId: string) => {
    const nextLoans = portfolio.loans.map(l => {
      if (l.id !== loanId) return l;
      const tracks = (l.tracks ?? []).filter(t => t.id !== trackId);
      return { ...l, tracks, monthlyPayment: tracks.reduce((s, t) => s + t.monthlyPayment, 0),
        outstanding: tracks.reduce((s, t) => s + t.outstanding, 0) };
    });
    updateLoans(nextLoans);
  };

  // ── Derived data ───────────────────────────────────────────────────────────
  const realEstate = assets.filter(a => a.type === 'real_estate');
  const totalILS   = assets.filter(a => a.type !== 'savings').reduce((s, a) => s + toILS(a), 0);

  const portfolioFC = useMemo(() => {
    let gross = 0, costs = 0, mortgage = 0, appreciation = 0;
    for (const a of realEstate) {
      const linked = portfolio.loans.filter(l => l.linkedAssetId === a.id || l.type === 'mortgage');
      const f = calcForecast(a, allCosts[a.id] ?? [], getSettings(a.id), linked);
      gross += f.annualGrossILS; costs += f.annualCostsILS;
      mortgage += f.annualMortgageILS; appreciation += f.annualAppreciationILS;
    }
    return { gross, costs, mortgage, appreciation, net: gross - costs - mortgage,
      total: gross - costs - mortgage + appreciation };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assets, allCosts, propSettings, portfolio.loans]);

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div className="space-y-6" dir="rtl">

      {/* ── Summary banner ── */}
      <div className="bg-gradient-to-l from-blue-700 to-blue-900 rounded-xl p-6 text-white">
        <div className="flex flex-wrap gap-5 mb-3">
          <div>
            <p className="text-blue-200 text-xs mb-1">שווי נכסים כולל</p>
            <p className="text-3xl font-bold">{fILS(totalILS)}</p>
          </div>
          <div className="w-px bg-blue-600 self-stretch hidden md:block" />
          <div>
            <p className="text-blue-200 text-xs mb-1">הכנסה גולמית שנתית (שכ"ד)</p>
            <p className="text-2xl font-bold text-green-300">{fILS(portfolioFC.gross)}</p>
          </div>
          <div>
            <p className="text-blue-200 text-xs mb-1">עלויות שוטפות</p>
            <p className="text-2xl font-bold text-red-300">-{fILS(portfolioFC.costs)}</p>
          </div>
          {portfolioFC.mortgage > 0 && (
            <div>
              <p className="text-blue-200 text-xs mb-1">החזרי משכנתא שנתיים</p>
              <p className="text-2xl font-bold text-orange-300">-{fILS(portfolioFC.mortgage)}</p>
            </div>
          )}
          <div>
            <p className="text-blue-200 text-xs mb-1">הכנסה נטו שנתית</p>
            <p className={`text-2xl font-bold ${portfolioFC.net >= 0 ? 'text-green-300' : 'text-red-300'}`}>
              {portfolioFC.net >= 0 ? '+' : ''}{fILS(portfolioFC.net)}
            </p>
          </div>
          <div>
            <p className="text-blue-200 text-xs mb-1">עליית ערך צפויה</p>
            <p className="text-2xl font-bold text-yellow-300">+{fILS(portfolioFC.appreciation)}</p>
          </div>
          <div className="border-r border-blue-500 pr-5">
            <p className="text-blue-200 text-xs mb-1">סה"כ תשואה שנתית</p>
            <p className={`text-2xl font-bold ${portfolioFC.total >= 0 ? 'text-white' : 'text-red-300'}`}>
              {portfolioFC.total >= 0 ? '+' : ''}{fILS(portfolioFC.total)}
            </p>
          </div>
        </div>
        <p className="text-blue-300 text-xs">שער דולר: 1 USD = ₪{USD_TO_ILS} · מבוסס על נתוני שכ"ד ועלויות שהוגדרו לכל נכס</p>
      </div>

      {/* ── Real Estate ── */}
      <div className="bg-white rounded-xl border border-gray-200 p-6">
        <h3 className="text-base font-semibold text-gray-700 mb-4">🏠 נדל"ן</h3>
        <div className="space-y-5">
          {realEstate.map(asset => {
            const sym      = asset.currency === 'ILS' ? '₪' : '$';
            const costs    = allCosts[asset.id] ?? [];
            const docs     = allDocs[asset.id]  ?? [];
            const settings = getSettings(asset.id);
            const linkedLoans = portfolio.loans.filter(l => l.linkedAssetId === asset.id || l.type === 'mortgage');
            const fc       = calcForecast(asset, costs, settings, linkedLoans);
            const gainLoss = asset.purchasePrice ? asset.value - asset.purchasePrice : null;
            const gainPct  = gainLoss != null && asset.purchasePrice ? (gainLoss / asset.purchasePrice) * 100 : null;
            const section  = expandSection[asset.id] ?? null;
            const ltvPct   = asset.value > 0 && linkedLoans.length > 0
              ? (linkedLoans.reduce((s, l) => s + loanToILS(l.outstanding, l.currency), 0) / fc.valueILS) * 100
              : 0;

            return (
              <div key={asset.id} className="border border-gray-200 rounded-xl overflow-hidden">

                {/* Card header */}
                <div className="flex items-center justify-between bg-gray-50 px-5 py-3 border-b border-gray-100">
                  <div>
                    <p className="font-semibold text-gray-800">{asset.name}</p>
                    <p className="text-xs text-gray-400">{asset.address}</p>
                  </div>
                  <div className="flex items-center gap-2 flex-wrap justify-end">
                    {gainPct != null && (
                      <span className={`text-xs font-bold px-2 py-1 rounded-lg ${gainLoss! >= 0 ? 'bg-green-50 text-green-600' : 'bg-red-50 text-red-600'}`}>
                        {gainLoss! >= 0 ? '+' : ''}{gainPct.toFixed(1)}% מרכישה
                      </span>
                    )}
                    <span className={`text-xs font-bold px-2 py-1 rounded-lg ${fc.totalAnnualILS >= 0 ? 'bg-blue-50 text-blue-600' : 'bg-red-50 text-red-600'}`}>
                      {fc.totalAnnualILS >= 0 ? '+' : ''}{fILS(fc.totalAnnualILS)} / שנה
                    </span>
                    <button
                      onClick={() => removeAsset(asset.id)}
                      title="הסר נכס"
                      className="text-gray-300 hover:text-red-500 hover:bg-red-50 rounded-lg px-2 py-1 transition-colors text-sm"
                    >
                      🗑️
                    </button>
                  </div>
                </div>

                <div className="p-5 space-y-4">
                  {/* Basic fields */}
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                    <NF label={`שווי נוכחי (${sym})`}     value={asset.value}                    onChange={v => updateAsset(asset.id, 'value', v)} />
                    <NF label={`מחיר רכישה (${sym})`}     value={asset.purchasePrice ?? 0}       onChange={v => updateAsset(asset.id, 'purchasePrice', v)} />
                    <NF label={`שכירות חודשית (${sym})`}  value={asset.monthlyRentalIncome ?? 0} onChange={v => updateAsset(asset.id, 'monthlyRentalIncome', v)} step="100" />
                    <KPI label="הכנסה נטו שנתית (שכ&quot;ד − עלויות − משכנתא)"
                      value={`${fc.annualNetILS >= 0 ? '+' : ''}${fILS(fc.annualNetILS)}`}
                      sub={`תשואה נטו ${fc.netYield.toFixed(2)}%`}
                      color={fc.annualNetILS >= 0 ? 'text-green-700' : 'text-red-600'}
                      bg={fc.annualNetILS >= 0 ? 'bg-green-50' : 'bg-red-50'} />
                  </div>

                  {/* Forecast settings */}
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-3 pt-2 border-t border-gray-100">
                    <NF label="עליית ערך שנתית (%)" value={settings.appreciationRate} step="0.5"
                      onChange={v => updateSettings(asset.id, { appreciationRate: parseFloat(v) || 0 })} />
                    <NF label="חודשי ריקנות / שנה"   value={settings.vacancyMonths}   step="0.5"
                      onChange={v => updateSettings(asset.id, { vacancyMonths: parseFloat(v) || 0 })} />
                    <KPI label="עליית ערך צפויה לשנה"
                      value={`+${fILS(fc.annualAppreciationILS)}`}
                      sub={`${settings.appreciationRate}%`}
                      color="text-yellow-700" bg="bg-yellow-50" />
                    <KPI label="תשואה כוללת (שכ&quot;ד + עלייה)"
                      value={`${fc.totalAnnualILS >= 0 ? '+' : ''}${fILS(fc.totalAnnualILS)}`}
                      sub={`${fc.totalYield.toFixed(2)}% לשנה`}
                      color={fc.totalAnnualILS >= 0 ? 'text-indigo-700' : 'text-red-600'}
                      bg="bg-indigo-50" />
                  </div>

                  {/* ── Section toggle buttons ── */}
                  <div className="flex gap-2 pt-1 border-t border-gray-100">
                    <button
                      onClick={() => setExpandSection(prev => ({ ...prev, [asset.id]: prev[asset.id] === 'costs' ? null : 'costs' }))}
                      className={`flex-1 flex items-center justify-between px-4 py-2.5 rounded-xl text-sm font-medium transition-colors border ${section === 'costs' ? 'bg-blue-50 border-blue-200 text-blue-700' : 'bg-gray-50 border-gray-200 text-gray-600 hover:bg-gray-100'}`}
                    >
                      <span>💸 עלויות ומסמכים</span>
                      <div className="flex items-center gap-2">
                        {costs.length > 0 && <span className="text-xs text-red-500 font-medium">-{fILS(fc.annualCostsILS + fc.annualMortgageILS)}/שנה</span>}
                        <span className="text-xs opacity-50">{section === 'costs' ? '▲' : '▼'}</span>
                      </div>
                    </button>
                    <button
                      onClick={() => setExpandSection(prev => ({ ...prev, [asset.id]: prev[asset.id] === 'mortgage' ? null : 'mortgage' }))}
                      className={`flex-1 flex items-center justify-between px-4 py-2.5 rounded-xl text-sm font-medium transition-colors border ${section === 'mortgage' ? 'bg-orange-50 border-orange-200 text-orange-700' : 'bg-gray-50 border-gray-200 text-gray-600 hover:bg-gray-100'}`}
                    >
                      <span>🏦 משכנתא ומסלולים</span>
                      <div className="flex items-center gap-2">
                        {linkedLoans.length > 0 && <span className="text-xs text-orange-500 font-medium">LTV {ltvPct.toFixed(0)}%</span>}
                        <span className="text-xs opacity-50">{section === 'mortgage' ? '▲' : '▼'}</span>
                      </div>
                    </button>
                  </div>

                  {/* ── Costs & Docs panel ── */}
                  {section === 'costs' && (
                    <div className="border border-blue-100 rounded-xl p-4 space-y-4 bg-blue-50/20">

                      {/* Cost table */}
                      <div>
                        <div className="flex items-center justify-between mb-2">
                          <p className="text-xs font-semibold text-gray-600">עלויות שוטפות</p>
                          <button onClick={() => { setAddingCostFor(asset.id); setCostDraft({ category: 'management', frequency: 'monthly', currency: 'ILS' }); setEditingCost(null); }}
                            className="text-xs text-blue-600 hover:text-blue-800 font-medium">+ הוסף עלות</button>
                        </div>

                        {costs.length === 0 && addingCostFor !== asset.id && (
                          <p className="text-xs text-gray-400 text-center py-3">לחץ "הוסף עלות" להגדרת עלויות שוטפות</p>
                        )}

                        {costs.length > 0 && (
                          <table className="w-full text-xs mb-2">
                            <thead>
                              <tr className="text-gray-400 border-b border-gray-100">
                                <th className="text-right pb-1 pr-2">קטגוריה</th>
                                <th className="text-right pb-1 pr-2">תיאור</th>
                                <th className="text-right pb-1 pr-2">סכום</th>
                                <th className="text-right pb-1 pr-2">תדירות</th>
                                <th className="text-right pb-1 pr-2">שנתי ₪</th>
                                <th className="pb-1 w-12"></th>
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-gray-50">
                              {costs.map(cost => {
                                const isEditThis = editingCost?.assetId === asset.id && editingCost?.cost.id === cost.id;
                                if (isEditThis) return (
                                  <tr key={cost.id} className="bg-yellow-50">
                                    <td className="py-1.5 pr-2">
                                      <select value={costDraft.category ?? cost.category}
                                        onChange={e => setCostDraft(d => ({ ...d, category: e.target.value as CostCategory }))}
                                        className="border border-yellow-300 rounded px-1 py-0.5 text-xs w-28">
                                        {(Object.keys(COST_META) as CostCategory[]).map(k =>
                                          <option key={k} value={k}>{COST_META[k].icon} {COST_META[k].label}</option>)}
                                      </select>
                                    </td>
                                    <td className="py-1.5 pr-2">
                                      <input value={costDraft.name ?? cost.name}
                                        onChange={e => setCostDraft(d => ({ ...d, name: e.target.value }))}
                                        onKeyDown={e => e.key === 'Enter' && commitCost(asset.id, true)}
                                        className="border border-yellow-300 rounded px-1 py-0.5 text-xs w-24" />
                                    </td>
                                    <td className="py-1.5 pr-2">
                                      <input type="number" step="any" min="0" value={costDraft.amount ?? String(cost.amount)}
                                        onChange={e => setCostDraft(d => ({ ...d, amount: e.target.value }))}
                                        onKeyDown={e => e.key === 'Enter' && commitCost(asset.id, true)}
                                        className="border border-yellow-300 rounded px-1 py-0.5 text-xs w-20" />
                                    </td>
                                    <td className="py-1.5 pr-2">
                                      <select value={costDraft.frequency ?? cost.frequency}
                                        onChange={e => setCostDraft(d => ({ ...d, frequency: e.target.value as CostFrequency }))}
                                        className="border border-yellow-300 rounded px-1 py-0.5 text-xs">
                                        {(Object.keys(FREQ_LABEL) as CostFrequency[]).map(f =>
                                          <option key={f} value={f}>{FREQ_LABEL[f]}</option>)}
                                      </select>
                                    </td>
                                    <td className="py-1.5 pr-2 text-gray-400 text-xs">—</td>
                                    <td className="py-1.5">
                                      <div className="flex gap-1">
                                        <button onClick={() => commitCost(asset.id, true)} className="text-xs px-1.5 py-0.5 bg-green-500 text-white rounded hover:bg-green-600">✓</button>
                                        <button onClick={() => { setEditingCost(null); setCostDraft({}); }} className="text-xs px-1.5 py-0.5 bg-gray-200 rounded hover:bg-gray-300">✕</button>
                                      </div>
                                    </td>
                                  </tr>
                                );
                                const annualAmt = toAnnualILS(cost);
                                return (
                                  <tr key={cost.id} className="group hover:bg-gray-50">
                                    <td className="py-1.5 pr-2 text-gray-600">{COST_META[cost.category]?.icon} {COST_META[cost.category]?.label}</td>
                                    <td className="py-1.5 pr-2 text-gray-700">{cost.name !== COST_META[cost.category]?.label ? cost.name : '—'}</td>
                                    <td className="py-1.5 pr-2 tabular-nums">{cost.currency === 'ILS' ? '₪' : '$'}{cost.amount.toLocaleString()}</td>
                                    <td className="py-1.5 pr-2">
                                      <span className={`px-1.5 py-0.5 rounded text-xs ${cost.frequency === 'one_time' ? 'bg-yellow-50 text-yellow-700' : cost.frequency === 'monthly' ? 'bg-blue-50 text-blue-700' : 'bg-gray-100 text-gray-600'}`}>
                                        {FREQ_LABEL[cost.frequency]}
                                      </span>
                                    </td>
                                    <td className={`py-1.5 pr-2 tabular-nums font-medium ${cost.frequency === 'one_time' ? 'text-yellow-600 italic text-xs' : 'text-red-500'}`}>
                                      {cost.frequency === 'one_time' ? `חד פעמי · ${fILS(cost.currency === 'USD' ? cost.amount * USD_TO_ILS : cost.amount)}` : `-${fILS(annualAmt)}`}
                                    </td>
                                    <td className="py-1.5">
                                      <div className="opacity-0 group-hover:opacity-100 flex gap-1">
                                        <button onClick={() => { setEditingCost({ assetId: asset.id, cost }); setCostDraft({ ...cost, amount: String(cost.amount) }); setAddingCostFor(null); }}
                                          className="text-blue-400 hover:text-blue-600 text-xs">✏️</button>
                                        <button onClick={() => deleteCost(asset.id, cost.id)}
                                          className="text-gray-300 hover:text-red-500 text-xs">🗑</button>
                                      </div>
                                    </td>
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                        )}

                        {addingCostFor === asset.id && (
                          <div className="bg-white border border-blue-200 rounded-xl p-3 space-y-2 mt-2">
                            <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
                              <div>
                                <label className="text-xs text-gray-500 mb-0.5 block">קטגוריה</label>
                                <select value={costDraft.category ?? 'management'}
                                  onChange={e => setCostDraft(d => ({ ...d, category: e.target.value as CostCategory }))}
                                  className="w-full border border-blue-200 rounded-lg px-2 py-1.5 text-xs">
                                  {(Object.keys(COST_META) as CostCategory[]).map(k =>
                                    <option key={k} value={k}>{COST_META[k].icon} {COST_META[k].label}</option>)}
                                </select>
                              </div>
                              <div>
                                <label className="text-xs text-gray-500 mb-0.5 block">תיאור</label>
                                <input value={costDraft.name ?? ''}
                                  onChange={e => setCostDraft(d => ({ ...d, name: e.target.value }))}
                                  onKeyDown={e => e.key === 'Enter' && commitCost(asset.id, false)}
                                  placeholder={COST_META[(costDraft.category ?? 'management') as CostCategory]?.label}
                                  className="w-full border border-blue-200 rounded-lg px-2 py-1.5 text-xs" />
                              </div>
                              <div>
                                <label className="text-xs text-gray-500 mb-0.5 block">סכום</label>
                                <input type="number" step="any" min="0" value={costDraft.amount ?? ''}
                                  onChange={e => setCostDraft(d => ({ ...d, amount: e.target.value }))}
                                  onKeyDown={e => e.key === 'Enter' && commitCost(asset.id, false)}
                                  className="w-full border border-blue-200 rounded-lg px-2 py-1.5 text-xs" />
                              </div>
                              <div>
                                <label className="text-xs text-gray-500 mb-0.5 block">תדירות</label>
                                <select value={costDraft.frequency ?? 'monthly'}
                                  onChange={e => setCostDraft(d => ({ ...d, frequency: e.target.value as CostFrequency }))}
                                  className="w-full border border-blue-200 rounded-lg px-2 py-1.5 text-xs">
                                  {(Object.keys(FREQ_LABEL) as CostFrequency[]).map(f =>
                                    <option key={f} value={f}>{FREQ_LABEL[f]}</option>)}
                                </select>
                              </div>
                              <div>
                                <label className="text-xs text-gray-500 mb-0.5 block">מטבע</label>
                                <select value={costDraft.currency ?? 'ILS'}
                                  onChange={e => setCostDraft(d => ({ ...d, currency: e.target.value as 'ILS' | 'USD' }))}
                                  className="w-full border border-blue-200 rounded-lg px-2 py-1.5 text-xs">
                                  <option value="ILS">₪ ILS</option>
                                  <option value="USD">$ USD</option>
                                </select>
                              </div>
                              <div>
                                <label className="text-xs text-gray-500 mb-0.5 block">הערות</label>
                                <input value={costDraft.notes ?? ''}
                                  onChange={e => setCostDraft(d => ({ ...d, notes: e.target.value }))}
                                  className="w-full border border-blue-200 rounded-lg px-2 py-1.5 text-xs" />
                              </div>
                            </div>
                            <div className="flex gap-2 pt-1">
                              <button onClick={() => commitCost(asset.id, false)} className="text-xs px-3 py-1.5 bg-blue-600 text-white rounded-lg hover:bg-blue-700 font-medium">הוסף</button>
                              <button onClick={() => { setAddingCostFor(null); setCostDraft({}); }} className="text-xs px-3 py-1.5 bg-gray-200 rounded-lg hover:bg-gray-300">ביטול</button>
                            </div>
                          </div>
                        )}
                      </div>

                      {/* Documents */}
                      <div className="border-t border-blue-100 pt-3">
                        <div className="flex items-center justify-between mb-2">
                          <p className="text-xs font-semibold text-gray-600">📄 מסמכים</p>
                          <button
                            disabled={pdfParsing === asset.id}
                            onClick={() => {
                              setAddingDocFor(asset.id);
                              setDocDraft({ docType: 'clearing_report', date: new Date().toISOString().slice(0,10) });
                              setPendingFile(null);
                              fileRef.current?.click();
                            }}
                            className="text-xs text-blue-600 hover:text-blue-800 font-medium disabled:opacity-40">
                            {pdfParsing === asset.id ? '🤖 מנתח...' : '+ העלה מסמך'}
                          </button>
                        </div>
                        <input ref={fileRef} type="file" accept=".pdf,.csv,.xlsx,.xls,.jpg,.jpeg,.png,.webp,.html,.htm" className="hidden"
                          onChange={async e => {
                            const f = e.target.files?.[0];
                            e.target.value = '';
                            if (!f) return;
                            const ext = f.name.toLowerCase().split('.').pop() ?? '';
                            const VISUAL_EXTS = new Set(['pdf','jpg','jpeg','png','webp','html','htm']);
                            const isPdf = VISUAL_EXTS.has(ext);
                            if (!isPdf) {
                              setPendingFile(f.name);
                              return;
                            }
                            // PDF → AI analysis
                            const currentAssetId = addingDocFor ?? asset.id;
                            const currentDocType = docDraft.docType ?? 'clearing_report';
                            setPdfParsing(currentAssetId);
                            setPdfPreview(null);
                            try {
                              const base64 = await new Promise<string>((resolve, reject) => {
                                const reader = new FileReader();
                                reader.onload = ev => resolve((ev.target?.result as string).split(',')[1] ?? '');
                                reader.onerror = () => reject(new Error('read error'));
                                reader.readAsDataURL(f);
                              });
                              const mime = f.type || (['html','htm'].includes(ext) ? 'text/html' : 'application/pdf');
                              const result = await api.analyzePropDoc(base64, currentDocType, mime);
                              if (result.items.length === 0) {
                                alert('ה-AI לא זיהה פריטי עלות במסמך זה. ייתכן שהפורמט אינו נתמך.');
                                return;
                              }
                              setPdfPreview({
                                assetId: currentAssetId,
                                filename: f.name,
                                summary: result.summary,
                                items: result.items.map(it => ({ ...it, selected: true })),
                              });
                              // Also log as a doc record
                              saveDocs(currentAssetId, [...(allDocs[currentAssetId] ?? []), {
                                id: `doc-${Date.now()}`, assetId: currentAssetId,
                                filename: f.name,
                                docType: currentDocType as PropertyDoc['docType'],
                                date: new Date().toISOString().slice(0,10),
                                notes: result.summary.slice(0, 80),
                              }]);
                              setAddingDocFor(null); setDocDraft({});
                            } catch (err) {
                              alert(`שגיאת AI: ${err instanceof Error ? err.message : String(err)}`);
                            } finally {
                              setPdfParsing(null);
                            }
                          }} />

                        {docs.length > 0 && (
                          <div className="space-y-1 mb-2">
                            {docs.map(doc => (
                              <div key={doc.id} className="group flex items-center justify-between bg-gray-50 rounded-lg px-3 py-2">
                                <div className="flex items-center gap-2">
                                  <span>📎</span>
                                  <div>
                                    <p className="text-xs font-medium text-gray-700">{doc.filename}</p>
                                    <p className="text-xs text-gray-400">{DOC_TYPE_LABEL[doc.docType]} · {doc.date}{doc.amount ? ` · ${fILS(doc.amount)}` : ''}{doc.notes ? ` · ${doc.notes}` : ''}</p>
                                  </div>
                                </div>
                                <button onClick={() => deleteDoc(asset.id, doc.id)} className="opacity-0 group-hover:opacity-100 text-gray-300 hover:text-red-500 text-xs">🗑</button>
                              </div>
                            ))}
                          </div>
                        )}

                        {/* PDF extracted items review */}
                        {pdfPreview && pdfPreview.assetId === asset.id && (
                          <div className="bg-purple-50 border border-purple-200 rounded-xl p-4 space-y-3 mb-2">
                            <div className="flex items-start justify-between gap-2">
                              <div>
                                <p className="text-xs font-semibold text-purple-800">🤖 AI זיהה פריטי עלות</p>
                                <p className="text-xs text-purple-600 mt-0.5">{pdfPreview.summary}</p>
                              </div>
                              <button onClick={() => setPdfPreview(null)} className="text-gray-400 hover:text-gray-600 text-xs shrink-0">✕</button>
                            </div>

                            <div className="space-y-1.5">
                              {pdfPreview.items.map((it, idx) => (
                                <label key={idx} className={`flex items-center gap-2 rounded-lg px-3 py-2 cursor-pointer transition-colors ${it.selected ? 'bg-white border border-purple-200' : 'bg-gray-50 border border-gray-200 opacity-50'}`}>
                                  <input type="checkbox" checked={it.selected}
                                    onChange={() => setPdfPreview(prev => prev ? {
                                      ...prev,
                                      items: prev.items.map((x, i) => i === idx ? { ...x, selected: !x.selected } : x),
                                    } : null)}
                                    className="rounded" />
                                  <div className="flex-1 min-w-0">
                                    <span className="text-xs font-medium text-gray-800">{it.name}</span>
                                    <span className="text-xs text-gray-400 mr-2">
                                      {it.currency === 'ILS' ? '₪' : '$'}{it.amount.toLocaleString()} ·{' '}
                                      {it.frequency === 'monthly' ? 'חודשי' : it.frequency === 'annual' ? 'שנתי' : 'חד פעמי'}
                                    </span>
                                  </div>
                                  <span className={`text-xs px-1.5 py-0.5 rounded-full ${
                                    it.confidence === 'high'   ? 'bg-green-100 text-green-700' :
                                    it.confidence === 'medium' ? 'bg-yellow-100 text-yellow-700' :
                                    'bg-red-100 text-red-600'
                                  }`}>{it.confidence === 'high' ? 'גבוה' : it.confidence === 'medium' ? 'בינוני' : 'נמוך'}</span>
                                </label>
                              ))}
                            </div>

                            <div className="flex gap-2 pt-1">
                              <button
                                onClick={() => {
                                  const selected = pdfPreview.items.filter(it => it.selected);
                                  const newCosts: PropertyCost[] = selected.map(it => ({
                                    id: `cost-${Date.now()}-${Math.random().toString(36).slice(2)}`,
                                    category: it.category as CostCategory,
                                    name: it.name,
                                    amount: it.amount,
                                    frequency: it.frequency as CostFrequency,
                                    currency: it.currency as 'ILS' | 'USD',
                                    notes: `מתוך ${pdfPreview.filename}`,
                                  }));
                                  saveCosts(asset.id, [...(allCosts[asset.id] ?? []), ...newCosts]);
                                  setPdfPreview(null);
                                }}
                                className="text-xs px-3 py-1.5 bg-purple-600 text-white rounded-lg hover:bg-purple-700 font-medium">
                                הוסף {pdfPreview.items.filter(it => it.selected).length} פריטים לעלויות
                              </button>
                              <button onClick={() => setPdfPreview(null)} className="text-xs px-3 py-1.5 bg-gray-200 rounded-lg hover:bg-gray-300">התעלם</button>
                            </div>
                          </div>
                        )}

                        {addingDocFor === asset.id && pendingFile && (
                          <div className="bg-white border border-blue-200 rounded-xl p-3 space-y-2">
                            <p className="text-xs font-medium text-blue-700">📎 {pendingFile}</p>
                            <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
                              <div>
                                <label className="text-xs text-gray-500 mb-0.5 block">סוג מסמך</label>
                                <select value={docDraft.docType ?? 'clearing_report'}
                                  onChange={e => setDocDraft(d => ({ ...d, docType: e.target.value as PropertyDoc['docType'] }))}
                                  className="w-full border border-blue-200 rounded-lg px-2 py-1.5 text-xs">
                                  {(Object.keys(DOC_TYPE_LABEL) as PropertyDoc['docType'][]).map(k =>
                                    <option key={k} value={k}>{DOC_TYPE_LABEL[k]}</option>)}
                                </select>
                              </div>
                              <div>
                                <label className="text-xs text-gray-500 mb-0.5 block">תאריך</label>
                                <input type="date" value={docDraft.date ?? ''}
                                  onChange={e => setDocDraft(d => ({ ...d, date: e.target.value }))}
                                  className="w-full border border-blue-200 rounded-lg px-2 py-1.5 text-xs" />
                              </div>
                              <div>
                                <label className="text-xs text-gray-500 mb-0.5 block">סכום (₪)</label>
                                <input type="number" step="any" value={docDraft.amount ?? ''} placeholder="אופציונלי"
                                  onChange={e => setDocDraft(d => ({ ...d, amount: e.target.value }))}
                                  className="w-full border border-blue-200 rounded-lg px-2 py-1.5 text-xs" />
                              </div>
                              <div className="col-span-2 md:col-span-3">
                                <label className="text-xs text-gray-500 mb-0.5 block">הערות</label>
                                <input value={docDraft.notes ?? ''}
                                  onChange={e => setDocDraft(d => ({ ...d, notes: e.target.value }))}
                                  className="w-full border border-blue-200 rounded-lg px-2 py-1.5 text-xs" />
                              </div>
                            </div>
                            <div className="flex gap-2">
                              <button onClick={() => commitDoc(asset.id)} className="text-xs px-3 py-1.5 bg-blue-600 text-white rounded-lg hover:bg-blue-700 font-medium">שמור</button>
                              <button onClick={() => { setAddingDocFor(null); setPendingFile(null); setDocDraft({}); }} className="text-xs px-3 py-1.5 bg-gray-200 rounded-lg hover:bg-gray-300">ביטול</button>
                            </div>
                          </div>
                        )}
                      </div>

                      {/* Cost breakdown */}
                      {costs.filter(c => c.frequency !== 'one_time').length > 0 && (
                        <div className="border-t border-blue-100 pt-3">
                          <p className="text-xs font-semibold text-gray-600 mb-2">פירוט שנתי</p>
                          <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
                            {costs.filter(c => c.frequency !== 'one_time').map(c => (
                              <div key={c.id} className="bg-red-50/60 rounded-lg px-3 py-2">
                                <p className="text-xs text-gray-500">{COST_META[c.category]?.icon} {COST_META[c.category]?.label}</p>
                                <p className="text-sm font-semibold text-red-600">-{fILS(toAnnualILS(c))}</p>
                                <p className="text-xs text-gray-400">{FREQ_LABEL[c.frequency]}</p>
                              </div>
                            ))}
                            {fc.annualMortgageILS > 0 && (
                              <div className="bg-orange-50 rounded-lg px-3 py-2">
                                <p className="text-xs text-gray-500">🏦 החזרי משכנתא</p>
                                <p className="text-sm font-semibold text-orange-600">-{fILS(fc.annualMortgageILS)}</p>
                                <p className="text-xs text-gray-400">מחושב מהמסלולים</p>
                              </div>
                            )}
                          </div>
                        </div>
                      )}
                    </div>
                  )}

                  {/* ── Mortgage panel ── */}
                  {section === 'mortgage' && (
                    <div className="border border-orange-100 rounded-xl p-4 space-y-4 bg-orange-50/20">
                      {linkedLoans.length === 0 && (
                        <p className="text-xs text-gray-400 text-center py-2">
                          אין הלוואות מקושרות לנכס זה — הוסף משכנתא בטאב <strong>הלוואות</strong> וקשר אותה לנכס
                        </p>
                      )}

                      {linkedLoans.map(loan => {
                        const totalMonthly   = loan.tracks && loan.tracks.length > 0
                          ? loan.tracks.reduce((s, t) => s + t.monthlyPayment, 0)
                          : loan.monthlyPayment;
                        const totalOutstanding = loan.tracks && loan.tracks.length > 0
                          ? loan.tracks.reduce((s, t) => s + t.outstanding, 0)
                          : loan.outstanding;
                        const ltvLoan = fc.valueILS > 0 ? (loanToILS(totalOutstanding, loan.currency) / fc.valueILS) * 100 : 0;

                        return (
                          <div key={loan.id} className="bg-white border border-orange-100 rounded-xl overflow-hidden">
                            {/* Loan header */}
                            <div className="flex items-center justify-between bg-orange-50 px-4 py-3 border-b border-orange-100">
                              <div>
                                <p className="font-semibold text-gray-800 text-sm">{loan.name}</p>
                                <p className="text-xs text-gray-500">משכנתא · {loan.currency}</p>
                              </div>
                              <div className="flex items-center gap-3 text-xs">
                                <span className="text-gray-600">יתרה: <strong className="text-orange-600">{loan.currency === 'ILS' ? fILS(totalOutstanding) : fUSD(totalOutstanding)}</strong></span>
                                <span className="text-gray-600">החזר: <strong className="text-orange-600">{fILS(loanToILS(totalMonthly, loan.currency))} / חודש</strong></span>
                                <span className={`px-2 py-0.5 rounded font-bold text-xs ${ltvLoan < 50 ? 'bg-green-100 text-green-700' : ltvLoan < 70 ? 'bg-orange-100 text-orange-700' : 'bg-red-100 text-red-700'}`}>LTV {ltvLoan.toFixed(0)}%</span>
                              </div>
                            </div>

                            {/* Tracks table */}
                            <div className="p-4">
                              <div className="flex items-center justify-between mb-2">
                                <p className="text-xs font-semibold text-gray-600">מסלולים</p>
                                <button
                                  onClick={() => { setAddingTrackFor(loan.id); setTrackDraft({ trackType: 'fixed' }); setEditingTrack(null); }}
                                  className="text-xs text-orange-600 hover:text-orange-800 font-medium">+ הוסף מסלול</button>
                              </div>

                              {(loan.tracks ?? []).length === 0 && addingTrackFor !== loan.id && (
                                <p className="text-xs text-gray-400 text-center py-2">אין מסלולים — לחץ "הוסף מסלול"</p>
                              )}

                              {(loan.tracks ?? []).length > 0 && (
                                <table className="w-full text-xs mb-2">
                                  <thead>
                                    <tr className="text-gray-400 border-b border-gray-100">
                                      <th className="text-right pb-1 pr-2">מסלול</th>
                                      <th className="text-right pb-1 pr-2">סוג</th>
                                      <th className="text-right pb-1 pr-2">ריבית</th>
                                      <th className="text-right pb-1 pr-2">יתרה</th>
                                      <th className="text-right pb-1 pr-2">החזר חודשי</th>
                                      <th className="text-right pb-1 pr-2">תשלומים נותרים</th>
                                      <th className="pb-1 w-12"></th>
                                    </tr>
                                  </thead>
                                  <tbody className="divide-y divide-gray-50">
                                    {(loan.tracks ?? []).map(track => {
                                      const isEditThis = editingTrack?.loanId === loan.id && editingTrack?.track.id === track.id;
                                      if (isEditThis) return (
                                        <tr key={track.id} className="bg-yellow-50">
                                          <td className="py-1.5 pr-2">
                                            <input value={trackDraft.name ?? track.name}
                                              onChange={e => setTrackDraft(d => ({ ...d, name: e.target.value }))}
                                              onKeyDown={e => e.key === 'Enter' && commitTrack(loan.id, true)}
                                              className="border border-yellow-300 rounded px-1 py-0.5 text-xs w-24" />
                                          </td>
                                          <td className="py-1.5 pr-2">
                                            <select value={trackDraft.trackType ?? track.trackType}
                                              onChange={e => setTrackDraft(d => ({ ...d, trackType: e.target.value as MortgageTrack['trackType'] }))}
                                              className="border border-yellow-300 rounded px-1 py-0.5 text-xs">
                                              {(Object.keys(TRACK_TYPE_LABELS) as MortgageTrack['trackType'][]).map(t =>
                                                <option key={t} value={t}>{TRACK_TYPE_LABELS[t]}</option>)}
                                            </select>
                                          </td>
                                          <td className="py-1.5 pr-2">
                                            <input type="number" step="0.01" value={trackDraft.interestRate ?? String(track.interestRate)}
                                              onChange={e => setTrackDraft(d => ({ ...d, interestRate: e.target.value }))}
                                              onKeyDown={e => e.key === 'Enter' && commitTrack(loan.id, true)}
                                              className="border border-yellow-300 rounded px-1 py-0.5 text-xs w-16" />
                                          </td>
                                          <td className="py-1.5 pr-2">
                                            <input type="number" step="1000" value={trackDraft.outstanding ?? String(track.outstanding)}
                                              onChange={e => setTrackDraft(d => ({ ...d, outstanding: e.target.value }))}
                                              onKeyDown={e => e.key === 'Enter' && commitTrack(loan.id, true)}
                                              className="border border-yellow-300 rounded px-1 py-0.5 text-xs w-24" />
                                          </td>
                                          <td className="py-1.5 pr-2">
                                            <input type="number" step="100" value={trackDraft.monthlyPayment ?? String(track.monthlyPayment)}
                                              onChange={e => setTrackDraft(d => ({ ...d, monthlyPayment: e.target.value }))}
                                              onKeyDown={e => e.key === 'Enter' && commitTrack(loan.id, true)}
                                              className="border border-yellow-300 rounded px-1 py-0.5 text-xs w-20" />
                                          </td>
                                          <td className="py-1.5 pr-2">
                                            <input type="number" step="1" value={trackDraft.monthsRemaining ?? String(track.monthsRemaining)}
                                              onChange={e => setTrackDraft(d => ({ ...d, monthsRemaining: e.target.value }))}
                                              onKeyDown={e => e.key === 'Enter' && commitTrack(loan.id, true)}
                                              className="border border-yellow-300 rounded px-1 py-0.5 text-xs w-16" />
                                          </td>
                                          <td className="py-1.5">
                                            <div className="flex gap-1">
                                              <button onClick={() => commitTrack(loan.id, true)} className="text-xs px-1.5 py-0.5 bg-green-500 text-white rounded hover:bg-green-600">✓</button>
                                              <button onClick={() => { setEditingTrack(null); setTrackDraft({}); }} className="text-xs px-1.5 py-0.5 bg-gray-200 rounded hover:bg-gray-300">✕</button>
                                            </div>
                                          </td>
                                        </tr>
                                      );
                                      return (
                                        <tr key={track.id} className="group hover:bg-gray-50">
                                          <td className="py-1.5 pr-2 font-medium text-gray-700">{track.name}</td>
                                          <td className="py-1.5 pr-2">
                                            <span className={`px-1.5 py-0.5 rounded text-xs ${TRACK_TYPE_COLORS[track.trackType]}`}>
                                              {TRACK_TYPE_LABELS[track.trackType]}
                                            </span>
                                          </td>
                                          <td className="py-1.5 pr-2 tabular-nums text-gray-600">{track.interestRate}%</td>
                                          <td className="py-1.5 pr-2 tabular-nums text-gray-700">{fILS(track.outstanding)}</td>
                                          <td className="py-1.5 pr-2 tabular-nums font-medium text-orange-600">{fILS(track.monthlyPayment)}</td>
                                          <td className="py-1.5 pr-2 tabular-nums text-gray-500">{track.monthsRemaining} חודשים</td>
                                          <td className="py-1.5">
                                            <div className="opacity-0 group-hover:opacity-100 flex gap-1">
                                              <button onClick={() => { setEditingTrack({ loanId: loan.id, track }); setTrackDraft({ ...track, outstanding: String(track.outstanding), interestRate: String(track.interestRate), monthlyPayment: String(track.monthlyPayment) }); setAddingTrackFor(null); }}
                                                className="text-blue-400 hover:text-blue-600 text-xs">✏️</button>
                                              <button onClick={() => deleteTrack(loan.id, track.id)} className="text-gray-300 hover:text-red-500 text-xs">🗑</button>
                                            </div>
                                          </td>
                                        </tr>
                                      );
                                    })}
                                  </tbody>
                                </table>
                              )}

                              {/* Add track form */}
                              {addingTrackFor === loan.id && (
                                <div className="bg-orange-50 border border-orange-200 rounded-xl p-3 space-y-2 mt-1">
                                  <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
                                    <div>
                                      <label className="text-xs text-gray-500 mb-0.5 block">שם מסלול</label>
                                      <input value={trackDraft.name ?? ''}
                                        onChange={e => setTrackDraft(d => ({ ...d, name: e.target.value }))}
                                        onKeyDown={e => e.key === 'Enter' && commitTrack(loan.id, false)}
                                        placeholder="פריים, קבוע..."
                                        className="w-full border border-orange-200 rounded-lg px-2 py-1.5 text-xs" />
                                    </div>
                                    <div>
                                      <label className="text-xs text-gray-500 mb-0.5 block">סוג</label>
                                      <select value={trackDraft.trackType ?? 'fixed'}
                                        onChange={e => setTrackDraft(d => ({ ...d, trackType: e.target.value as MortgageTrack['trackType'] }))}
                                        className="w-full border border-orange-200 rounded-lg px-2 py-1.5 text-xs">
                                        {(Object.keys(TRACK_TYPE_LABELS) as MortgageTrack['trackType'][]).map(t =>
                                          <option key={t} value={t}>{TRACK_TYPE_LABELS[t]}</option>)}
                                      </select>
                                    </div>
                                    <div>
                                      <label className="text-xs text-gray-500 mb-0.5 block">ריבית (%)</label>
                                      <input type="number" step="0.01" value={trackDraft.interestRate ?? ''}
                                        onChange={e => setTrackDraft(d => ({ ...d, interestRate: e.target.value }))}
                                        onKeyDown={e => e.key === 'Enter' && commitTrack(loan.id, false)}
                                        className="w-full border border-orange-200 rounded-lg px-2 py-1.5 text-xs" />
                                    </div>
                                    <div>
                                      <label className="text-xs text-gray-500 mb-0.5 block">יתרה לפירעון (₪)</label>
                                      <input type="number" step="1000" value={trackDraft.outstanding ?? ''}
                                        onChange={e => setTrackDraft(d => ({ ...d, outstanding: e.target.value }))}
                                        onKeyDown={e => e.key === 'Enter' && commitTrack(loan.id, false)}
                                        className="w-full border border-orange-200 rounded-lg px-2 py-1.5 text-xs" />
                                    </div>
                                    <div>
                                      <label className="text-xs text-gray-500 mb-0.5 block">החזר חודשי (₪)</label>
                                      <input type="number" step="100" value={trackDraft.monthlyPayment ?? ''}
                                        onChange={e => setTrackDraft(d => ({ ...d, monthlyPayment: e.target.value }))}
                                        onKeyDown={e => e.key === 'Enter' && commitTrack(loan.id, false)}
                                        className="w-full border border-orange-200 rounded-lg px-2 py-1.5 text-xs" />
                                    </div>
                                    <div>
                                      <label className="text-xs text-gray-500 mb-0.5 block">תשלומים נותרים</label>
                                      <input type="number" step="1" value={trackDraft.monthsRemaining ?? ''}
                                        onChange={e => setTrackDraft(d => ({ ...d, monthsRemaining: e.target.value }))}
                                        onKeyDown={e => e.key === 'Enter' && commitTrack(loan.id, false)}
                                        className="w-full border border-orange-200 rounded-lg px-2 py-1.5 text-xs" />
                                    </div>
                                  </div>
                                  <div className="flex gap-2 pt-1">
                                    <button onClick={() => commitTrack(loan.id, false)} className="text-xs px-3 py-1.5 bg-orange-500 text-white rounded-lg hover:bg-orange-600 font-medium">הוסף מסלול</button>
                                    <button onClick={() => { setAddingTrackFor(null); setTrackDraft({}); }} className="text-xs px-3 py-1.5 bg-gray-200 rounded-lg hover:bg-gray-300">ביטול</button>
                                  </div>
                                </div>
                              )}

                              {/* Track totals */}
                              {(loan.tracks ?? []).length > 0 && (
                                <div className="flex flex-wrap gap-3 mt-2 pt-2 border-t border-orange-100 text-xs">
                                  <span className="text-gray-500">יתרה כוללת: <strong className="text-orange-600">{fILS(totalOutstanding)}</strong></span>
                                  <span className="text-gray-500">החזר כולל: <strong className="text-orange-600">{fILS(loanToILS(totalMonthly, loan.currency))} / חודש</strong></span>
                                  <span className="text-gray-500">שנתי: <strong className="text-orange-600">-{fILS(loanToILS(totalMonthly, loan.currency) * 12)}</strong></span>
                                </div>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};

export default AssetsTab;
