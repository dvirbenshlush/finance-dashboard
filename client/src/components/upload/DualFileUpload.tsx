import { type FC, useRef, useState } from 'react';
import type { BankSource, Transaction } from '../../types';
import * as XLSX from 'xlsx';
import Papa from 'papaparse';

interface DualFileUploadProps {
  onTransactionsLoaded: (transactions: Transaction[]) => void;
}

// ---- Parsing helpers (shared) ----

const normalizeDate = (raw: unknown): string => {
  if (typeof raw === 'number') {
    const d = XLSX.SSF.parse_date_code(raw);
    return `${d.y}-${String(d.m).padStart(2, '0')}-${String(d.d).padStart(2, '0')}`;
  }
  const s = String(raw ?? '').trim().replace(/\u200f/g, '');
  if (!s) return '';
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const dmy = s.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})/);
  if (dmy) return `${dmy[3]}-${dmy[2].padStart(2, '0')}-${dmy[1].padStart(2, '0')}`;
  return s;
};

const pickCol = (row: Record<string, unknown>, candidates: string[]): unknown => {
  const keys = Object.keys(row);
  for (const c of candidates) {
    const hit = keys.find((k) => k.trim() === c) ?? keys.find((k) => k.trim().toLowerCase() === c.toLowerCase()) ?? keys.find((k) => k.trim().toLowerCase().includes(c.toLowerCase()));
    if (hit) return row[hit];
  }
  return undefined;
};

const parseAmount = (raw: unknown): number =>
  parseFloat(String(raw ?? '').replace(/[,\s₪$]/g, '').trim()) || 0;

/** Stable deterministic ID from content — same file always produces same IDs */
const stableId = (source: BankSource, date: string, desc: string, amount: number, rowIdx: number): string => {
  const raw = `${source}|${date}|${desc.slice(0, 40)}|${Math.round(amount * 100)}|${rowIdx}`;
  let h = 5381;
  for (let i = 0; i < raw.length; i++) h = ((h << 5) + h) ^ raw.charCodeAt(i);
  return `${source}-${(h >>> 0).toString(36)}`;
};

/**
 * Israeli bank/CC exports often have metadata rows (logo, date range, account number)
 * before the actual table. This function scans each row for known Hebrew column keywords
 * and re-parses from the first row that looks like a real header.
 */
const HEADER_KEYWORDS = [
  'תאריך', 'date', 'סכום', 'amount', 'פרטים', 'תיאור', 'שם בית עסק',
  'חובה', 'זכות', 'מוטב', 'שם הפעולה', 'אסמכתא',
];

const parseXlsxWithSmartHeader = (sheet: XLSX.WorkSheet): Record<string, unknown>[] => {
  // Read as raw 2D array first
  const raw = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: '' }) as unknown[][];
  if (raw.length === 0) return [];

  // Find the first row that contains at least 2 header keywords
  let headerRowIdx = 0;
  for (let i = 0; i < Math.min(raw.length, 20); i++) {
    const rowStr = raw[i].map((c) => String(c ?? '').trim().toLowerCase());
    const hits = HEADER_KEYWORDS.filter((kw) => rowStr.some((cell) => cell.includes(kw.toLowerCase())));
    if (hits.length >= 2) { headerRowIdx = i; break; }
  }

  // Extract headers from the found row
  const headers = raw[headerRowIdx].map((c) => String(c ?? '').trim().replace(/\u200f/g, ''));

  // Build row objects from all rows after the header
  const result: Record<string, unknown>[] = [];
  for (let i = headerRowIdx + 1; i < raw.length; i++) {
    const row: Record<string, unknown> = {};
    let hasValue = false;
    headers.forEach((h, j) => {
      if (h) { row[h] = raw[i][j] ?? ''; if (raw[i][j]) hasValue = true; }
    });
    if (hasValue) result.push(row);
  }
  return result;
};

