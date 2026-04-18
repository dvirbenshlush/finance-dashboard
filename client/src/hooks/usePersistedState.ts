import { useState, useEffect, useRef, useCallback } from 'react';
import { api } from '../services/api';

// Module-level cache — one fetch for all keys across all hook instances
let settingsCache: Record<string, unknown> | null = null;
let settingsPromise: Promise<Record<string, unknown>> | null = null;

function fetchAllSettings(): Promise<Record<string, unknown>> {
  if (settingsCache !== null) return Promise.resolve(settingsCache);
  if (settingsPromise) return settingsPromise;
  settingsPromise = api.getSettings()
    .then(data => { settingsCache = data; return data; })
    .catch(() => { settingsPromise = null; return {}; });
  return settingsPromise;
}

/**
 * Like useState but syncs the value to the DB (via /api/settings/:key).
 * - Reads from localStorage immediately (no flash), then hydrates from DB once.
 * - All keys share a single GET /api/settings fetch per page load.
 * - Falls back gracefully if the server is unavailable.
 */
export function usePersistedState<T>(
  key: string,
  defaultValue: T,
): [T, (value: T | ((prev: T) => T)) => void] {
  const [value, setValueRaw] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key);
      return raw !== null ? (JSON.parse(raw) as T) : defaultValue;
    } catch {
      return defaultValue;
    }
  });

  // Hydrate from DB on first mount
  const hydrated = useRef(false);
  useEffect(() => {
    if (hydrated.current) return;
    hydrated.current = true;
    fetchAllSettings().then(all => {
      if (key in all) {
        const dbVal = all[key] as T;
        setValueRaw(dbVal);
        localStorage.setItem(key, JSON.stringify(dbVal));
      }
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const setValue = useCallback((next: T | ((prev: T) => T)) => {
    setValueRaw(prev => {
      const resolved = typeof next === 'function' ? (next as (p: T) => T)(prev) : next;
      localStorage.setItem(key, JSON.stringify(resolved));
      api.setSetting(key, resolved).catch(() => { /* offline */ });
      // Keep module cache in sync
      if (settingsCache) settingsCache[key] = resolved;
      return resolved;
    });
  }, [key]);

  return [value, setValue];
}
