import { type FC, useState, useRef } from 'react';
import * as XLSX from 'xlsx';
import type { Asset, Loan, MortgageTrack, Portfolio } from '../../types';

// ---------------------------------------------------------------------------
// Formatters & helpers
// ---------------------------------------------------------------------------
const fILS = (v: number) =>
  new Intl.NumberFormat('he-IL', { style: 'currency', currency: 'ILS', maximumFractionDigits: 0 }).format(v);

const USD_TO_ILS = 3.7;
const toILS = (v: number, currency: 'ILS' | 'USD') => (currency === 'USD' ? v * USD_TO_ILS : v);

const ltvBg = (ltv: number) =>
  ltv < 50 ? 'bg-green-100 text-green-700' : ltv < 70 ? 'bg-orange-100 text-orange-700' : 'bg-red-100 text-red-700';

const TRACK_TYPE_LABELS: Record<MortgageTrack['trackType'], string> = {
  prime: 'פריים',
  fixed: 'קבוע',
  cpi: 'קל"צ',
  variable: 'משתנה',
  other: 'אחר',
};

const TRACK_TYPE_COLORS: Record<MortgageTrack['trackType'], string> = {
  prime: 'bg-blue-100 text-blue-700',
  fixed: 'bg-green-100 text-green-700',
  cpi: 'bg-orange-100 text-orange-700',
  variable: 'bg-purple-100 text-purple-700',
  other: 'bg-gray-100 text-gray-700',
};

const LOAN_TYPE_LABELS: Record<Loan['type'], string> = {
  mortgage: 'משכנתא',
  private: 'הלוואה פרטית',
  car: 'הלוואת רכב',
  other: 'אחר',
};

// ---------------------------------------------------------------------------
// Slik (דוח סליקה) parser
// ---------------------------------------------------------------------------
const HEADER_KEYWORDS = ['מסלול', 'ריבית', 'יתרה', 'קרן', 'תשלום', 'החזר'];

const COL_MAP: Record<string, string[]> = {
  name: ['מסלול', 'סוג מסלול', 'שם מסלול'],
  interestRate: ['ריבית', 'שיעור ריבית'],
  outstanding: ['יתרת קרן', 'יתרה לפירעון', 'יתרת הקרן', 'יתרה'],
  monthlyPayment: ['החזר חודשי', 'תשלום חודשי', 'החזר', 'תשלום'],
  monthsRemaining: ['חודשים נותרים', 'מספר תשלומים נותרים', 'תשלומים נותרים'],
  principal: ['קרן מקורית', 'סכום הלוואה', 'קרן'],
  monthsTotal: ['תקופה', 'מספר תשלומים כולל'],
};

function guessTrackType(name: string): MortgageTrack['trackType'] {
  const n = name.toLowerCase();
  if (n.includes('פריים') || n.includes('prime')) return 'prime';
  if (n.includes('קבוע') || n.includes('fixed')) return 'fixed';
  if (n.includes('קל"צ') || n.includes('קלצ') || n.includes('cpi') || n.includes('צמוד')) return 'cpi';
  if (n.includes('משתנ') || n.includes('variable')) return 'variable';
  return 'other';
}

