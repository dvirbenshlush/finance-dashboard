/**
 * categoryCache.ts
 * In-memory description → category cache, backed by a DB table for persistence
 * across server restarts.
 *
 * Cache key = normalised + sanitised description (lowercase, collapsed whitespace,
 * capped at 150 chars). This means identical merchants always hit the cache even
 * if amounts or PII tokens differ slightly.
 *
 * Only high/medium-confidence LLM results are stored. Low-confidence results are
 * never cached so they can be re-classified when the model has more context.
 */

import pool from '../db';
import { sanitizeText } from './sanitize';

interface CacheEntry {
  category: string;
  confidence: 'high' | 'medium' | 'low';
}

const mem = new Map<string, CacheEntry>();
let dbLoaded = false;

// ─── Key normalisation ────────────────────────────────────────────────────────

/** Produce a stable cache key from a raw description. */
export function normalizeKey(description: string): string {
  return sanitizeText(description)   // strip PII first for consistent keys
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 150);
}

// ─── DB load (lazy, once per process) ────────────────────────────────────────

/** Populate the in-memory map from DB. Called before the first categorise request. */
export async function ensureLoaded(): Promise<void> {
  if (dbLoaded) return;
  dbLoaded = true;                   // set early to prevent concurrent loads
  try {
    const { rows } = await pool.query<{
      description_key: string; category: string; confidence: string;
    }>('SELECT description_key, category, confidence FROM category_cache');

    for (const r of rows) {
      mem.set(r.description_key, {
        category: r.category,
        confidence: r.confidence as CacheEntry['confidence'],
      });
    }
    console.log(`[cache] Loaded ${rows.length} cached categories from DB`);
  } catch (e) {
    console.warn('[cache] Could not load from DB (continuing without cache):', String(e));
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/** Look up a description. Returns undefined on cache miss. */
export function get(description: string): CacheEntry | undefined {
  return mem.get(normalizeKey(description));
}

/**
 * Store a batch of classification results.
 * In-memory write is synchronous; DB write is fire-and-forget.
 * Only high/medium confidence results are persisted.
 */
export function setBatch(
  entries: Array<{ description: string; category: string; confidence: string }>,
): void {
  const toStore = entries.filter(
    e => e.confidence === 'high' || e.confidence === 'medium',
  );

  for (const e of toStore) {
    mem.set(normalizeKey(e.description), {
      category: e.category,
      confidence: e.confidence as CacheEntry['confidence'],
    });
  }

  // Async DB persist — never blocks the HTTP response
  void (async () => {
    for (const e of toStore) {
      try {
        await pool.query(
          `INSERT INTO category_cache (description_key, category, confidence, hit_count, updated_at)
           VALUES ($1, $2, $3, 1, NOW())
           ON CONFLICT (description_key) DO UPDATE
             SET hit_count  = category_cache.hit_count + 1,
                 updated_at = NOW()`,
          [normalizeKey(e.description), e.category, e.confidence],
        );
      } catch { /* silent — cache is best-effort */ }
    }
  })();
}

export const stats = () => ({ size: mem.size, loaded: dbLoaded });
