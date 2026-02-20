import { useEffect, useState } from 'preact/hooks'
import type { QueryResult } from '../rpc/types'
import { HistoryPanel } from './history-panels'
import type { useHistory } from './hooks'

export function SqlConsoleTab({ execQuery, generateSql, initialSql, history }: {
	execQuery: (sql: string) => Promise<QueryResult>
	generateSql?: (prompt: string) => Promise<string>
	initialSql?: string
	history: ReturnType<typeof useHistory>
}) {
	const [sql, setSql] = useState(initialSql ?? '')
	const [result, setResult] = useState<QueryResult | null>(null)
	const [error, setError] = useState<string | null>(null)
	const [loading, setLoading] = useState(false)
	const [showHistory, setShowHistory] = useState(false)
	const [aiPrompt, setAiPrompt] = useState('')
	const [aiLoading, setAiLoading] = useState(false)
	const [aiError, setAiError] = useState<string | null>(null)

	// Update SQL when initialSql changes (e.g. from "open in console")
	useEffect(() => {
		if (initialSql) setSql(initialSql)
	}, [initialSql])

	const run = async () => {
		if (!sql.trim() || loading) return
		history.add(sql)
		setLoading(true)
		setError(null)
		setResult(null)
		try {
			const res = await execQuery(sql)
			if (res.error) setError(res.error)
			else setResult(res)
		} catch (e: any) {
			setError(e.message ?? String(e))
		} finally {
			setLoading(false)
		}
	}

	const generate = async () => {
		if (!generateSql || !aiPrompt.trim() || aiLoading) return
		setAiLoading(true)
		setAiError(null)
		try {
			const result = await generateSql(aiPrompt)
			setSql(result)
		} catch (e: any) {
			setAiError(e.message ?? String(e))
		} finally {
			setAiLoading(false)
		}
	}

	return (
		<>
			<div class="bg-panel rounded-lg border border-border p-5 mb-6">
				{generateSql && (
					<div class="mb-4">
						<div class="flex gap-2">
							<input
								type="text"
								value={aiPrompt}
								onInput={e => setAiPrompt((e.target as HTMLInputElement).value)}
								onKeyDown={e => {
									if (e.key === 'Enter') generate()
								}}
								placeholder="Describe query in natural language..."
								class="flex-1 bg-panel-secondary border border-border rounded-lg px-4 py-2 text-sm outline-none focus:border-border focus:ring-1 focus:ring-border transition-all"
							/>
							<button
								onClick={generate}
								disabled={aiLoading || !aiPrompt.trim()}
								class="rounded-md px-4 py-2 text-sm font-medium bg-panel border border-border text-text-secondary hover:bg-panel-hover disabled:opacity-40 disabled:cursor-not-allowed transition-all"
							>
								{aiLoading ? 'Generating...' : 'Generate SQL'}
							</button>
						</div>
						{aiError && <div class="text-red-500 text-xs mt-1">{aiError}</div>}
					</div>
				)}
				<textarea
					value={sql}
					onInput={e => setSql((e.target as HTMLTextAreaElement).value)}
					onKeyDown={e => {
						if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) run()
					}}
					placeholder="SELECT * FROM ..."
					class="w-full bg-panel-secondary border border-border rounded-lg px-4 py-3 font-mono text-sm outline-none min-h-[100px] resize-y focus:border-border focus:ring-1 focus:ring-border transition-all mb-4"
				/>
				<div class="flex items-center gap-3">
					<button
						onClick={run}
						disabled={loading || !sql.trim()}
						class="rounded-md px-4 py-2 text-sm font-medium bg-ink text-surface hover:opacity-80 disabled:opacity-40 disabled:cursor-not-allowed transition-all"
					>
						{loading ? 'Running...' : 'Run Query'}
					</button>
					<button
						onClick={() => setShowHistory(v => !v)}
						class={`rounded-md px-3 py-2 text-sm font-medium transition-all ${
							showHistory
								? 'bg-ink text-surface'
								: 'bg-panel border border-border text-text-secondary hover:bg-panel-hover'
						}`}
					>
						History{history.entries.length > 0 ? ` (${history.entries.length})` : ''}
					</button>
					<span class="text-xs text-text-muted">Ctrl+Enter to run</span>
				</div>
			</div>

			{showHistory && (
				<HistoryPanel
					entries={history.entries}
					onSelect={(entry) => {
						setSql(entry.sql)
						setShowHistory(false)
					}}
					onClear={history.clear}
				/>
			)}

			{error ? <div class="bg-red-500/10 text-red-400 p-4 rounded-lg text-sm font-medium">{error}</div> : result
				? (
					<div>
						{result.message
							? <div class="bg-emerald-500/10 text-emerald-500 p-4 rounded-lg text-sm font-medium">{result.message}</div>
							: result.columns.length > 0
							? (
								<div>
									<div class="text-sm text-text-muted mb-3 font-medium">{result.count} row(s)</div>
									<ResultTable columns={result.columns} rows={result.rows} />
								</div>
							)
							: null}
					</div>
				)
				: null}
		</>
	)
}

// ─── ResultTable (read-only results) ─────────────────────────────────

function ResultTable({ columns, rows }: { columns: string[]; rows: Record<string, unknown>[] }) {
	return (
		<div class="bg-panel rounded-lg border border-border overflow-x-auto">
			<table class="w-full text-sm">
				<thead>
					<tr class="border-b border-border-subtle">
						{columns.map(col => (
							<th key={col} class="text-left px-4 py-2.5 font-medium text-xs text-text-muted uppercase tracking-wider font-mono">{col}</th>
						))}
					</tr>
				</thead>
				<tbody>
					{rows.map((row, i) => (
						<tr key={i} class="group border-b border-border-row last:border-0 hover:bg-panel-hover/50 transition-colors">
							{columns.map(col => (
								<td key={col} class="px-4 py-2.5 font-mono text-xs">
									{row[col] === null ? <span class="text-text-dim italic">NULL</span> : String(row[col])}
								</td>
							))}
						</tr>
					))}
				</tbody>
			</table>
		</div>
	)
}
