const TRIGGER_START = /^CREATE\s+(?:TEMP\s+|TEMPORARY\s+)?TRIGGER\b/i
const TRIGGER_END = /\bEND$/i

/**
 * A `CREATE TRIGGER … BEGIN …; …; END` body contains semicolons that don't end the
 * statement. Like sqlite3_complete(), treat the trigger as open until its text ends
 * with the END keyword.
 */
function isOpenTrigger(statement: string): boolean {
	return TRIGGER_START.test(statement) && !TRIGGER_END.test(statement)
}

/**
 * Split SQL text into individual statements, respecting string literals
 * (single-quoted, double-quoted), line comments (--), block comments, and
 * semicolons inside a trigger body.
 */
export function splitStatements(sql: string): string[] {
	const statements: string[] = []
	let current = ''
	let i = 0
	const len = sql.length

	while (i < len) {
		const ch = sql[i]!

		// Single-quoted string literal
		if (ch === "'") {
			current += ch
			i++
			while (i < len) {
				const c = sql[i]!
				current += c
				i++
				if (c === "'" && i < len && sql[i] === "'") {
					// escaped quote ''
					current += sql[i]!
					i++
				} else if (c === "'") {
					break
				}
			}
			continue
		}

		// Double-quoted identifier
		if (ch === '"') {
			current += ch
			i++
			while (i < len) {
				const c = sql[i]!
				current += c
				i++
				if (c === '"' && i < len && sql[i] === '"') {
					current += sql[i]!
					i++
				} else if (c === '"') {
					break
				}
			}
			continue
		}

		// Line comment --
		if (ch === '-' && i + 1 < len && sql[i + 1] === '-') {
			i += 2
			while (i < len && sql[i] !== '\n') {
				i++
			}
			if (i < len) i++ // skip \n
			current += ' '
			continue
		}

		// Block comment /* ... */
		if (ch === '/' && i + 1 < len && sql[i + 1] === '*') {
			i += 2
			while (i + 1 < len && !(sql[i] === '*' && sql[i + 1] === '/')) {
				i++
			}
			if (i + 1 < len) i += 2 // skip */
			current += ' '
			continue
		}

		// Statement separator
		if (ch === ';') {
			const trimmed = current.trim()
			if (isOpenTrigger(trimmed)) {
				current += ch
				i++
				continue
			}
			if (trimmed.length > 0) {
				statements.push(trimmed)
			}
			current = ''
			i++
			continue
		}

		current += ch
		i++
	}

	const trimmed = current.trim()
	if (trimmed.length > 0) {
		statements.push(trimmed)
	}

	return statements
}