function parseSlik(file: File): Promise<MortgageTrack[]> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const data = e.target?.result;
        const wb = XLSX.read(data, { type: 'binary' });
        const ws = wb.Sheets[wb.SheetNames[0]];
        const rows: string[][] = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' }) as string[][];

        // Find header row
        let headerRowIdx = -1;
        for (let i = 0; i < Math.min(15, rows.length); i++) {
          const rowStr = rows[i].join('');
          const matchCount = HEADER_KEYWORDS.filter((kw) => rowStr.includes(kw)).length;
          if (matchCount >= 2) {
            headerRowIdx = i;
            break;
          }
        }

        if (headerRowIdx === -1) {
          reject(new Error('לא נמצאה שורת כותרת בקובץ'));
          return;
        }

        const headers = rows[headerRowIdx].map((h) => String(h).trim());

        // Build column index map
        const colIdx: Partial<Record<string, number>> = {};
        for (const [field, variants] of Object.entries(COL_MAP)) {
          for (const variant of variants) {
            const idx = headers.findIndex((h) => h.includes(variant));
            if (idx !== -1) {
              colIdx[field] = idx;
              break;
            }
          }
        }

        const getNum = (row: string[], field: string): number => {
          const idx = colIdx[field];
          if (idx === undefined) return 0;
          const val = String(row[idx]).replace(/[,₪%]/g, '').trim();
          return parseFloat(val) || 0;
        };

        const getStr = (row: string[], field: string): string => {
          const idx = colIdx[field];
          if (idx === undefined) return '';
          return String(row[idx]).trim();
        };

        const tracks: MortgageTrack[] = [];
        for (let i = headerRowIdx + 1; i < rows.length; i++) {
          const row = rows[i].map((c) => String(c));
          const trackName = getStr(row, 'name');
          if (!trackName) continue; // skip empty rows

          const outstanding = getNum(row, 'outstanding');
          const principal = getNum(row, 'principal') || outstanding;
          const monthlyPayment = getNum(row, 'monthlyPayment');
          const monthsRemaining = getNum(row, 'monthsRemaining');
          const monthsTotal = getNum(row, 'monthsTotal') || monthsRemaining;
          const interestRate = getNum(row, 'interestRate');

          tracks.push({
            id: `track-${Date.now()}-${i}`,
            name: trackName,
            trackType: guessTrackType(trackName),
            principal,
            outstanding,
            interestRate,
            monthlyPayment,
            monthsTotal,
            monthsRemaining,
          });
        }

        resolve(tracks);
      } catch (err) {
        reject(err);
      }
    };
    reader.onerror = () => reject(new Error('שגיאה בקריאת הקובץ'));
    reader.readAsBinaryString(file);
  });
}

