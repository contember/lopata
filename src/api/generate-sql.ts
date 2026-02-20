import type { Database } from 'bun:sqlite'
import type { LopataConfig } from '../lopata-config'

export async function generateSqlFromPrompt(db: Database, prompt: string, lopataConfig: LopataConfig | null): Promise<string> {
	const aiConfig = lopataConfig?.ai
	const apiKey = aiConfig?.apiKey ?? process.env.OPENROUTER_API_KEY
	if (!apiKey) throw new Error('OPENROUTER_API_KEY environment variable is not set (or set ai.apiKey in lopata.config.ts)')
	if (!prompt?.trim()) throw new Error('Missing prompt')

	const model = aiConfig?.model ?? 'anthropic/claude-haiku-4.5'

	let schema: string
	try {
		const tables = db.query<{ sql: string }, []>(
			"SELECT sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
		).all()
		schema = tables.map(t => t.sql).join(';\n')
	} finally {
		db.close()
	}

	const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
		method: 'POST',
		headers: {
			'Authorization': `Bearer ${apiKey}`,
			'Content-Type': 'application/json',
		},
		body: JSON.stringify({
			model,
			messages: [
				{
					role: 'system',
					content:
						`You are a SQL assistant. Given the following SQLite database schema, generate a SQL query for the user's request. Return ONLY the raw SQL query, no explanations, no markdown fences.\n\nSchema:\n${schema}`,
				},
				{ role: 'user', content: prompt },
			],
		}),
	})

	if (!res.ok) {
		const body = await res.text()
		throw new Error(`OpenRouter API error (${res.status}): ${body}`)
	}

	const data = await res.json() as { choices: { message: { content: string } }[] }
	let sql = data.choices[0]?.message?.content ?? ''
	sql = sql.replace(/^```(?:sql)?\n?/, '').replace(/\n?```$/, '').trim()

	return sql
}
