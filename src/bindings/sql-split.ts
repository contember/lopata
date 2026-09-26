/** Opening quote → closing quote. SQLite accepts all four for literals/identifiers. */
const QUOTES: Record<string, string> = { "'": "'", '"': '"', '`': '`', '[': ']' }

const WORD = /[A-Za-z_][A-Za-z0-9_$]*/g

/**
 * A `CREATE TRIGGER … BEGIN …; …; END` body contains semicolons that don't end the
 * statement. The trigger is complete once its unquoted text ends with the END that
 * closes BEGIN, i.e. there is one more END than there are CASE expressions (each
 * `CASE … END` inside the body contributes its own END).
 *
 * `bare` is the statement with quoted spans and comments blanked out, so keywords
 * inside literals and identifiers don't count.
 */
function isOpenTrigger(bare: string): boolean {
	const words = (bare.match(WORD) ?? []).map((w) => w.toUpperCase())
	let start = 0
	if (words[start] !== 'CREATE') return false
	start++
	if (words[start] === 'TEMP' || words[start] === 'TEMPORARY') start++
	if (words[start] !== 'TRIGGER') return false

	let cases = 0
	let ends = 0
	for (const w of words) {
		if (w === 'CASE') cases++
		else if (w === 'END') ends++
	}
	return words.at(-1) !== 'END' || ends <= cases
}

/**
 * Split SQL text into individual statements, respecting string literals and quoted
 * identifiers (`'…'`, `"…"`, `` `…` ``, `[…]`), line comments (--), block comments,
 * and semicolons inside a trigger body.
 */
export function splitStatements(sql: string): string[] {
	const statements: string[] = []
	let current = ''
	let bare = ''
	let i = 0
	const len = sql.length

	const flush = () => {
		const trimmed = current.trim()
		if (trimmed.length > 0) statements.push(trimmed)
		current = ''
		bare = ''
	}

	while (i < len) {
		const ch = sql[i]!

		const close = QUOTES[ch]
		if (close !== undefined) {
			current += ch
			i++
			while (i < len) {
				const c = sql[i]!
				current += c
				i++
				if (c !== close) continue
				// '' "" `` escape the quote; brackets have no escape
				if (close !== ']' && sql[i] === close) {
					current += close
					i++
					continue
				}
				break
			}
			bare += ' '
			continue
		}

		// Line comment --
		if (ch === '-' && sql[i + 1] === '-') {
			i += 2
			while (i < len && sql[i] !== '\n') i++
			if (i < len) i++ // skip \n
			current += ' '
			bare += ' '
			continue
		}

		// Block comment /* ... */
		if (ch === '/' && sql[i + 1] === '*') {
			i += 2
			while (i + 1 < len && !(sql[i] === '*' && sql[i + 1] === '/')) i++
			if (i + 1 < len) i += 2 // skip */
			current += ' '
			bare += ' '
			continue
		}

		if (ch === ';' && !isOpenTrigger(bare)) {
			flush()
			i++
			continue
		}

		current += ch
		bare += ch
		i++
	}

	flush()
	return statements
}

/**
 * True when `sql` may hold more than one statement: it has a `;` anywhere but at
 * its very end. A cheap pre-check so the common single-statement query skips the
 * splitter entirely (a `;` inside a literal only costs a split that yields one).
 */
export function mayHaveMultipleStatements(sql: string): boolean {
	const idx = sql.indexOf(';')
	return idx !== -1 && sql.slice(idx + 1).replace(/;/g, '').trim().length > 0
}
