import { useState, useCallback } from "preact/hooks";
import type { HistoryEntry, BrowserHistoryEntry, SortDir } from "./types";

// ─── Query history (localStorage) ────────────────────────────────────

const HISTORY_KEY = "bunflare-sql-history";
const HISTORY_MAX = 100;

function loadHistory(): HistoryEntry[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveToHistory(sql: string): HistoryEntry[] {
  const trimmed = sql.trim();
  if (!trimmed) return loadHistory();
  const entries = loadHistory();
  // Deduplicate: remove existing entry with same SQL
  const filtered = entries.filter(e => e.sql !== trimmed);
  const next = [{ sql: trimmed, ts: Date.now() }, ...filtered].slice(0, HISTORY_MAX);
  localStorage.setItem(HISTORY_KEY, JSON.stringify(next));
  return next;
}

function clearHistory(): HistoryEntry[] {
  localStorage.removeItem(HISTORY_KEY);
  return [];
}

export function useHistory() {
  const [entries, setEntries] = useState<HistoryEntry[]>(() => loadHistory());
  const add = useCallback((sql: string) => {
    setEntries(saveToHistory(sql));
  }, []);
  const clear = useCallback(() => {
    setEntries(clearHistory());
  }, []);
  return { entries, add, clear };
}

// ─── Browser history (structured, localStorage) ─────────────────────

const BROWSER_HISTORY_KEY = "bunflare-browser-history";
const BROWSER_HISTORY_MAX = 50;

function loadBrowserHistory(): BrowserHistoryEntry[] {
  try {
    const raw = localStorage.getItem(BROWSER_HISTORY_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveToBrowserHistory(entry: Omit<BrowserHistoryEntry, "ts">): BrowserHistoryEntry[] {
  const entries = loadBrowserHistory();
  // Deduplicate by same table + filters + sort
  const key = JSON.stringify({ t: entry.table, f: entry.filters, s: entry.sortCol, d: entry.sortDir });
  const filtered = entries.filter(e =>
    JSON.stringify({ t: e.table, f: e.filters, s: e.sortCol, d: e.sortDir }) !== key
  );
  const next = [{ ...entry, ts: Date.now() }, ...filtered].slice(0, BROWSER_HISTORY_MAX);
  localStorage.setItem(BROWSER_HISTORY_KEY, JSON.stringify(next));
  return next;
}

function clearBrowserHistory(): BrowserHistoryEntry[] {
  localStorage.removeItem(BROWSER_HISTORY_KEY);
  return [];
}

export function useBrowserHistory() {
  const [entries, setEntries] = useState<BrowserHistoryEntry[]>(() => loadBrowserHistory());
  const add = useCallback((entry: Omit<BrowserHistoryEntry, "ts">) => {
    setEntries(saveToBrowserHistory(entry));
  }, []);
  const clear = useCallback(() => {
    setEntries(clearBrowserHistory());
  }, []);
  return { entries, add, clear };
}
