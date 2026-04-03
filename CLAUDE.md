# Personal Finance Dashboard (RiseUp Concept) - CLAUDE.md

## Project Vision
A holistic financial "Command Center" for Dvir. Consolidates multi-source Israeli bank movements, credit cards, global real estate (Rishon LeZion & Cleveland), stock portfolios (VOO, IBIT), and long-term savings. 

## Tech Stack (Requested)
- **Frontend:** React + Vite, TypeScript, Tailwind CSS.
- **Backend:** Node.js, TypeScript, Express/Fastify.
- **AI Engine:** Google Gemini 1.5 Pro/Flash API (via `@google/generative-ai`).
- **Charts:** Recharts (React-optimized).
- **Data Parsing:** `xlsx` & `papaparse` for Excel/CSV handling.

## Core Modules & Features
### 1. Data Ingestion (Manual Excel/CSV)
- Support for Israeli bank exports (Poalim, Leumi, etc.) and credit cards (Max, Isracard).
- Intelligent merging: Avoid double-counting of credit card debits vs. bank movements.

### 2. Dashboard Tabs (RTL UI)
- **Cashflow:** Monthly average expenses, burn rate, and income vs. spending.
- **Categorization:** AI-powered sector tagging (Food, Rent, Investment, Subscriptions).
- **Assets Portfolio:** - Real Estate: Tracking properties in Israel and Cleveland, Ohio.
    - Stocks: Tracking units of VOO, IBIT, and other ETFs.
    - Savings: Manual input for Pension and Education Fund (Keren Hishtalmut).
- **Loans & Liabilities:** Tracking mortgages, private loans, and leverage (LTV calculations).

### 3. Gemini AI Intelligence
- **Anomaly Detection:** Identify spikes or unusual "leaks" in recurring expenses.
- **Geopolitical/Macro Context:** Use Gemini's context window to correlate spending/investments with current market trends.
- **Financial Freedom Tracker:** Estimate "Time to Retire" based on current net worth and burn rate.

## Development Rules
- **UI/UX:** Language must be **Hebrew** (RTL). Components from Shadcn/UI.
- **Codebase:** English (Variables, Comments, Documentation).
- **Currency:** Primary in **ILS**, Secondary in **USD** (for US assets).
- **Types:** Strict TypeScript interfaces for `Transaction`, `Asset`, `Loan`, and `Portfolio`.
- **Security:** API Keys and sensitive data stored in `.env`. Local-first data processing.

## Commands
- **Init Project:** `npm init -y` (Manual split to `/frontend` and `/backend`)
- **Dev (Fullstack):** `npm run dev` (using concurrently)
- **Build:** `npm run build`