const parseRows = (rows: Record<string, unknown>[], source: BankSource): Transaction[] =>
  rows.map((row, i) => {
    const rawDate = pickCol(row, ['תאריך', 'תאריך ערך', 'תאריך עסקה', 'תאריך חיוב', 'תאריך פעולה', 'date', 'Date']);
    const rawDesc = pickCol(row, ['תיאור', 'פרטים', 'שם בית עסק', 'שם בעסק', 'נושא', 'תיאור פעולה', 'description', 'Description', 'מוטב']);
    const rawDebit = pickCol(row, ['חובה', 'הוצאה', 'חיוב', 'debit', 'Debit']);
    const rawCredit = pickCol(row, ['זכות', 'הכנסה', 'זיכוי', 'credit', 'Credit']);
    const rawAmount = pickCol(row, ['סכום', 'סכום חיוב', 'סכום עסקה', 'סכום ב-₪', 'סכום בש"ח', 'סכום פעולה', 'amount', 'Amount', 'סכום בשח']);

    const isCreditCard = source === 'max' || source === 'isracard';
    const txSource: 'bank' | 'credit_card' = isCreditCard ? 'credit_card' : 'bank';

    let amount: number;
    let isDebit: boolean;

    if (rawDebit !== undefined && rawCredit !== undefined) {
      const d = parseAmount(rawDebit), c = parseAmount(rawCredit);
      if (d > 0) { amount = d; isDebit = true; }
      else if (c > 0) { amount = c; isDebit = false; }
      else { amount = 0; isDebit = true; }
    } else {
      const raw = parseAmount(rawAmount ?? rawDebit ?? rawCredit ?? 0);
      amount = Math.abs(raw);
      isDebit = isCreditCard ? raw > 0 : raw < 0;
    }

    const date = normalizeDate(rawDate);
    const description = String(rawDesc ?? '').trim().replace(/\u200f/g, '');

    if (!description && amount === 0) return null;
    return {
      id: stableId(source, date, description, amount, i),
      date, description, amount, currency: 'ILS' as const,
      source: txSource, bankName: source, isDebit,
      category: undefined, // AI will categorize everything
    };
  }).filter((tx): tx is Transaction => tx !== null && tx.amount > 0);

/**
 * Remove credit-card payment rows from bank account transactions to avoid double-counting.
 * Israeli bank statements include a single lump-sum debit for each credit card payment.
 * Since we already import the credit card detail, we remove those rows.
 */
const removeCreditCardPayments = (bankTxs: Transaction[]): Transaction[] => {
  const CC_PATTERNS = [
    /ויזה/i, /visa/i, /מקס/i, /max/i, /ישראכרט/i, /isracard/i,
    /לאומי קארד/i, /cal\b/i, /כאל/i, /דיינרס/i, /diners/i,
    /תשלום כרטיס/i, /חיוב כרטיס/i,
  ];
  return bankTxs.filter(
    (tx) => !(tx.isDebit && CC_PATTERNS.some((re) => re.test(tx.description)))
  );
};

// ---- Single upload zone ----
interface UploadZoneProps {
  title: string;
  subtitle: string;
  icon: string;
  accentClass: string;
  bankOptions: { value: BankSource; label: string }[];
  onParsed: (txs: Transaction[], fileName: string, cols: string[]) => void;
}

