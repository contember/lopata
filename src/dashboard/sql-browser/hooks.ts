import { useCallback, useState } from 'preact/hooks'
import type { BrowserHistoryEntry, HistoryEntry, SortDir } from './types'

// ─── Query history (localStorage, scoped per database) ───────────────

const HISTORY_PREFIX = 'lopata-sql-history'
const HISTORY_MAX = 100

function historyKey(scope?: string): string {
	return scope ? `${HISTORY_PREFIX}:${scope}` : HISTORY_PREFIX
}

function loadHistory(scope?: string): HistoryEntry[] {
	try {
		const raw = localStorage.getItem(historyKey(scope))
		return raw ? JSON.parse(raw) : []
	} catch {
		return []
	}
}

function saveToHistory(sql: string, scope?: string): HistoryEntry[] {
	const trimmed = sql.trim()
	if (!trimmed) return loadHistory(scope)
	const entries = loadHistory(scope)
	// Deduplicate: remove existing entry with same SQL
	const filtered = entries.filter(e => e.sql !== trimmed)
	const next = [{ sql: trimmed, ts: Date.now() }, ...filtered].slice(0, HISTORY_MAX)
	localStorage.setItem(historyKey(scope), JSON.stringify(next))
	return next
}

function clearHistory(scope?: string): HistoryEntry[] {
	localStorage.removeItem(historyKey(scope))
	return []
}

export function useHistory(scope?: string) {
	const [entries, setEntries] = useState<HistoryEntry[]>(() => loadHistory(scope))
	const add = useCallback((sql: string) => {
		setEntries(saveToHistory(sql, scope))
	}, [scope])
	const clear = useCallback(() => {
		setEntries(clearHistory(scope))
	}, [scope])
	return { entries, add, clear }
}

// ─── Browser history (structured, localStorage, scoped per database) ─

const BROWSER_HISTORY_PREFIX = 'lopata-browser-history'
const BROWSER_HISTORY_MAX = 50

function browserHistoryKey(scope?: string): string {
	return scope ? `${BROWSER_HISTORY_PREFIX}:${scope}` : BROWSER_HISTORY_PREFIX
}

function loadBrowserHistory(scope?: string): BrowserHistoryEntry[] {
	try {
		const raw = localStorage.getItem(browserHistoryKey(scope))
		return raw ? JSON.parse(raw) : []
	} catch {
		return []
	}
}

function saveToBrowserHistory(entry: Omit<BrowserHistoryEntry, 'ts'>, scope?: string): BrowserHistoryEntry[] {
	const entries = loadBrowserHistory(scope)
	// Deduplicate by same table + filters + sort
	const key = JSON.stringify({ t: entry.table, f: entry.filters, s: entry.sortCol, d: entry.sortDir })
	const filtered = entries.filter(e => JSON.stringify({ t: e.table, f: e.filters, s: e.sortCol, d: e.sortDir }) !== key)
	const next = [{ ...entry, ts: Date.now() }, ...filtered].slice(0, BROWSER_HISTORY_MAX)
	localStorage.setItem(browserHistoryKey(scope), JSON.stringify(next))
	return next
}

function clearBrowserHistory(scope?: string): BrowserHistoryEntry[] {
	localStorage.removeItem(browserHistoryKey(scope))
	return []
}

export function useBrowserHistory(scope?: string) {
	const [entries, setEntries] = useState<BrowserHistoryEntry[]>(() => loadBrowserHistory(scope))
	const add = useCallback((entry: Omit<BrowserHistoryEntry, 'ts'>) => {
		setEntries(saveToBrowserHistory(entry, scope))
	}, [scope])
	const clear = useCallback(() => {
		setEntries(clearBrowserHistory(scope))
	}, [scope])
	return { entries, add, clear }
}

// ─── Per-table view state (filters + sort, localStorage) ────────────

const TABLE_STATE_PREFIX = 'lopata-table-state'

interface TableViewState {
	filters: Record<string, string>
	sortCol: string | null
	sortDir: SortDir
}

function tableStateKey(scope?: string): string {
	return scope ? `${TABLE_STATE_PREFIX}:${scope}` : TABLE_STATE_PREFIX
}

export function loadTableState(table: string, scope?: string): TableViewState | null {
	try {
		const raw = localStorage.getItem(tableStateKey(scope))
		if (!raw) return null
		const all = JSON.parse(raw)
		return all[table] ?? null
	} catch {
		return null
	}
}

export function saveTableState(table: string, state: TableViewState, scope?: string): void {
	try {
		const raw = localStorage.getItem(tableStateKey(scope))
		const all = raw ? JSON.parse(raw) : {}
		all[table] = state
		localStorage.setItem(tableStateKey(scope), JSON.stringify(all))
	} catch {}
}

export function clearTableState(table: string, scope?: string): void {
	try {
		const raw = localStorage.getItem(tableStateKey(scope))
		if (!raw) return
		const all = JSON.parse(raw)
		delete all[table]
		localStorage.setItem(tableStateKey(scope), JSON.stringify(all))
	} catch {}
}
