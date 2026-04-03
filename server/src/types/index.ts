export interface Transaction {
  id: string;
  date: string;
  description: string;
  amount: number;
  currency: 'ILS' | 'USD';
  category?: string;
  source: 'bank' | 'credit_card';
  bankName?: string;
}

export interface Asset {
  id: string;
  name: string;
  type: 'real_estate' | 'stock' | 'savings';
  value: number;
  currency: 'ILS' | 'USD';
  location?: string;
}

export interface Loan {
  id: string;
  name: string;
  principal: number;
  outstanding: number;
  interestRate: number;
  currency: 'ILS' | 'USD';
  monthlyPayment: number;
  propertyValue?: number; // for LTV calculation
}

export interface Portfolio {
  assets: Asset[];
  loans: Loan[];
  totalAssetsILS: number;
  totalLiabilitiesILS: number;
  netWorthILS: number;
}