const UploadZone: FC<UploadZoneProps> = ({ title, subtitle, icon, accentClass, bankOptions, onParsed }) => {
  const inputRef = useRef<HTMLInputElement>(null);
  const [selectedBank, setSelectedBank] = useState<BankSource>(bankOptions[0].value);
  const [isDragging, setIsDragging] = useState(false);

  const parseFile = (file: File) => {
    const isCsv = file.name.toLowerCase().endsWith('.csv');
    const reader = new FileReader();
    reader.onload = (e) => {
      const data = e.target?.result;
      if (!data) return;
      let rows: Record<string, unknown>[] = [];
      let cols: string[] = [];
      try {
        if (isCsv) {
          const result = Papa.parse<Record<string, unknown>>(data as string, { header: true, skipEmptyLines: true });
          rows = result.data;
        } else {
          const wb = XLSX.read(data, { type: 'binary', cellDates: false });
          const sheet = wb.Sheets[wb.SheetNames[0]];
          rows = parseXlsxWithSmartHeader(sheet);
        }
        if (rows.length > 0) cols = Object.keys(rows[0]);
        onParsed(parseRows(rows, selectedBank), file.name, cols);
      } catch {/* ignore */}
    };
    isCsv ? reader.readAsText(file, 'windows-1255') : reader.readAsBinaryString(file);
  };

  const handleFiles = (files: FileList | null) => {
    if (files) Array.from(files).forEach(parseFile);
  };

  return (
    <div className="flex-1 space-y-3">
      <div className={`flex items-center gap-2 text-base font-semibold ${accentClass}`}>
        <span className="text-2xl">{icon}</span>
        <div>
          <p>{title}</p>
          <p className="text-xs font-normal text-gray-400">{subtitle}</p>
        </div>
      </div>

      <select
        value={selectedBank}
        onChange={(e) => setSelectedBank(e.target.value as BankSource)}
        className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
      >
        {bankOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>

      <div
        className={`border-2 border-dashed rounded-xl p-6 text-center cursor-pointer transition-colors ${
          isDragging ? 'border-blue-500 bg-blue-50' : 'border-gray-300 hover:border-blue-400 hover:bg-gray-50'
        }`}
        onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
        onDragLeave={() => setIsDragging(false)}
        onDrop={(e) => { e.preventDefault(); setIsDragging(false); handleFiles(e.dataTransfer.files); }}
        onClick={() => inputRef.current?.click()}
      >
        <p className="text-gray-500 text-sm">גרור קובץ או לחץ לבחירה</p>
        <p className="text-xs text-gray-400 mt-1">.xlsx · .csv</p>
        <input ref={inputRef} type="file" accept=".xlsx,.csv,.xls" multiple className="hidden"
          onChange={(e) => handleFiles(e.target.files)} />
      </div>
    </div>
  );
};

// ---- Main dual upload ----
interface FileStatus {
  name: string;
  count: number;
  source: 'bank' | 'credit_card';
  cols: string[];
}

const DualFileUpload: FC<DualFileUploadProps> = ({ onTransactionsLoaded }) => {
  const [bankTxs, setBankTxs] = useState<Transaction[]>([]);
  const [ccTxs, setCcTxs] = useState<Transaction[]>([]);
  const [bankStatus, setBankStatus] = useState<FileStatus | null>(null);
  const [ccStatus, setCcStatus] = useState<FileStatus | null>(null);

  const merge = (bank: Transaction[], cc: Transaction[]) => {
    const cleanBank = removeCreditCardPayments(bank);
    // Deduplicate by id across both sources
    const all = [...cleanBank, ...cc];
    const seen = new Set<string>();
    const unique = all.filter((tx) => { if (seen.has(tx.id)) return false; seen.add(tx.id); return true; });
    onTransactionsLoaded(unique);
  };

  const handleBank = (txs: Transaction[], name: string, cols: string[]) => {
    setBankTxs(txs);
    setBankStatus({ name, count: txs.length, source: 'bank', cols });
    merge(txs, ccTxs);
  };

  const handleCC = (txs: Transaction[], name: string, cols: string[]) => {
    setCcTxs(txs);
    setCcStatus({ name, count: txs.length, source: 'credit_card', cols });
    merge(bankTxs, txs);
  };

  const totalLoaded = bankTxs.length + ccTxs.length;
  const ccPaymentsRemoved = bankTxs.length > 0 && ccTxs.length > 0
    ? bankTxs.length - removeCreditCardPayments(bankTxs).length
    : 0;

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-6 space-y-5">
      <div>
        <h3 className="text-base font-semibold text-gray-800">ייבוא נתונים</h3>
        <p className="text-xs text-gray-400 mt-0.5">טען חשבון עו"ש וכרטיס אשראי בנפרד — המיזוג אוטומטי</p>
      </div>

      <div className="flex flex-col md:flex-row gap-5">
        <UploadZone
          title='חשבון עו"ש'
          subtitle="פועלים, לאומי, מזרחי..."
          icon="🏦"
          accentClass="text-blue-700"
          bankOptions={[
            { value: 'poalim', label: 'בנק הפועלים' },
            { value: 'leumi', label: 'בנק לאומי' },
            { value: 'other', label: 'בנק אחר' },
          ]}
          onParsed={handleBank}
        />

        {/* Divider */}
        <div className="hidden md:flex flex-col items-center justify-center gap-2 text-gray-300">
          <div className="w-px flex-1 bg-gray-200" />
          <span className="text-xs font-medium text-gray-400">+</span>
          <div className="w-px flex-1 bg-gray-200" />
        </div>

        <UploadZone
          title="כרטיס אשראי / ויזה"
          subtitle="MAX, ישראכרט, ויזה כאל..."
          icon="💳"
          accentClass="text-purple-700"
          bankOptions={[
            { value: 'max', label: 'MAX (לאומי קארד / כאל)' },
            { value: 'isracard', label: 'ישראכרט' },
            { value: 'other', label: 'אחר' },
          ]}
          onParsed={handleCC}
        />
      </div>

      {/* Status */}
      {(bankStatus || ccStatus) && (
        <div className="space-y-2">
          {bankStatus && (
            <StatusRow icon="🏦" label={`עו"ש — ${bankStatus.name}`} count={bankStatus.count} cols={bankStatus.cols} color="text-blue-700" />
          )}
          {ccStatus && (
            <StatusRow icon="💳" label={`ויזה — ${ccStatus.name}`} count={ccStatus.count} cols={ccStatus.cols} color="text-purple-700" />
          )}
          {totalLoaded > 0 && (
            <div className="bg-green-50 border border-green-200 rounded-lg px-4 py-2 flex items-center justify-between">
              <span className="text-sm font-medium text-green-700">
                ✅ {totalLoaded} תנועות סה"כ
                {ccPaymentsRemoved > 0 && ` · ${ccPaymentsRemoved} תשלומי אשראי הוסרו ממניית כפילויות`}
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

const StatusRow: FC<{ icon: string; label: string; count: number; cols: string[]; color: string }> = ({
  icon, label, count, cols, color,
}) => (
  <details className="text-sm">
    <summary className={`cursor-pointer font-medium ${color} flex items-center gap-2`}>
      <span>{icon}</span>
      <span>{label}</span>
      <span className="text-xs font-normal text-gray-500 mr-1">({count} תנועות)</span>
    </summary>
    <p className="mt-1 text-xs text-gray-400 bg-gray-50 rounded px-2 py-1 break-words">
      עמודות: {cols.join(' · ')}
    </p>
  </details>
);

export default DualFileUpload;
