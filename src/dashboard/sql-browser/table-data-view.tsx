import { useCallback, useEffect, useRef, useState } from 'preact/hooks'
import { replaceRoute } from '../lib'
import type { D1Table, QueryResult } from '../rpc/types'
import { EditableCell } from './editable-cell'
import { FilterRow } from './filter-row'
import { FilterHelpModal } from './filter-row'
import { BrowserHistoryPanel } from './history-panels'
import type { useBrowserHistory, useHistory } from './hooks'
import { clearTableState, loadTableState, saveTableState } from './hooks'
import { InsertRowForm } from './insert-row-form'
import { CellInspectorModal, RowDetailModal } from './modals'
import type { BrowserHistoryEntry, ForeignKeyInfo, SortDir } from './types'
import { PAGE_SIZE } from './types'
import { buildWhereClause, exportCSV, exportJSON, parseCreateTable, quoteId, sqlLiteral } from './utils'

export function TableDataView(
	{ table, execQuery, onOpenInConsole, history, browserHistory, onRestoreHistory, onNavigateFK, historyScope, basePath, routeQuery }: {
		table: D1Table
		execQuery: (sql: string) => Promise<QueryResult>
		onOpenInConsole: (sql: string) => void
		history: ReturnType<typeof useHistory>
		browserHistory: ReturnType<typeof useBrowserHistory>
		onRestoreHistory: (entry: BrowserHistoryEntry) => void
		onNavigateFK: (targetTable: string, targetColumn: string, value: unknown) => void
		historyScope?: string
		basePath?: string
		routeQuery?: URLSearchParams
	},
) {
	const schema = parseCreateTable(table.sql)
	const pkCols = schema.primaryKeys.length > 0 ? schema.primaryKeys : ['rowid']
	const needsRowid = schema.primaryKeys.length === 0

	// FK map for quick lookup
	const fkMap = new Map<string, ForeignKeyInfo>()
	for (const col of schema.columns) {
		if (col.foreignKey) fkMap.set(col.name, col.foreignKey)
	}

	// Numeric columns for right-alignment
	const numericTypes = /\b(INT|INTEGER|REAL|FLOAT|DOUBLE|DECIMAL|NUMERIC|BIGINT|SMALLINT|TINYINT|MEDIUMINT)\b/i
	const numericCols = new Set(schema.columns.filter(c => numericTypes.test(c.type)).map(c => c.name))

	// Initialize state from URL query params, falling back to saved table state
	const initState = () => {
		const f: Record<string, string> = {}
		let s: string | null = null
		let d: SortDir = 'ASC'
		let hasUrlParams = false

		if (routeQuery) {
			for (const [key, val] of routeQuery.entries()) {
				if (key.startsWith('f.')) {
					f[key.slice(2)] = val
					hasUrlParams = true
				}
			}
			const urlSort = routeQuery.get('s')
			if (urlSort) {
				s = urlSort
				hasUrlParams = true
			}
			const urlDir = routeQuery.get('d')
			if (urlDir === 'DESC') d = 'DESC'
		}

		if (!hasUrlParams) {
			const saved = loadTableState(table.name, historyScope)
			if (saved) {
				return { filters: saved.filters, sortCol: saved.sortCol, sortDir: saved.sortDir }
			}
		}
		return { filters: f, sortCol: s, sortDir: d }
	}

	const initial = initState()
	const [rows, setRows] = useState<Record<string, unknown>[]>([])
	const [columns, setColumns] = useState<string[]>([])
	const [totalCount, setTotalCount] = useState<number>(table.rows)
	const [offset, setOffset] = useState(() => {
		const o = routeQuery?.get('o')
		return o ? parseInt(o, 10) || 0 : 0
	})
	const [sortCol, setSortCol] = useState<string | null>(initial.sortCol)
	const [sortDir, setSortDir] = useState<SortDir>(initial.sortDir)
	const [loading, setLoading] = useState(false)
	const [error, setError] = useState<string | null>(null)
	const [showInsert, setShowInsert] = useState(false)
	const [filters, setFilters] = useState<Record<string, string>>(initial.filters)
	const [showFilters, setShowFilters] = useState(() => Object.keys(initial.filters).length > 0)
	const [showFilterHelp, setShowFilterHelp] = useState(false)
	const [showBrowserHistory, setShowBrowserHistory] = useState(false)

	// Bulk select
	const [selectedRows, setSelectedRows] = useState<Set<string>>(new Set())
	const rowKey = (row: Record<string, unknown>) => pkCols.map(pk => String(row[pk] ?? '')).join('\0')

	// Row detail & cell inspector modals
	const [detailRow, setDetailRow] = useState<Record<string, unknown> | null>(null)
	const [inspectCell, setInspectCell] = useState<{ column: string; value: unknown } | null>(null)

	// Export dropdown
	const [showExport, setShowExport] = useState(false)

	// Sync state → URL + persist table view state
	useEffect(() => {
		// Save to localStorage
		const hasState = Object.values(filters).some(v => v.trim()) || sortCol !== null
		if (hasState) {
			saveTableState(table.name, { filters, sortCol, sortDir }, historyScope)
		}

		if (!basePath) return
		const params = new URLSearchParams()
		for (const [col, val] of Object.entries(filters)) {
			if (val.trim()) params.set('f.' + col, val)
		}
		if (sortCol) {
			params.set('s', sortCol)
			params.set('d', sortDir)
		}
		if (offset > 0) params.set('o', String(offset))
		const qs = params.toString()
		replaceRoute(basePath + '/data/' + encodeURIComponent(table.name) + (qs ? '?' + qs : ''))
	}, [filters, sortCol, sortDir, offset, basePath, table.name, historyScope])

	const filtersKey = JSON.stringify(filters)
	const loadGenRef = useRef(0)

	const loadData = useCallback(async (newOffset: number) => {
		const gen = ++loadGenRef.current
		setLoading(true)
		setError(null)
		try {
			const selectCols = needsRowid ? `rowid, *` : `*`
			const where = buildWhereClause(filters)
			const orderBy = sortCol ? ` ORDER BY ${quoteId(sortCol)} ${sortDir}` : ''
			const dataSql = `SELECT ${selectCols} FROM ${quoteId(table.name)}${where}${orderBy} LIMIT ${PAGE_SIZE} OFFSET ${newOffset}`
			const countSql = `SELECT COUNT(*) as cnt FROM ${quoteId(table.name)}${where}`

			const [dataRes, countRes] = await Promise.all([
				execQuery(dataSql),
				execQuery(countSql),
			])

			if (gen !== loadGenRef.current) return

			if (dataRes.error) {
				setError(dataRes.error)
				return
			}

			setRows(dataRes.rows)
			setColumns(dataRes.columns)
			setOffset(newOffset)
			if (countRes.rows?.[0]) {
				setTotalCount(Number(countRes.rows[0].cnt))
			}
			// Save to browser history when there are filters or sort
			if (where || orderBy) {
				browserHistory.add({ table: table.name, filters, sortCol, sortDir })
			}
		} catch (e: any) {
			if (gen !== loadGenRef.current) return
			setError(e.message ?? String(e))
		} finally {
			if (gen === loadGenRef.current) setLoading(false)
		}
	}, [table.name, sortCol, sortDir, needsRowid, execQuery, browserHistory.add, filters])

	// Reload when table, sort, or filters change
	useEffect(() => {
		setOffset(0)
		setShowInsert(false)
		setSelectedRows(new Set())
		loadData(0)
	}, [loadData])

	const handleSort = (col: string) => {
		if (sortCol === col) {
			setSortDir(d => d === 'ASC' ? 'DESC' : 'ASC')
		} else {
			setSortCol(col)
			setSortDir('ASC')
		}
	}

	const handleUpdate = async (row: Record<string, unknown>, col: string, value: unknown) => {
		const where = pkCols.map(pk => `${quoteId(pk)} = ${sqlLiteral(row[pk])}`).join(' AND ')
		const sql = `UPDATE ${quoteId(table.name)} SET ${quoteId(col)} = ${sqlLiteral(value)} WHERE ${where}`
		try {
			const res = await execQuery(sql)
			if (res.error) {
				setError(res.error)
				return
			}
			await loadData(offset)
		} catch (e: any) {
			setError(e.message ?? String(e))
		}
	}

	const handleDelete = async (row: Record<string, unknown>) => {
		if (!confirm('Delete this row?')) return
		const where = pkCols.map(pk => `${quoteId(pk)} = ${sqlLiteral(row[pk])}`).join(' AND ')
		const sql = `DELETE FROM ${quoteId(table.name)} WHERE ${where}`
		try {
			const res = await execQuery(sql)
			if (res.error) {
				setError(res.error)
				return
			}
			await loadData(offset)
		} catch (e: any) {
			setError(e.message ?? String(e))
		}
	}

	const handleInsert = async (values: Record<string, unknown>) => {
		const cols = Object.keys(values)
		const vals = cols.map(c => sqlLiteral(values[c]))
		const sql = `INSERT INTO ${quoteId(table.name)} (${cols.map(quoteId).join(', ')}) VALUES (${vals.join(', ')})`
		try {
			const res = await execQuery(sql)
			if (res.error) {
				setError(res.error)
				return
			}
			setShowInsert(false)
			await loadData(offset)
		} catch (e: any) {
			setError(e.message ?? String(e))
		}
	}

	// Bulk select handlers
	const toggleRow = (row: Record<string, unknown>) => {
		const key = rowKey(row)
		setSelectedRows(prev => {
			const next = new Set(prev)
			if (next.has(key)) next.delete(key)
			else next.add(key)
			return next
		})
	}

	const toggleAll = () => {
		if (selectedRows.size === rows.length && rows.length > 0) {
			setSelectedRows(new Set())
		} else {
			setSelectedRows(new Set(rows.map(rowKey)))
		}
	}

	const handleBulkDelete = async () => {
		if (selectedRows.size === 0) return
		if (!confirm(`Delete ${selectedRows.size} row(s)?`)) return
		const toDelete = rows.filter(r => selectedRows.has(rowKey(r)))
		const conditions = toDelete.map(row => `(${pkCols.map(pk => `${quoteId(pk)} = ${sqlLiteral(row[pk])}`).join(' AND ')})`)
		const sql = `DELETE FROM ${quoteId(table.name)} WHERE ${conditions.join(' OR ')}`
		try {
			const res = await execQuery(sql)
			if (res.error) {
				setError(res.error)
				return
			}
			setSelectedRows(new Set())
			await loadData(offset)
		} catch (e: any) {
			setError(e.message ?? String(e))
		}
	}

	// Columns to display (hide rowid if it was added just for PK tracking)
	const displayCols = columns.filter(c => !(needsRowid && c === 'rowid'))
	const activeFilterCount = Object.values(filters).filter(v => v.trim()).length
	const hasActiveState = activeFilterCount > 0 || sortCol !== null

	const handleReset = () => {
		setFilters({})
		setSortCol(null)
		setSortDir('ASC')
		setShowFilters(false)
		clearTableState(table.name, historyScope)
	}

	// Current query SQL (for display / open-in-console)
	const where = buildWhereClause(filters)
	const orderBy = sortCol ? ` ORDER BY ${quoteId(sortCol)} ${sortDir}` : ''
	const currentSql = `SELECT * FROM ${quoteId(table.name)}${where}${orderBy}`

	const totalPages = Math.ceil(totalCount / PAGE_SIZE)
	const currentPage = Math.floor(offset / PAGE_SIZE) + 1
	const rangeStart = totalCount === 0 ? 0 : offset + 1
	const rangeEnd = Math.min(offset + PAGE_SIZE, totalCount)

	return (
		<div>
			{/* Toolbar */}
			<div class="flex items-center justify-between mb-4">
				<div class="flex items-center gap-3">
					<h3 class="text-lg font-bold font-mono">{table.name}</h3>
					<span class="text-xs text-text-muted tabular-nums">{totalCount} row(s)</span>
					{selectedRows.size > 0 && (
						<button
							onClick={handleBulkDelete}
							class="rounded-md px-3 py-1.5 text-sm font-medium bg-red-500 text-white hover:bg-red-600 transition-all"
						>
							Delete selected ({selectedRows.size})
						</button>
					)}
				</div>
				<div class="flex items-center gap-2">
					<button
						onClick={() => setShowFilters(v => !v)}
						class={`rounded-md px-3 py-1.5 text-sm font-medium transition-all ${
							showFilters || activeFilterCount > 0
								? 'bg-ink text-surface'
								: 'bg-panel border border-border text-text-secondary hover:bg-panel-hover'
						}`}
					>
						Filter{activeFilterCount > 0 ? ` (${activeFilterCount})` : ''}
					</button>
					{hasActiveState && (
						<button
							onClick={handleReset}
							class="rounded-md px-3 py-1.5 text-sm font-medium text-red-400 bg-panel border border-border hover:text-red-300 hover:bg-red-500/10 transition-all"
							title="Clear all filters and sorting"
						>
							Reset
						</button>
					)}
					<button
						onClick={() => setShowFilterHelp(true)}
						class="rounded-md w-7 h-7 text-sm font-bold bg-panel border border-border text-text-muted hover:text-text-data hover:bg-panel-hover transition-all"
						title="Filter syntax help"
					>
						?
					</button>
					<button
						onClick={() => setShowBrowserHistory(v => !v)}
						class={`rounded-md px-3 py-1.5 text-sm font-medium transition-all ${
							showBrowserHistory
								? 'bg-ink text-surface'
								: 'bg-panel border border-border text-text-secondary hover:bg-panel-hover'
						}`}
					>
						History{browserHistory.entries.length > 0 ? ` (${browserHistory.entries.length})` : ''}
					</button>
					<div class="relative">
						<button
							onClick={() => setShowExport(v => !v)}
							class={`rounded-md px-3 py-1.5 text-sm font-medium transition-all ${
								showExport
									? 'bg-ink text-surface'
									: 'bg-panel border border-border text-text-secondary hover:bg-panel-hover'
							}`}
						>
							Export
						</button>
						{showExport && (
							<div class="absolute right-0 top-full mt-1 bg-panel rounded-lg border border-border shadow-lg z-10 py-1 min-w-[120px]">
								<button
									onClick={() => {
										exportCSV(displayCols, rows, table.name)
										setShowExport(false)
									}}
									class="w-full text-left px-3 py-2 text-sm text-text-data hover:bg-panel-hover transition-colors"
								>
									CSV
								</button>
								<button
									onClick={() => {
										exportJSON(rows, table.name)
										setShowExport(false)
									}}
									class="w-full text-left px-3 py-2 text-sm text-text-data hover:bg-panel-hover transition-colors"
								>
									JSON
								</button>
							</div>
						)}
					</div>
					<button
						onClick={() => setShowInsert(!showInsert)}
						class={`rounded-md px-3 py-1.5 text-sm font-medium transition-all ${
							showInsert
								? 'bg-panel-active text-text-data'
								: 'bg-ink text-surface hover:opacity-80'
						}`}
					>
						{showInsert ? 'Cancel' : '+ Add Row'}
					</button>
					<button
						onClick={() => loadData(offset)}
						disabled={loading}
						class="rounded-md px-3 py-1.5 text-sm font-medium bg-panel border border-border text-text-secondary hover:bg-panel-hover disabled:opacity-40 transition-all"
					>
						Refresh
					</button>
				</div>
			</div>

			{/* Current SQL */}
			<div
				onClick={() => onOpenInConsole(currentSql)}
				class="mb-4 px-3 py-2 bg-panel-secondary border border-border rounded-lg flex items-center gap-2 cursor-pointer hover:bg-panel-hover hover:border-border transition-colors group"
				title="Open in SQL Console"
			>
				<code class="flex-1 text-xs font-mono text-text-secondary truncate">{currentSql}</code>
				<span class="text-xs text-text-dim group-hover:text-text-secondary transition-colors flex-shrink-0">&rarr; SQL Console</span>
			</div>

			{/* Browser history */}
			{showBrowserHistory && (
				<BrowserHistoryPanel
					entries={browserHistory.entries}
					currentTable={table.name}
					onSelect={(entry) => {
						onRestoreHistory(entry)
						setShowBrowserHistory(false)
					}}
					onClear={browserHistory.clear}
				/>
			)}

			{/* Error banner */}
			{error && (
				<div class="bg-red-500/10 text-red-400 p-3 rounded-lg text-sm font-medium mb-4 flex items-center justify-between">
					<span>{error}</span>
					<button onClick={() => setError(null)} class="text-red-400 hover:text-red-600 ml-3 text-xs">dismiss</button>
				</div>
			)}

			{/* Data table */}
			<div class="bg-panel rounded-lg border border-border overflow-x-auto">
				<table class="w-full text-sm">
					<thead>
						<tr class="border-b border-border-subtle">
							<th class="w-10 px-3 py-2.5">
								<input
									type="checkbox"
									checked={rows.length > 0 && selectedRows.size === rows.length}
									onChange={toggleAll}
									class="rounded border-border accent-ink"
								/>
							</th>
							{displayCols.map(col => (
								<th
									key={col}
									onClick={() => handleSort(col)}
									class={`${
										numericCols.has(col) ? 'text-right' : 'text-left'
									} px-4 py-2.5 font-medium text-xs text-text-muted uppercase tracking-wider font-mono cursor-pointer hover:text-text-data select-none`}
								>
									{col}
									{fkMap.has(col) && <span class="ml-1 text-link text-[10px]" title={`FK → ${fkMap.get(col)!.targetTable}`}>FK</span>}
									{sortCol === col && <span class="ml-1">{sortDir === 'ASC' ? '\u2191' : '\u2193'}</span>}
								</th>
							))}
							<th class="w-24 px-4 py-2.5"></th>
						</tr>
						{showFilters && (
							<FilterRow
								columns={displayCols}
								filters={filters}
								onFilterChange={(col, val) =>
									setFilters(f => {
										const next = { ...f }
										if (val) next[col] = val
										else delete next[col]
										return next
									})}
								onClearAll={() => setFilters({})}
								hasCheckboxCol
							/>
						)}
					</thead>
					<tbody>
						{showInsert && (
							<InsertRowForm
								schema={schema}
								displayCols={displayCols}
								onSave={handleInsert}
								onCancel={() => setShowInsert(false)}
								hasCheckboxCol
							/>
						)}
						{loading && rows.length === 0
							? (
								<tr>
									<td colSpan={displayCols.length + 2} class="px-4 py-8 text-center text-text-muted text-sm">Loading...</td>
								</tr>
							)
							: rows.length === 0
							? (
								<tr>
									<td colSpan={displayCols.length + 2} class="px-4 py-8 text-center text-text-muted text-sm">No rows</td>
								</tr>
							)
							: (
								rows.map((row, i) => (
									<tr
										key={i}
										class={`group border-b border-border-subtle last:border-0 hover:bg-panel-hover/50 transition-colors ${
											selectedRows.has(rowKey(row)) ? 'bg-blue-500/10' : i % 2 === 1 ? 'bg-panel-hover/20' : ''
										}`}
									>
										<td class="px-3 py-2">
											<input
												type="checkbox"
												checked={selectedRows.has(rowKey(row))}
												onChange={() => toggleRow(row)}
												class="rounded border-border accent-ink"
											/>
										</td>
										{displayCols.map(col => (
											<td key={col} class="px-4 py-0">
												<EditableCell
													value={row[col]}
													onSave={(v) => handleUpdate(row, col, v)}
													foreignKey={fkMap.get(col) ?? null}
													onNavigateFK={(fk) => onNavigateFK(fk.targetTable, fk.targetColumn, row[col])}
													onInspect={() => setInspectCell({ column: col, value: row[col] })}
													alignRight={numericCols.has(col)}
												/>
											</td>
										))}
										<td class="px-4 py-2 text-right whitespace-nowrap">
											<button
												onClick={() => setDetailRow(row)}
												class="opacity-0 group-hover:opacity-100 text-text-muted hover:text-text-data text-xs font-medium rounded-md px-2 py-1 hover:bg-panel-hover transition-all mr-1"
											>
												Detail
											</button>
											<button
												onClick={() => handleDelete(row)}
												class="opacity-0 group-hover:opacity-100 text-red-400 hover:text-red-300 text-xs font-medium rounded-md px-2 py-1 hover:bg-red-500/10 transition-all"
											>
												Delete
											</button>
										</td>
									</tr>
								))
							)}
					</tbody>
				</table>
			</div>

			{/* Pagination */}
			<div class="flex items-center justify-between mt-4">
				<span class="text-xs text-text-muted tabular-nums">{rangeStart}–{rangeEnd} of {totalCount}</span>
				<div class="flex items-center gap-2">
					<button
						onClick={() => loadData(offset - PAGE_SIZE)}
						disabled={offset === 0 || loading}
						class="rounded-md px-3 py-1.5 text-xs font-medium bg-panel border border-border text-text-secondary hover:bg-panel-hover disabled:opacity-40 disabled:cursor-not-allowed transition-all"
					>
						Prev
					</button>
					<span class="text-xs text-text-muted tabular-nums">{currentPage} / {totalPages}</span>
					<button
						onClick={() => loadData(offset + PAGE_SIZE)}
						disabled={offset + PAGE_SIZE >= totalCount || loading}
						class="rounded-md px-3 py-1.5 text-xs font-medium bg-panel border border-border text-text-secondary hover:bg-panel-hover disabled:opacity-40 disabled:cursor-not-allowed transition-all"
					>
						Next
					</button>
				</div>
			</div>

			{showFilterHelp && <FilterHelpModal onClose={() => setShowFilterHelp(false)} />}
			{detailRow && (
				<RowDetailModal
					columns={displayCols}
					row={detailRow}
					fkMap={fkMap}
					onClose={() => setDetailRow(null)}
					onNavigateFK={(t, c, v) => {
						setDetailRow(null)
						onNavigateFK(t, c, v)
					}}
				/>
			)}
			{inspectCell && (
				<CellInspectorModal
					column={inspectCell.column}
					value={inspectCell.value}
					onClose={() => setInspectCell(null)}
				/>
			)}
		</div>
	)
}
