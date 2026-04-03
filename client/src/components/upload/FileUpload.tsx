import { type FC, useRef, useState } from 'react';
import type { BankSource, Transaction } from '../../types';
import * as XLSX from 'xlsx';
import Papa from 'papaparse';

interface FileUploadProps {
  onTransactionsLoaded: (transactions: Transaction[]) => void;
}

const BANK_OPTIONS: { value: BankSource; label: string }[] = [
  { value: 'poalim', label: 'בנק הפועלים' },
  { value: 'leumi', label: 'בנק לאומי' },
  { value: 'max', label: 'MAX (כרטיס אשראי)' },
  { value: 'isracard', label: 'ישראכרט (כרטיס אשראי)' },
  { value: 'other', label: 'אחר' },
];

/** Convert any date format → YYYY-MM-DD */
const normalizeDate = (raw: unknown): string => {
  if (typeof raw === 'number') {
    // Excel serial date
    const d = XLSX.SSF.parse_date_code(raw);
    return `${d.y}-${String(d.m).padStart(2, '0')}-${String(d.d).padStart(2, '0')}`;
  }
  const s = String(raw ?? '').trim().replace(/\u200f/g, ''); // strip RTL marks
  if (!s) return '';
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  // DD/MM/YYYY or DD.MM.YYYY
  const dmy = s.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})/);
  if (dmy) return `${dmy[3]}-${dmy[2].padStart(2, '0')}-${dmy[1].padStart(2, '0')}`;
  // MM/DD/YYYY
  const mdy = s.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})/);
  if (mdy && parseInt(mdy[1]) > 12) return `${mdy[3]}-${mdy[1].padStart(2, '0')}-${mdy[2].padStart(2, '0')}`;
  return s;
};

/** Find a column value by trying multiple candidate names */
const pickCol = (row: Record<string, unknown>, candidates: string[]): unknown => {
  const keys = Object.keys(row);
  for (const c of candidates) {
    const exact = keys.find((k) => k.trim() === c);
    if (exact) return row[exact];
  }
  for (const c of candidates) {
    const ci = keys.find((k) => k.trim().toLowerCase() === c.toLowerCase());
    if (ci) return row[ci];
  }
  for (const c of candidates) {
    const partial = keys.find((k) => k.trim().toLowerCase().includes(c.toLowerCase()));
    if (partial) return row[partial];
  }
  return undefined;
};

/** Parse a numeric string that may contain commas or currency symbols */
const parseAmount = (raw: unknown): number => {
  const s = String(raw ?? '').replace(/[,\s₪$]/g, '').trim();
  return parseFloat(s) || 0;
};

const parseRows = (
  rows: Record<string, unknown>[],
  source: BankSource,
  fileIndex: number
): Transaction[] => {
  const isCreditCard = source === 'max' || source === 'isracard';
  const txSource: 'bank' | 'credit_card' = isCreditCard ? 'credit_card' : 'bank';

  return rows
    .map((row, i) => {
      const rawDate = pickCol(row, [
        'תאריך', 'תאריך ערך', 'תאריך עסקה', 'תאריך חיוב', 'תאריך פעולה',
        'date', 'Date', 'DATE',
      ]);
      const rawDesc = pickCol(row, [
        'תיאור', 'פרטים', 'שם בית עסק', 'שם בעסק', 'נושא', 'תיאור פעולה',
        'description', 'Description', 'narrative', 'Narrative', 'מוטב',
      ]);
      // Some banks have separate debit/credit columns
      const rawDebit = pickCol(row, ['חובה', 'הוצאה', 'חיוב', 'debit', 'Debit']);
      const rawCredit = pickCol(row, ['זכות', 'הכנסה', 'זיכוי', 'credit', 'Credit']);
      const rawAmount = pickCol(row, [
        'סכום', 'סכום חיוב', 'סכום עסקה', 'סכום ב-₪', 'סכום בש"ח', 'סכום פעולה',
        'amount', 'Amount', 'AMOUNT', 'סכום בשח',
      ]);

      let amount: number;
      let isDebit: boolean;

      if (rawDebit !== undefined && rawCredit !== undefined) {
        const d = parseAmount(rawDebit);
        const c = parseAmount(rawCredit);
        if (d > 0) { amount = d; isDebit = true; }
        else if (c > 0) { amount = c; isDebit = false; }
        else { amount = 0; isDebit = true; }
      } else {
        const raw = parseAmount(rawAmount ?? rawDebit ?? rawCredit ?? 0);
        amount = Math.abs(raw);
        // Credit cards: positive = charge (debit)
        // Bank accounts: negative = debit
        isDebit = isCreditCard ? raw > 0 : raw < 0;
      }

      const date = normalizeDate(rawDate);
      const description = String(rawDesc ?? '').trim().replace(/\u200f/g, '');

      if (!description && amount === 0) return null;

      return {
        id: `${source}-f${fileIndex}-r${i}`,
        date,
        description,
        amount,
        currency: 'ILS' as const,
        source: txSource,
        bankName: source,
        isDebit,
      };
    })
    .filter((tx): tx is Transaction => tx !== null && tx.amount > 0);
};

