import { type FC, useState } from 'react';
import type { Asset, Portfolio } from '../../types';

const fILS = (v: number) =>
  new Intl.NumberFormat('he-IL', { style: 'currency', currency: 'ILS', maximumFractionDigits: 0 }).format(v);
const fUSD = (v: number) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(v);

const USD_TO_ILS = 3.7;
const toILS = (a: Asset) => (a.currency === 'USD' ? a.value * USD_TO_ILS : a.value);

const DEFAULT_ASSETS: Asset[] = [
  { id: 'asset-1', name: 'דירה בראשון לציון', type: 'real_estate', value: 2_200_000, currency: 'ILS',
    address: 'ראשון לציון, ישראל', propertyType: 'apartment', purchasePrice: 1_500_000, monthlyRentalIncome: 0 },
  { id: 'asset-2', name: 'נכס בקליבלנד, אוהיו', type: 'real_estate', value: 180_000, currency: 'USD',
    address: 'Cleveland, Ohio, USA', propertyType: 'house', purchasePrice: 120_000, monthlyRentalIncome: 0 },
  { id: 'asset-3', name: 'VOO - Vanguard S&P 500 ETF', type: 'stock', value: 0, currency: 'USD',
    ticker: 'VOO', units: 0, pricePerUnit: 520, avgBuyPrice: 0 },
  { id: 'asset-4', name: 'IBIT - iShares Bitcoin ETF', type: 'stock', value: 0, currency: 'USD',
    ticker: 'IBIT', units: 0, pricePerUnit: 38, avgBuyPrice: 0 },
  { id: 'asset-5', name: 'קרן פנסיה', type: 'savings', value: 0, currency: 'ILS', savingsType: 'pension' },
  { id: 'asset-6', name: 'קרן השתלמות', type: 'savings', value: 0, currency: 'ILS', savingsType: 'keren_hishtalmut' },
];

interface AssetsTabProps {
  portfolio: Portfolio;
  onPortfolioChange: (p: Portfolio) => void;
}

