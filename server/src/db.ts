/**
 * db.ts — PostgreSQL connection pool (Supabase or any Postgres provider)
 *
 * ── How to set up Supabase (free, remote, accessible from anywhere) ──────────
 *
 * 1. Go to https://supabase.com and create a free account
 * 2. Click "New project", choose a name and a strong database password
 * 3. Once the project is ready, go to:
 *      Settings → Database → Connection string → URI (Node.js)
 *    Copy the connection string. It looks like:
 *      postgresql://postgres:[YOUR-PASSWORD]@db.xxxx.supabase.co:5432/postgres
 * 4. Add it to server/.env:
 *      DATABASE_URL=postgresql://postgres:[YOUR-PASSWORD]@db.xxxx.supabase.co:5432/postgres
 * 5. Run the app — tables are created automatically on first start.
 *
 * ── How to view your data ────────────────────────────────────────────────────
 * Option A — Supabase web dashboard:
 *   https://app.supabase.com → your project → Table Editor
 *   (view, filter, edit rows; SQL editor also available)
 *
 * Option B — any PostgreSQL client (DBeaver, TablePlus, psql):
 *   Use the connection string from step 3 above.
 *
 * Option C — Supabase SQL editor (browser):
 *   https://app.supabase.com → your project → SQL Editor
 */

import dotenv from 'dotenv';
dotenv.config();   // load .env before anything reads process.env

import { Pool } from 'pg';

if (!process.env.DATABASE_URL) {
  console.error('❌  DATABASE_URL is not set. Add it to server/.env');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL.includes('supabase.co')
    ? { rejectUnauthorized: false }
    : false,
});

/** Run once on startup — creates tables if they don't exist yet. */
export async function initDb(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS bank_transactions (
      id          TEXT    PRIMARY KEY,
      date        TEXT    NOT NULL,
      description TEXT,
      amount      REAL    NOT NULL,
      currency    TEXT    NOT NULL DEFAULT 'ILS',
      category    TEXT,
      source      TEXT,
      bank_name   TEXT,
      is_debit    BOOLEAN NOT NULL DEFAULT TRUE
    );

    CREATE TABLE IF NOT EXISTS stock_transactions (
      id          TEXT    PRIMARY KEY,
      date        TEXT    NOT NULL,
      symbol      TEXT    NOT NULL,
      name        TEXT,
      action      TEXT    NOT NULL,
      quantity    REAL,
      price       REAL,
      amount      REAL    NOT NULL,
      currency    TEXT    NOT NULL DEFAULT 'USD',
      content_key TEXT    NOT NULL UNIQUE
    );

    CREATE TABLE IF NOT EXISTS portfolio (
      id   SMALLINT PRIMARY KEY DEFAULT 1,
      data TEXT     NOT NULL,
      CONSTRAINT single_row CHECK (id = 1)
    );

    CREATE TABLE IF NOT EXISTS category_cache (
      description_key TEXT        PRIMARY KEY,
      category        TEXT        NOT NULL,
      confidence      TEXT        NOT NULL DEFAULT 'high',
      hit_count       INTEGER     NOT NULL DEFAULT 1,
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  console.log('[DB] Tables ready');
}

export default pool;
