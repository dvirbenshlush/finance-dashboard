import { type FC, useState } from 'react';
import type { Asset, Portfolio } from '../../types';

const fILS = (v: number) =>
  new Intl.NumberFormat('he-IL', { style: 'currency', currency: 'ILS', maximumFractionDigits: 0 }).format(v);

const LS_SAVINGS_SETTINGS = 'otzar_savings_settings';

interface SavingsSettings {
  returnRate: number;       // % expected annual return
  monthlyContribution: number; // monthly deposit
}

function loadLS<T>(key: string, fallback: T): T {
  try { const r = localStorage.getItem(key); return r ? JSON.parse(r) as T : fallback; }
  catch { return fallback; }
}

const DEFAULT_SETTINGS: SavingsSettings = { returnRate: 6, monthlyContribution: 0 };

const SAVINGS_META: Record<string, { label: string; icon: string; color: string }> = {
  pension:           { label: 'פנסיה',        icon: '🏛️', color: 'blue'   },
  keren_hishtalmut:  { label: 'קרן השתלמות', icon: '🎓', color: 'green'  },
  other:             { label: 'חיסכון אחר',  icon: '💰', color: 'purple' },
};

interface SavingsTabProps {
  portfolio: Portfolio;
  onPortfolioChange: (p: Portfolio) => void;
}

const SavingsTab: FC<SavingsTabProps> = ({ portfolio, onPortfolioChange }) => {
  const savings = portfolio.assets.filter(a => a.type === 'savings');

  const [settings, setSettings] = useState<Record<string, SavingsSettings>>(
    () => loadLS(LS_SAVINGS_SETTINGS, {})
  );

  const getSettings = (id: string): SavingsSettings =>
    settings[id] ?? DEFAULT_SETTINGS;

  const updateSettings = (id: string, patch: Partial<SavingsSettings>) => {
    const next = { ...settings, [id]: { ...getSettings(id), ...patch } };
    setSettings(next);
    localStorage.setItem(LS_SAVINGS_SETTINGS, JSON.stringify(next));
  };

  const updateValue = (id: string, value: number) => {
    const nextAssets = portfolio.assets.map(a => a.id === id ? { ...a, value } : a);
    const totalAssetsILS = nextAssets.reduce((s, a) =>
      s + (a.currency === 'USD' ? a.value * 3.73 : a.value), 0);
    onPortfolioChange({ ...portfolio, assets: nextAssets, totalAssetsILS,
      netWorthILS: totalAssetsILS - portfolio.totalLiabilitiesILS });
  };

  const totalSavings = savings.reduce((s, a) => s + a.value, 0);

  // Project future value: FV = PV*(1+r)^n + PMT*((1+r)^n - 1)/r
  const projectFV = (pv: number, s: SavingsSettings, years: number): number => {
    const r = (s.returnRate / 100) / 12;
    const n = years * 12;
    if (r === 0) return pv + s.monthlyContribution * n;
    return pv * Math.pow(1 + r, n) + s.monthlyContribution * ((Math.pow(1 + r, n) - 1) / r);
  };

  return (
    <div className="space-y-6" dir="rtl">
      {/* Summary */}
      <div className="bg-gradient-to-l from-green-700 to-emerald-800 rounded-xl p-6 text-white">
        <p className="text-green-200 text-xs mb-1">סה"כ חסכונות</p>
        <p className="text-3xl font-bold">{fILS(totalSavings)}</p>
        <p className="text-green-300 text-xs mt-2">
          {savings.length} קרנות · {fILS(savings.reduce((s, a) => s + getSettings(a.id).monthlyContribution, 0))} הפרשה חודשית כוללת
        </p>
      </div>

      {savings.length === 0 && (
        <div className="bg-white rounded-xl border border-gray-200 p-10 text-center text-gray-400 text-sm">
          אין חסכונות מוגדרים — הוסף אותם בטאב "תיק נכסים"
        </div>
      )}

      {savings.map(asset => {
        const meta = SAVINGS_META[asset.savingsType ?? 'other'] ?? SAVINGS_META.other;
        const s = getSettings(asset.id);
        const fv10 = projectFV(asset.value, s, 10);
        const fv20 = projectFV(asset.value, s, 20);
        const gain10 = fv10 - asset.value - s.monthlyContribution * 120;
        const gain20 = fv20 - asset.value - s.monthlyContribution * 240;

        const colorMap: Record<string, string> = {
          blue:   'from-blue-50  to-blue-100  border-blue-200',
          green:  'from-green-50 to-green-100 border-green-200',
          purple: 'from-purple-50 to-purple-100 border-purple-200',
        };
        const textMap: Record<string, string> = {
          blue: 'text-blue-700', green: 'text-green-700', purple: 'text-purple-700',
        };

        return (
          <div key={asset.id}
            className={`bg-gradient-to-br ${colorMap[meta.color]} border rounded-xl p-6 space-y-5`}>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="text-2xl">{meta.icon}</span>
                <div>
                  <p className="font-semibold text-gray-800">{asset.name}</p>
                  <p className="text-xs text-gray-500">{meta.label}</p>
                </div>
              </div>
              <p className={`text-2xl font-bold ${textMap[meta.color]}`}>{fILS(asset.value)}</p>
            </div>

            {/* Editable fields */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 bg-white/60 rounded-xl p-4">
              <div>
                <label className="block text-xs text-gray-500 mb-1">יתרה נוכחית (₪)</label>
                <input type="number" step="1000" value={asset.value}
                  onChange={e => updateValue(asset.id, parseFloat(e.target.value) || 0)}
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400 bg-white" />
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1">הפרשה חודשית (₪)</label>
                <input type="number" step="100" value={s.monthlyContribution}
                  onChange={e => updateSettings(asset.id, { monthlyContribution: parseFloat(e.target.value) || 0 })}
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400 bg-white" />
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1">תשואה שנתית צפויה (%)</label>
                <input type="number" step="0.5" value={s.returnRate}
                  onChange={e => updateSettings(asset.id, { returnRate: parseFloat(e.target.value) || 0 })}
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400 bg-white" />
              </div>
            </div>

            {/* Projections */}
            <div>
              <p className="text-xs font-semibold text-gray-600 mb-2">תחזית צמיחה</p>
              <div className="grid grid-cols-2 gap-3">
                <div className="bg-white/70 rounded-xl p-3 text-center">
                  <p className="text-xs text-gray-500 mb-0.5">בעוד 10 שנים</p>
                  <p className={`text-xl font-bold ${textMap[meta.color]}`}>{fILS(fv10)}</p>
                  <p className="text-xs text-gray-400">
                    רווח ריבית: <span className="text-green-600 font-medium">{fILS(gain10)}</span>
                  </p>
                </div>
                <div className="bg-white/70 rounded-xl p-3 text-center">
                  <p className="text-xs text-gray-500 mb-0.5">בעוד 20 שנים</p>
                  <p className={`text-xl font-bold ${textMap[meta.color]}`}>{fILS(fv20)}</p>
                  <p className="text-xs text-gray-400">
                    רווח ריבית: <span className="text-green-600 font-medium">{fILS(gain20)}</span>
                  </p>
                </div>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
};

export default SavingsTab;