// ---------------------------------------------------------------------------
// Default data
// ---------------------------------------------------------------------------
const DEFAULT_LOANS: Loan[] = [
  {
    id: 'loan-1',
    name: 'משכנתא - ראשון לציון',
    type: 'mortgage',
    principal: 900_000,
    outstanding: 750_000,
    interestRate: 4.5,
    currency: 'ILS',
    monthlyPayment: 4_800,
    propertyValue: 2_200_000,
    linkedAssetId: 'asset-1',
  },
  {
    id: 'loan-2',
    name: 'הלוואה - נכס קליבלנד',
    type: 'mortgage',
    principal: 120_000,
    outstanding: 100_000,
    interestRate: 7.0,
    currency: 'USD',
    monthlyPayment: 800,
    propertyValue: 180_000,
    linkedAssetId: 'asset-2',
  },
];

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------
interface LoansTabProps {
  portfolio: Portfolio;
  onPortfolioChange: (p: Portfolio) => void;
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------
const LoansTab: FC<LoansTabProps> = ({ portfolio, onPortfolioChange }) => {
  const [loans, setLoans] = useState<Loan[]>(
    portfolio.loans.length > 0 ? portfolio.loans : DEFAULT_LOANS,
  );
  const [showTracks, setShowTracks] = useState<Map<string, boolean>>(new Map());
  const [importFeedback, setImportFeedback] = useState<string>('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------
  const numFields: (keyof Loan)[] = [
    'outstanding',
    'principal',
    'interestRate',
    'monthlyPayment',
    'propertyValue',
    'termMonths',
  ];

  const commitLoans = (next: Loan[]) => {
    const totalLiabilitiesILS = next.reduce((s, l) => s + toILS(l.outstanding, l.currency), 0);
    onPortfolioChange({
      ...portfolio,
      loans: next,
      totalLiabilitiesILS,
      netWorthILS: portfolio.totalAssetsILS - totalLiabilitiesILS,
    });
    return next;
  };

  const setAndCommit = (next: Loan[]) => {
    setLoans(commitLoans(next));
  };

  const updateLoan = (id: string, field: keyof Loan, rawValue: string) => {
    setLoans((prev) => {
      const next = prev.map((l) =>
        l.id === id
          ? { ...l, [field]: numFields.includes(field) ? parseFloat(rawValue) || 0 : rawValue }
          : l,
      );
      return commitLoans(next);
    });
  };

  const addLoan = (type: Loan['type']) => {
    const newLoan: Loan = {
      id: `loan-${Date.now()}`,
      name: type === 'mortgage' ? 'משכנתא חדשה' : 'הלוואה חדשה',
      type,
      principal: 0,
      outstanding: 0,
      interestRate: 0,
      currency: 'ILS',
      monthlyPayment: 0,
      ...(type === 'mortgage' ? { propertyValue: 0 } : {}),
    };
    setAndCommit([...loans, newLoan]);
  };

  const removeLoan = (id: string) => {
    setAndCommit(loans.filter((l) => l.id !== id));
  };

  const toggleTracks = (id: string) => {
    setShowTracks((prev) => {
      const next = new Map(prev);
      next.set(id, !(prev.get(id) ?? true));
      return next;
    });
  };

  const isTracksOpen = (id: string) => showTracks.get(id) ?? true;

  const updateTrack = (loanId: string, trackId: string, field: keyof MortgageTrack, rawValue: string) => {
    setLoans((prev) => {
      const trackNumFields: (keyof MortgageTrack)[] = [
        'principal',
        'outstanding',
        'interestRate',
        'monthlyPayment',
        'monthsTotal',
        'monthsRemaining',
      ];
      const next = prev.map((l) => {
        if (l.id !== loanId) return l;
        const updatedTracks = (l.tracks ?? []).map((t) =>
          t.id === trackId
            ? { ...t, [field]: trackNumFields.includes(field) ? parseFloat(rawValue) || 0 : rawValue }
            : t,
        );
        const outstanding = updatedTracks.reduce((s, t) => s + t.outstanding, 0);
        const monthlyPayment = updatedTracks.reduce((s, t) => s + t.monthlyPayment, 0);
        return { ...l, tracks: updatedTracks, outstanding, monthlyPayment };
      });
      return commitLoans(next);
    });
  };

  // -------------------------------------------------------------------------
  // Slik import
  // -------------------------------------------------------------------------
  const handleSlikUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setImportFeedback('מעבד קובץ…');
    try {
      const tracks = await parseSlik(file);
      if (tracks.length === 0) {
        setImportFeedback('לא נמצאו מסלולים בקובץ');
        return;
      }
      setLoans((prev) => {
        const mortgageIdx = prev.findIndex((l) => l.type === 'mortgage' && l.currency === 'ILS');
        if (mortgageIdx === -1) {
          setImportFeedback(`יובאו ${tracks.length} מסלולים — לא נמצאה משכנתא בש"ח לשיוך`);
          return prev;
        }
        const outstanding = tracks.reduce((s, t) => s + t.outstanding, 0);
        const monthlyPayment = tracks.reduce((s, t) => s + t.monthlyPayment, 0);
        const next = prev.map((l, idx) =>
          idx === mortgageIdx ? { ...l, tracks, outstanding, monthlyPayment } : l,
        );
        setImportFeedback(`יובאו בהצלחה ${tracks.length} מסלולים`);
        return commitLoans(next);
      });
    } catch (err) {
      setImportFeedback(err instanceof Error ? err.message : 'שגיאה בייבוא');
    }
    // reset input so same file can be re-uploaded
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  // -------------------------------------------------------------------------
  // Summary totals
  // -------------------------------------------------------------------------
  const totalMonthly = loans.reduce((s, l) => s + toILS(l.monthlyPayment, l.currency), 0);
  const totalOutstanding = loans.reduce((s, l) => s + toILS(l.outstanding, l.currency), 0);
  const totalPaid = loans.reduce((s, l) => s + toILS(l.principal - l.outstanding, l.currency), 0);

  const getLinkedAsset = (loan: Loan): Asset | undefined =>
    portfolio.assets.find((a) => a.id === loan.linkedAssetId);

  const totalMonthlyRent = loans.reduce((s, l) => {
    const asset = getLinkedAsset(l);
    return s + toILS(asset?.monthlyRentalIncome ?? 0, l.currency);
  }, 0);

  const netMonthly = totalMonthlyRent - totalMonthly;

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------
  return (
    <div className="space-y-6">

      {/* ----------------------------------------------------------------- */}
      {/* Slik import card                                                   */}
      {/* ----------------------------------------------------------------- */}
      <div className="bg-white rounded-xl border border-blue-200 p-5">
        <h3 className="text-sm font-semibold text-blue-800 mb-3">ייבוא דוח סליקה — משכנתא</h3>
        <div className="flex flex-wrap items-center gap-3">
          <label className="cursor-pointer inline-flex items-center gap-2 bg-blue-600 text-white text-sm font-medium px-4 py-2 rounded-lg hover:bg-blue-700 transition-colors">
            <span>בחר קובץ Excel</span>
            <input
              ref={fileInputRef}
              type="file"
              accept=".xlsx,.xls"
              className="hidden"
              onChange={handleSlikUpload}
            />
          </label>
          {importFeedback && (
            <span className={`text-sm px-3 py-1.5 rounded-lg ${importFeedback.includes('שגיאה') || importFeedback.includes('לא נמצא') ? 'bg-red-50 text-red-600' : 'bg-green-50 text-green-700'}`}>
              {importFeedback}
            </span>
          )}
        </div>
        <p className="text-xs text-gray-400 mt-2">קובץ xlsx/xls מהבנק עם עמודות: מסלול, ריבית, יתרה, קרן, תשלום</p>
      </div>

      {/* ----------------------------------------------------------------- */}
      {/* Summary cards                                                      */}
      {/* ----------------------------------------------------------------- */}
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

      {/* ----------------------------------------------------------------- */}
      {/* Action buttons                                                     */}
      {/* ----------------------------------------------------------------- */}
      <div className="flex gap-3 flex-wrap">
        <button
          onClick={() => addLoan('private')}
          className="text-sm font-medium bg-gray-100 hover:bg-gray-200 text-gray-700 px-4 py-2 rounded-lg transition-colors"
        >
          + הוסף הלוואה
        </button>
        <button
          onClick={() => addLoan('mortgage')}
          className="text-sm font-medium bg-blue-50 hover:bg-blue-100 text-blue-700 px-4 py-2 rounded-lg transition-colors"
        >
          + הוסף משכנתא
        </button>
      </div>

      {/* ----------------------------------------------------------------- */}
      {/* Loan cards                                                         */}
      {/* ----------------------------------------------------------------- */}
      {loans.map((loan) => {
        if (loan.type === 'mortgage') {
          return (
            <MortgageLoanCard
              key={loan.id}
              loan={loan}
              linkedAsset={getLinkedAsset(loan)}
              tracksOpen={isTracksOpen(loan.id)}
              onToggleTracks={() => toggleTracks(loan.id)}
              onUpdateLoan={updateLoan}
              onUpdateTrack={updateTrack}
              onRemove={() => removeLoan(loan.id)}
            />
          );
        }
        return (
          <RegularLoanCard
            key={loan.id}
            loan={loan}
            onUpdateLoan={updateLoan}
            onRemove={() => removeLoan(loan.id)}
          />
        );
      })}

      {/* ----------------------------------------------------------------- */}
      {/* Net worth footer                                                   */}
      {/* ----------------------------------------------------------------- */}
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

// ---------------------------------------------------------------------------
// MortgageLoanCard
// ---------------------------------------------------------------------------
interface MortgageLoanCardProps {
  loan: Loan;
  linkedAsset: Asset | undefined;
  tracksOpen: boolean;
  onToggleTracks: () => void;
  onUpdateLoan: (id: string, field: keyof Loan, value: string) => void;
  onUpdateTrack: (loanId: string, trackId: string, field: keyof MortgageTrack, value: string) => void;
  onRemove: () => void;
}

const MortgageLoanCard: FC<MortgageLoanCardProps> = ({
  loan,
  linkedAsset,
  tracksOpen,
  onToggleTracks,
  onUpdateLoan,
  onUpdateTrack,
  onRemove,
}) => {
  const hasTracks = (loan.tracks ?? []).length > 0;

  const outstandingILS = toILS(loan.outstanding, loan.currency);
  const propValueILS = loan.propertyValue ? toILS(loan.propertyValue, loan.currency) : null;
  const ltv = propValueILS && propValueILS > 0 ? (outstandingILS / propValueILS) * 100 : null;
  const equity = propValueILS ? propValueILS - outstandingILS : null;
  const pctPaid = loan.principal > 0 ? ((loan.principal - loan.outstanding) / loan.principal) * 100 : 0;
  const sym = loan.currency === 'USD' ? '$' : '₪';

  const monthlyRent = linkedAsset?.monthlyRentalIncome ?? 0;
  const monthlyRentILS = toILS(monthlyRent, loan.currency);
  const monthlyPaymentILS = toILS(loan.monthlyPayment, loan.currency);
  const netCashFlow = monthlyRentILS - monthlyPaymentILS;
  const annualRent = monthlyRentILS * 12;
  const grossYield = propValueILS && propValueILS > 0 ? (annualRent / propValueILS) * 100 : 0;

  const tracks = loan.tracks ?? [];
  const tracksOutstanding = hasTracks ? tracks.reduce((s, t) => s + t.outstanding, 0) : loan.outstanding;
  const tracksMonthly = hasTracks ? tracks.reduce((s, t) => s + t.monthlyPayment, 0) : loan.monthlyPayment;
  const tracksPrincipal = hasTracks ? tracks.reduce((s, t) => s + t.principal, 0) : loan.principal;
  const tracksPaid = tracksPrincipal - tracksOutstanding;

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-6 space-y-5">
      {/* Header */}
      <div className="flex items-start justify-between flex-wrap gap-2">
        <div>
          <h3 className="text-base font-semibold text-gray-800">{loan.name}</h3>
          <p className="text-xs text-gray-400">
            משכנתא · {loan.currency} · {hasTracks ? `${tracks.length} מסלולים` : `ריבית ${loan.interestRate}%`}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {ltv !== null && (
            <span className={`text-sm font-bold px-3 py-1 rounded-full ${ltvBg(ltv)}`}>
              LTV {ltv.toFixed(1)}%
            </span>
          )}
          <button
            onClick={onRemove}
            className="text-gray-300 hover:text-red-500 text-xl font-bold leading-none transition-colors"
            title="מחק הלוואה"
          >
            ✕
          </button>
        </div>
      </div>

      {/* Tracks section */}
      <div className="border border-gray-100 rounded-xl overflow-hidden">
        <button
          onClick={onToggleTracks}
          className="w-full flex items-center justify-between px-4 py-3 bg-gray-50 hover:bg-gray-100 transition-colors text-right"
        >
          <span className="text-sm font-medium text-gray-700">מסלולים</span>
          <span className="text-gray-400 text-sm">{tracksOpen ? '▲' : '▼'}</span>
        </button>

        {tracksOpen && (
          <div className="p-4 space-y-4">
            {hasTracks ? (
              <>
                {/* Tracks table */}
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-xs text-gray-400 border-b border-gray-100">
                        <th className="text-right pb-2 pr-2">מסלול</th>
                        <th className="text-right pb-2">סוג</th>
                        <th className="text-right pb-2">ריבית %</th>
                        <th className="text-right pb-2">יתרה</th>
                        <th className="text-right pb-2">החזר חודשי</th>
                        <th className="text-right pb-2">חודשים נותרים</th>
                        <th className="pb-2"></th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-50">
                      {tracks.map((track) => {
                        const trackPct = track.principal > 0
                          ? Math.min(100, ((track.principal - track.outstanding) / track.principal) * 100)
                          : 0;
                        return (
                          <tr key={track.id} className="align-top">
                            <td className="py-2 pr-2">
                              <input
                                type="text"
                                value={track.name}
                                onChange={(e) => onUpdateTrack(loan.id, track.id, 'name', e.target.value)}
                                className="border border-gray-200 rounded px-2 py-1 text-xs w-28 focus:outline-none focus:ring-1 focus:ring-blue-400"
                              />
                            </td>
                            <td className="py-2">
                              <span className={`text-xs font-medium px-2 py-0.5 rounded-full whitespace-nowrap ${TRACK_TYPE_COLORS[track.trackType]}`}>
                                {TRACK_TYPE_LABELS[track.trackType]}
                              </span>
                            </td>
                            <td className="py-2">
                              <input
                                type="number"
                                step="0.01"
                                value={track.interestRate}
                                onChange={(e) => onUpdateTrack(loan.id, track.id, 'interestRate', e.target.value)}
                                className="border border-gray-200 rounded px-2 py-1 text-xs w-16 focus:outline-none focus:ring-1 focus:ring-blue-400"
                              />
                            </td>
                            <td className="py-2">
                              <div className="space-y-1">
                                <input
                                  type="number"
                                  step="1000"
                                  value={track.outstanding}
                                  onChange={(e) => onUpdateTrack(loan.id, track.id, 'outstanding', e.target.value)}
                                  className="border border-gray-200 rounded px-2 py-1 text-xs w-24 focus:outline-none focus:ring-1 focus:ring-blue-400"
                                />
                                <div className="w-24 bg-gray-100 rounded-full h-1.5">
                                  <div
                                    className="bg-blue-400 h-1.5 rounded-full"
                                    style={{ width: `${trackPct}%` }}
                                  />
                                </div>
                              </div>
                            </td>
                            <td className="py-2">
                              <input
                                type="number"
                                step="100"
                                value={track.monthlyPayment}
                                onChange={(e) => onUpdateTrack(loan.id, track.id, 'monthlyPayment', e.target.value)}
                                className="border border-gray-200 rounded px-2 py-1 text-xs w-20 focus:outline-none focus:ring-1 focus:ring-blue-400"
                              />
                            </td>
                            <td className="py-2">
                              <input
                                type="number"
                                step="1"
                                value={track.monthsRemaining}
                                onChange={(e) => onUpdateTrack(loan.id, track.id, 'monthsRemaining', e.target.value)}
                                className="border border-gray-200 rounded px-2 py-1 text-xs w-16 focus:outline-none focus:ring-1 focus:ring-blue-400"
                              />
                            </td>
                            <td className="py-2 text-xs text-gray-400 ps-2">
                              {trackPct.toFixed(0)}% שולם
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>

                {/* Tracks summary row */}
                <div className="grid grid-cols-3 gap-3 pt-2 border-t border-gray-100">
                  <InfoBlock label="יתרה כוללת" value={fILS(tracksOutstanding)} color="text-red-600" />
                  <InfoBlock label="החזר חודשי כולל" value={fILS(tracksMonthly)} color="text-orange-600" />
                  <InfoBlock label="שולם סה״כ" value={fILS(tracksPaid)} color="text-blue-600" />
                </div>
              </>
            ) : (
              /* No tracks: editable fields */
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <NumField label={`יתרת חוב (${sym})`} value={loan.outstanding} step="1000"
                  onChange={(v) => onUpdateLoan(loan.id, 'outstanding', v)} />
                <NumField label={`קרן מקורית (${sym})`} value={loan.principal} step="1000"
                  onChange={(v) => onUpdateLoan(loan.id, 'principal', v)} />
                <NumField label="תשלום חודשי" value={loan.monthlyPayment} step="100"
                  onChange={(v) => onUpdateLoan(loan.id, 'monthlyPayment', v)} />
                <NumField label="ריבית (%)" value={loan.interestRate} step="0.1"
                  onChange={(v) => onUpdateLoan(loan.id, 'interestRate', v)} />
              </div>
            )}
          </div>
        )}
      </div>

      {/* Property value field */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {loan.propertyValue !== undefined && (
          <NumField label={`שווי נכס (${sym})`} value={loan.propertyValue} step="10000"
            onChange={(v) => onUpdateLoan(loan.id, 'propertyValue', v)} />
        )}
      </div>

      {/* KPI row */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <InfoBlock
          label="שולם עד כה"
          value={fILS(toILS(tracksPaid, loan.currency))}
          sub={`${pctPaid.toFixed(0)}% מהקרן`}
          color="text-blue-700"
        />
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
};

// ---------------------------------------------------------------------------
// RegularLoanCard
// ---------------------------------------------------------------------------
interface RegularLoanCardProps {
  loan: Loan;
  onUpdateLoan: (id: string, field: keyof Loan, value: string) => void;
  onRemove: () => void;
}

const RegularLoanCard: FC<RegularLoanCardProps> = ({ loan, onUpdateLoan, onRemove }) => {
  const outstandingILS = toILS(loan.outstanding, loan.currency);
  const principalILS = toILS(loan.principal, loan.currency);
  const paidILS = principalILS - outstandingILS;
  const pctPaid = loan.principal > 0 ? (paidILS / principalILS) * 100 : 0;
  const sym = loan.currency === 'USD' ? '$' : '₪';

  // Months remaining calculation
  const r = loan.interestRate / 1200; // monthly rate
  let monthsRemaining = 0;
  if (loan.monthlyPayment > 0) {
    if (r > 0 && loan.monthlyPayment > loan.outstanding * r) {
      monthsRemaining = Math.ceil(
        Math.log(loan.monthlyPayment / (loan.monthlyPayment - loan.outstanding * r)) /
        Math.log(1 + r),
      );
    } else if (loan.outstanding > 0) {
      monthsRemaining = Math.round(loan.outstanding / loan.monthlyPayment);
    }
  }

  // Estimated end date
  let estimatedEnd = '';
  if (monthsRemaining > 0) {
    const endDate = new Date();
    endDate.setMonth(endDate.getMonth() + monthsRemaining);
    estimatedEnd = endDate.toLocaleDateString('he-IL', { month: '2-digit', year: 'numeric' });
  }

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-6 space-y-5">
      {/* Header */}
      <div className="flex items-start justify-between flex-wrap gap-2">
        <div>
          <h3 className="text-base font-semibold text-gray-800">{loan.name}</h3>
          <p className="text-xs text-gray-400">
            {LOAN_TYPE_LABELS[loan.type]} · {loan.currency}
          </p>
        </div>
        <button
          onClick={onRemove}
          className="text-gray-300 hover:text-red-500 text-xl font-bold leading-none transition-colors"
          title="מחק הלוואה"
        >
          ✕
        </button>
      </div>

      {/* Editable fields */}
      <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
        <NumField label={`יתרת חוב (${sym})`} value={loan.outstanding} step="1000"
          onChange={(v) => onUpdateLoan(loan.id, 'outstanding', v)} />
        <NumField label={`קרן מקורית (${sym})`} value={loan.principal} step="1000"
          onChange={(v) => onUpdateLoan(loan.id, 'principal', v)} />
        <NumField label="תשלום חודשי" value={loan.monthlyPayment} step="100"
          onChange={(v) => onUpdateLoan(loan.id, 'monthlyPayment', v)} />
        <NumField label="ריבית (%)" value={loan.interestRate} step="0.1"
          onChange={(v) => onUpdateLoan(loan.id, 'interestRate', v)} />
        <NumField label="תקופה כוללת (חודשים)" value={loan.termMonths ?? 0} step="1"
          onChange={(v) => onUpdateLoan(loan.id, 'termMonths', v)} />
        <div>
          <label className="block text-xs text-gray-500 mb-1">תאריך תחילה</label>
          <input
            type="date"
            value={loan.startDate ?? ''}
            onChange={(e) => onUpdateLoan(loan.id, 'startDate', e.target.value)}
            className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
      </div>

      {/* Computed info */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <InfoBlock
          label="שולם עד כה"
          value={fILS(paidILS)}
          sub={`${pctPaid.toFixed(0)}% מהקרן`}
          color="text-blue-700"
        />
        <InfoBlock
          label="חודשים נותרים"
          value={monthsRemaining > 0 ? String(monthsRemaining) : '—'}
          color="text-gray-700"
        />
        {estimatedEnd && (
          <InfoBlock label="סיום משוער" value={estimatedEnd} color="text-gray-700" />
        )}
        <InfoBlock label="ריבית שנתית" value={`${loan.interestRate}%`} color="text-orange-600" />
      </div>

      {/* Progress bar */}
      <div>
        <div className="flex justify-between text-xs text-gray-500 mb-1.5">
          <span>שולם: {sym}{(loan.principal - loan.outstanding).toLocaleString()}</span>
          <span>{pctPaid.toFixed(0)}%</span>
          <span>נותר: {sym}{loan.outstanding.toLocaleString()}</span>
        </div>
        <div className="w-full bg-gray-100 rounded-full h-3">
          <div
            className="bg-gradient-to-l from-green-500 to-green-400 h-3 rounded-full transition-all"
            style={{ width: `${Math.min(100, pctPaid)}%` }}
          />
        </div>
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Shared sub-components
// ---------------------------------------------------------------------------
const SummaryCard: FC<{ label: string; value: string; color: string; sub?: string }> = ({
  label, value, color, sub,
}) => (
  <div className="bg-white rounded-xl border border-gray-200 p-4">
    <p className="text-xs text-gray-500">{label}</p>
    <p className={`text-xl font-bold mt-1 ${color}`}>{value}</p>
    {sub && <p className="text-xs text-gray-400 mt-0.5">{sub}</p>}
  </div>
);

const InfoBlock: FC<{ label: string; value: string; color?: string; sub?: string }> = ({
  label, value, color = 'text-gray-800', sub,
}) => (
  <div className="bg-gray-50 rounded-lg p-3">
    <p className="text-xs text-gray-500 mb-1">{label}</p>
    <p className={`font-bold text-base ${color}`}>{value}</p>
    {sub && <p className="text-xs text-gray-400 mt-0.5">{sub}</p>}
  </div>
);

const NumField: FC<{ label: string; value: number; onChange: (v: string) => void; step?: string }> = ({
  label, value, onChange, step = '1000',
}) => (
  <div>
    <label className="block text-xs text-gray-500 mb-1">{label}</label>
    <input
      type="number"
      step={step}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
    />
  </div>
);

export default LoansTab;