const AssetsTab: FC<AssetsTabProps> = ({ portfolio, onPortfolioChange }) => {
  const [assets, setAssets] = useState<Asset[]>(
    portfolio.assets.length > 0 ? portfolio.assets : DEFAULT_ASSETS
  );

  const numFields: (keyof Asset)[] = [
    'value', 'units', 'pricePerUnit', 'avgBuyPrice', 'purchasePrice', 'monthlyRentalIncome',
  ];

  const updateAsset = (id: string, field: keyof Asset, rawValue: string) => {
    setAssets((prev) => {
      const next = prev.map((a) => {
        if (a.id !== id) return a;
        const parsed = numFields.includes(field) ? (parseFloat(rawValue) || 0) : rawValue;
        const updated: Asset = { ...a, [field]: parsed };
        if (updated.type === 'stock') {
          updated.value = (updated.units ?? 0) * (updated.pricePerUnit ?? 0);
        }
        return updated;
      });
      const totalAssetsILS = next.reduce((s, a) => s + toILS(a), 0);
      onPortfolioChange({ ...portfolio, assets: next, totalAssetsILS, netWorthILS: totalAssetsILS - portfolio.totalLiabilitiesILS });
      return next;
    });
  };

  const realEstate = assets.filter((a) => a.type === 'real_estate');
  const stocks = assets.filter((a) => a.type === 'stock');
  const savings = assets.filter((a) => a.type === 'savings');
  const totalILS = assets.reduce((s, a) => s + toILS(a), 0);
  const totalMonthlyRent = realEstate.reduce((s, a) => {
    const rent = a.monthlyRentalIncome ?? 0;
    return s + (a.currency === 'USD' ? rent * USD_TO_ILS : rent);
  }, 0);
  const totalStockGainUSD = stocks.reduce((s, a) => {
    const buyPrice = (a.avgBuyPrice ?? 0) * (a.units ?? 0);
    return s + (a.value - buyPrice);
  }, 0);

  return (
    <div className="space-y-6">
      {/* Summary banner */}
      <div className="bg-gradient-to-l from-blue-600 to-blue-800 rounded-xl p-6 text-white">
        <div className="flex flex-wrap gap-6">
          <div>
            <p className="text-blue-200 text-sm">שווי נכסים כולל</p>
            <p className="text-3xl font-bold mt-1">{fILS(totalILS)}</p>
          </div>
          {totalMonthlyRent > 0 && (
            <div>
              <p className="text-blue-200 text-sm">שכירות חודשית כוללת</p>
              <p className="text-2xl font-bold mt-1">{fILS(totalMonthlyRent)}</p>
            </div>
          )}
          <div>
            <p className="text-blue-200 text-sm">רווח/הפסד מניות</p>
            <p className={`text-2xl font-bold mt-1 ${totalStockGainUSD >= 0 ? 'text-green-300' : 'text-red-300'}`}>
              {fUSD(totalStockGainUSD)}
            </p>
          </div>
        </div>
        <p className="text-blue-300 text-xs mt-3">שער דולר: 1 USD = ₪{USD_TO_ILS}</p>
      </div>

      {/* Real Estate */}
      <div className="bg-white rounded-xl border border-gray-200 p-6">
        <h3 className="text-base font-semibold text-gray-700 mb-4">🏠 נדל&quot;ן</h3>
        <div className="space-y-6">
          {realEstate.map((asset) => {
            const sym = asset.currency === 'ILS' ? '₪' : '$';
            const ilsValue = toILS(asset);
            const gainLoss = asset.purchasePrice
              ? asset.value - asset.purchasePrice
              : null;
            const gainPct = gainLoss !== null && asset.purchasePrice
              ? (gainLoss / asset.purchasePrice) * 100
              : null;
            const annualRent = (asset.monthlyRentalIncome ?? 0) * 12;
            const grossYield = asset.value > 0 ? (annualRent / asset.value) * 100 : 0;

            return (
              <div key={asset.id} className="border border-gray-100 rounded-xl p-5 space-y-4">
                <div className="flex items-start justify-between">
                  <div>
                    <p className="font-semibold text-gray-800">{asset.name}</p>
                    <p className="text-xs text-gray-400">{asset.address}</p>
                  </div>
                  {gainPct !== null && (
                    <span className={`text-sm font-bold px-2 py-1 rounded-lg ${gainLoss! >= 0 ? 'bg-green-50 text-green-600' : 'bg-red-50 text-red-600'}`}>
                      {gainLoss! >= 0 ? '+' : ''}{gainPct.toFixed(1)}% רווח הון
                    </span>
                  )}
                </div>

                <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                  <NumberField label={`שווי נוכחי (${sym})`} value={asset.value}
                    onChange={(v) => updateAsset(asset.id, 'value', v)} />
                  <NumberField label={`מחיר רכישה (${sym})`} value={asset.purchasePrice ?? 0}
                    onChange={(v) => updateAsset(asset.id, 'purchasePrice', v)} />
                  <NumberField label={`שכירות חודשית (${sym})`} value={asset.monthlyRentalIncome ?? 0}
                    onChange={(v) => updateAsset(asset.id, 'monthlyRentalIncome', v)} step="100" />
                  <div className="bg-gray-50 rounded-lg p-3">
                    <p className="text-xs text-gray-500 mb-1">תשואה גולמית</p>
                    <p className={`text-base font-bold ${grossYield > 0 ? 'text-green-600' : 'text-gray-400'}`}>
                      {grossYield.toFixed(2)}%
                    </p>
                    <p className="text-xs text-gray-400">לשנה</p>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div className="bg-blue-50 rounded-lg p-3">
                    <p className="text-xs text-blue-500">שווי ב-₪</p>
                    <p className="font-bold text-blue-700">{fILS(ilsValue)}</p>
                  </div>
                  {gainLoss !== null && (
                    <div className={`rounded-lg p-3 ${gainLoss >= 0 ? 'bg-green-50' : 'bg-red-50'}`}>
                      <p className="text-xs text-gray-500">רווח הון</p>
                      <p className={`font-bold ${gainLoss >= 0 ? 'text-green-600' : 'text-red-500'}`}>
                        {gainLoss >= 0 ? '+' : ''}{sym}{Math.abs(gainLoss).toLocaleString()}
                      </p>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Stocks */}
      <div className="bg-white rounded-xl border border-gray-200 p-6">
        <h3 className="text-base font-semibold text-gray-700 mb-4">📈 תיק מניות ו-ETF</h3>
        <div className="space-y-4">
          {stocks.map((asset) => {
            const costBasis = (asset.avgBuyPrice ?? 0) * (asset.units ?? 0);
            const gainLoss = asset.value - costBasis;
            const gainPct = costBasis > 0 ? (gainLoss / costBasis) * 100 : 0;

            return (
              <div key={asset.id} className="border border-gray-100 rounded-xl p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <div>
                    <span className="font-bold text-gray-800">{asset.ticker}</span>
                    <span className="text-xs text-gray-400 mr-2">{asset.name.replace(`${asset.ticker} - `, '')}</span>
                  </div>
                  {costBasis > 0 && (
                    <span className={`text-sm font-bold ${gainLoss >= 0 ? 'text-green-600' : 'text-red-500'}`}>
                      {gainLoss >= 0 ? '+' : ''}{fUSD(gainLoss)} ({gainPct.toFixed(1)}%)
                    </span>
                  )}
                </div>

                <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                  <NumberField label="יחידות" value={asset.units ?? 0}
                    onChange={(v) => updateAsset(asset.id, 'units', v)} step="1" />
                  <NumberField label="מחיר נוכחי ($)" value={asset.pricePerUnit ?? 0}
                    onChange={(v) => updateAsset(asset.id, 'pricePerUnit', v)} step="0.01" />
                  <NumberField label="עלות ממוצעת ($)" value={asset.avgBuyPrice ?? 0}
                    onChange={(v) => updateAsset(asset.id, 'avgBuyPrice', v)} step="0.01" />
                  <div className="bg-gray-50 rounded-lg p-3">
                    <p className="text-xs text-gray-500 mb-1">שווי כולל</p>
                    <p className="font-bold text-gray-800">{fUSD(asset.value)}</p>
                    <p className="text-xs text-gray-400">≈ {fILS(asset.value * USD_TO_ILS)}</p>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Savings */}
      <div className="bg-white rounded-xl border border-gray-200 p-6">
        <h3 className="text-base font-semibold text-gray-700 mb-4">💰 חסכונות</h3>
        <div className="space-y-3">
          {savings.map((asset) => (
            <div key={asset.id} className="border border-gray-100 rounded-lg p-4 flex items-center gap-4">
              <div className="flex-1">
                <p className="font-medium text-gray-800">{asset.name}</p>
                <p className="text-xs text-gray-400">{asset.savingsType === 'pension' ? 'פנסיה' : 'קרן השתלמות'}</p>
              </div>
              <NumberField label="יתרה (₪)" value={asset.value}
                onChange={(v) => updateAsset(asset.id, 'value', v)} />
              <div className="text-right">
                <p className="text-xs text-gray-400">שווי</p>
                <p className="font-bold text-blue-700">{fILS(asset.value)}</p>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

const NumberField: FC<{ label: string; value: number; onChange: (v: string) => void; step?: string }> = ({
  label, value, onChange, step = '1000',
}) => (
  <div>
    <label className="block text-xs text-gray-500 mb-1">{label}</label>
    <input
      type="number" step={step} value={value}
      onChange={(e) => onChange(e.target.value)}
      className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
    />
  </div>
);

export default AssetsTab;
