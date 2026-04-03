export interface Transaction {
  id: string;
  date: string;
  description: string;
  amount: number;
  currency: 'ILS' | 'USD';
  category?: TransactionCategory;
  source: 'bank' | 'credit_card';
  bankName?: BankSource;
  isDebit: boolean;
}

export type TransactionCategory =
  // ---- Income ----
  | 'salary'            // משכורת
  | 'rental_income'     // שכר דירה שמתקבל
  | 'refund'            // החזר / זיכוי
  | 'transfer_in'       // העברה נכנסת
  // ---- Housing ----
  | 'mortgage'          // משכנתא
  | 'rent_paid'         // שכר דירה שמשולם
  | 'home_expenses'     // הוצאות בית (ועד, ארנונה)
  // ---- Food ----
  | 'food_restaurant'   // אוכל בחוץ / מסעדות
  | 'groceries'         // סופרמרקט
  // ---- Transport ----
  | 'car'               // רכב
  | 'public_transport'  // תחב"צ
  // ---- Other spending ----
  | 'shopping'          // קניות
  | 'subscriptions'     // מנויים
  | 'health'            // בריאות
  | 'utilities'         // חשבונות (חשמל, מים, סלולר)
  | 'education'         // חינוך
  | 'entertainment'     // בידור
  | 'travel'            // טיסות ונסיעות
  | 'investment'        // השקעות
  | 'other';

export type BankSource = 'poalim' | 'leumi' | 'max' | 'isracard' | 'other';

export interface Asset {
  id: string;
  name: string;
  type: 'real_estate' | 'stock' | 'savings';
  value: number;
  currency: 'ILS' | 'USD';
  location?: string;
  address?: string;
  propertyType?: 'apartment' | 'house' | 'commercial';
  monthlyRentalIncome?: number;
  purchasePrice?: number;
  ticker?: string;
  units?: number;
  pricePerUnit?: number;
  avgBuyPrice?: number;
  savingsType?: 'pension' | 'keren_hishtalmut' | 'other';
}

export interface Loan {
  id: string;
  name: string;
  type: 'mortgage' | 'private' | 'car' | 'other';
  principal: number;
  outstanding: number;
  interestRate: number;
  currency: 'ILS' | 'USD';
  monthlyPayment: number;
  propertyValue?: number;
  linkedAssetId?: string;
}

export interface Portfolio {
  assets: Asset[];
  loans: Loan[];
  totalAssetsILS: number;
  totalLiabilitiesILS: number;
  netWorthILS: number;
}

export interface MonthlyData {
  month: string;
  monthKey: string;
  income: number;
  expenses: number;
  balance: number;
}

export interface GeminiInsight {
  type: 'anomaly' | 'tip' | 'freedom_tracker';
  title: string;
  description: string;
  severity?: 'low' | 'medium' | 'high';
}