interface ParseResult {
  transactions: Transaction[];
  detectedColumns: string[];
  sampleRows: Transaction[];
  skippedBadDate: number;
}

const FileUpload: FC<FileUploadProps> = ({ onTransactionsLoaded }) => {
  const inputRef = useRef<HTMLInputElement>(null);
  const [selectedBank, setSelectedBank] = useState<BankSource>('poalim');
  const [isDragging, setIsDragging] = useState(false);
  const [result, setResult] = useState<ParseResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const parseFile = (file: File, fileIndex: number) => {
    const isCsv = file.name.toLowerCase().endsWith('.csv');
    const reader = new FileReader();

    reader.onload = (e) => {
      const data = e.target?.result;
      if (!data) return;

      let rows: Record<string, unknown>[] = [];
      let detectedColumns: string[] = [];

      try {
        if (isCsv) {
          const parsed = Papa.parse<Record<string, unknown>>(data as string, {
            header: true,
            skipEmptyLines: true,
          });
          rows = parsed.data;
        } else {
          const wb = XLSX.read(data, { type: 'binary', cellDates: false });
          const sheet = wb.Sheets[wb.SheetNames[0]];
          rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: '' });
        }

        if (rows.length > 0) {
          detectedColumns = Object.keys(rows[0]);
        }

        const transactions = parseRows(rows, selectedBank, fileIndex);
        const skippedBadDate = transactions.filter((t) => !/^\d{4}-\d{2}-\d{2}/.test(t.date)).length;

        setResult({
          transactions,
          detectedColumns,
          sampleRows: transactions.slice(0, 5),
          skippedBadDate,
        });
        setError(null);
        onTransactionsLoaded(transactions);
      } catch (err) {
        setError(`שגיאה בפרסור: ${String(err)}`);
      }
    };

    if (isCsv) {
      reader.readAsText(file, 'windows-1255');
    } else {
      reader.readAsBinaryString(file);
    }
  };

  const handleFiles = (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setResult(null);
    setError(null);
    Array.from(files).forEach((f, i) => parseFile(f, i));
  };

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-6 space-y-4">
      <h3 className="text-lg font-semibold text-gray-800">ייבוא נתונים מהבנק</h3>

      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">מקור הקובץ</label>
        <select
          value={selectedBank}
          onChange={(e) => setSelectedBank(e.target.value as BankSource)}
          className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
        >
          {BANK_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      </div>

      <div
        className={`border-2 border-dashed rounded-xl p-8 text-center cursor-pointer transition-colors ${
          isDragging ? 'border-blue-500 bg-blue-50' : 'border-gray-300 hover:border-blue-400 hover:bg-gray-50'
        }`}
        onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
        onDragLeave={() => setIsDragging(false)}
        onDrop={(e) => { e.preventDefault(); setIsDragging(false); handleFiles(e.dataTransfer.files); }}
        onClick={() => inputRef.current?.click()}
      >
        <p className="text-3xl mb-2">📁</p>
        <p className="text-gray-600 font-medium">גרור קובץ לכאן או לחץ לבחירה</p>
        <p className="text-sm text-gray-400 mt-1">Excel (.xlsx) · CSV — ייצוא ישיר מהבנק</p>
        <input ref={inputRef} type="file" accept=".xlsx,.csv,.xls" multiple className="hidden"
          onChange={(e) => handleFiles(e.target.files)} />
      </div>

      {error && <p className="text-red-500 text-sm">❌ {error}</p>}

      {/* Parsed result preview — critical for debugging correlation */}
      {result && (
        <div className="space-y-3">
          <div className="flex items-center gap-3 flex-wrap">
            <span className={`text-sm font-semibold px-3 py-1 rounded-full ${
              result.transactions.length > 0 ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-600'
            }`}>
              {result.transactions.length > 0 ? `✅ ${result.transactions.length} תנועות` : '⚠️ 0 תנועות נמצאו'}
            </span>
            <span className="text-xs text-gray-400">
              {result.transactions.filter(t => t.isDebit).length} הוצאות ·{' '}
              {result.transactions.filter(t => !t.isDebit).length} הכנסות
            </span>
            {result.skippedBadDate > 0 && (
              <span className="text-xs text-orange-500">⚠️ {result.skippedBadDate} תנועות בלי תאריך תקין</span>
            )}
          </div>

          {/* Column detection */}
          <details className="text-xs text-gray-400">
            <summary className="cursor-pointer hover:text-gray-600">עמודות שזוהו ({result.detectedColumns.length})</summary>
            <p className="mt-1 bg-gray-50 p-2 rounded break-words">{result.detectedColumns.join(' | ')}</p>
          </details>

          {/* Sample of parsed transactions — shows exactly what the chart will display */}
          {result.sampleRows.length > 0 && (
            <div>
              <p className="text-xs text-gray-500 mb-1 font-medium">תצוגה מקדימה (5 ראשונות):</p>
              <div className="overflow-x-auto rounded-lg border border-gray-100">
                <table className="w-full text-xs">
                  <thead className="bg-gray-50">
                    <tr>
                      <th className="text-right px-3 py-2 font-medium text-gray-600">תאריך</th>
                      <th className="text-right px-3 py-2 font-medium text-gray-600">תיאור</th>
                      <th className="text-right px-3 py-2 font-medium text-gray-600">סכום</th>
                      <th className="text-right px-3 py-2 font-medium text-gray-600">סוג</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.sampleRows.map((tx) => (
                      <tr key={tx.id} className="border-t border-gray-100">
                        <td className={`px-3 py-1.5 font-mono ${/^\d{4}-\d{2}-\d{2}/.test(tx.date) ? 'text-gray-700' : 'text-red-500'}`}>
                          {tx.date || '—'}
                        </td>
                        <td className="px-3 py-1.5 text-gray-700 max-w-xs truncate">{tx.description}</td>
                        <td className="px-3 py-1.5 font-medium">₪{tx.amount.toLocaleString()}</td>
                        <td className={`px-3 py-1.5 font-medium ${tx.isDebit ? 'text-red-500' : 'text-green-600'}`}>
                          {tx.isDebit ? 'הוצאה' : 'הכנסה'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {result.skippedBadDate > 0 && (
                <p className="text-xs text-orange-500 mt-1">
                  * תאריכים אדומים = פורמט לא מזוהה ויסוננו מהגרפים. ודא שהקובץ ייוצא כ-Excel ולא כ-PDF.
                </p>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default FileUpload;
