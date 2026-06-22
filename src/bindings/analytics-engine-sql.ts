/**
 * Local emulation of the Cloudflare Workers Analytics Engine **SQL API**.
 *
 * Cloudflare has no Worker binding for *reading* Analytics Engine data — you
 * POST a ClickHouse-flavoured SQL string to
 *   https://api.cloudflare.com/client/v4/accounts/<acc>/analytics_engine/sql
 * with `Authorization: Bearer <token>`. Lopata intercepts that fetch (see
 * `plugin.ts`) and serves it from the local `analytics_engine` SQLite table so
 * the *same* worker code runs locally and in production unchanged.
 *
 * Interception is gated on the token: a missing `Authorization` header or the
 * sentinel `Bearer local` is served locally; any real bearer token falls
 * through to the actual Cloudflare API. Drive the token from env (e.g. `local`
 * in `.dev.vars`, the real secret in prod) to keep one code path. Note that
 * `writeDataPoint` always writes locally — only the query fetch is gated.
 *
 * SPIKE SCOPE — this is a pragmatic subset, not a full ClickHouse engine:
 *   SELECT <items> FROM <dataset>
 *   [WHERE <cond>] [GROUP BY <exprs>] [ORDER BY <exprs>] [LIMIT n] [FORMAT f]
 * with the functions/operators people actually use for dashboards (counts,
 * sums, time filters, time bucketing). Unsupported constructs throw a clear
 * error instead of silently returning wrong numbers.
 *
 * Key local simplifications (correct *because* there's no sampling locally):
 *   - `_sample_interval` is always 1, so `sum(_sample_interval)` == `count()`.
 *   - The `timestamp` column is stored as **ms epoch**; ClickHouse treats it as
 *     a `DateTime` (seconds). We canonicalise to **seconds** on read so
 *     `now()` / `INTERVAL` arithmetic lines up, then render `DateTime` *output*
 *     columns as ClickHouse `YYYY-MM-DD HH:MM:SS` (UTC) strings to match the real
 *     SQL API — so `new Date(row.bucket)` behaves the same locally as in prod.
 */

import type { Database } from 'bun:sqlite'

// ---------------------------------------------------------------------------
// URL matching
// ---------------------------------------------------------------------------

const SQL_PATH_RE = /\/accounts\/[^/]+\/analytics_engine\/sql\/?$/

/** True for the Cloudflare Analytics Engine SQL API endpoint. */
export function isAnalyticsEngineSqlUrl(url: string): boolean {
	try {
		const u = new URL(url)
		return u.hostname === 'api.cloudflare.com' && SQL_PATH_RE.test(u.pathname)
	} catch {
		return false
	}
}

/**
 * Whether an AE SQL API request should be served from the local store rather
 * than forwarded to Cloudflare. A missing `Authorization` header or the
 * `Bearer local` sentinel means local; any real bearer token passes through.
 */
export function isLocalAnalyticsEngineToken(auth: string | null | undefined): boolean {
	return !auth || auth.trim().toLowerCase() === 'bearer local'
}

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

interface Token {
	type: 'num' | 'str' | 'ident' | 'op' | 'punct'
	value: string
	/** Uppercased value for idents/ops — used for keyword matching. */
	upper: string
	start: number
	end: number
}

const MULTI_OPS = ['<=', '>=', '!=', '<>']
const SINGLE_OPS = new Set(['+', '-', '*', '/', '%', '=', '<', '>'])
const PUNCT = new Set(['(', ')', ',', '.', ';'])

class SqlError extends Error {}

function tokenize(sql: string): Token[] {
	const toks: Token[] = []
	let i = 0
	const n = sql.length
	while (i < n) {
		const c = sql[i]!
		if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
			i++
			continue
		}
		// line comments
		if (c === '-' && sql[i + 1] === '-') {
			while (i < n && sql[i] !== '\n') i++
			continue
		}
		// block comments
		if (c === '/' && sql[i + 1] === '*') {
			i += 2
			while (i < n && !(sql[i] === '*' && sql[i + 1] === '/')) i++
			i += 2
			continue
		}
		// string literal (single quotes, '' escape)
		if (c === "'") {
			const start = i
			i++
			let value = ''
			while (i < n) {
				if (sql[i] === "'") {
					if (sql[i + 1] === "'") {
						value += "'"
						i += 2
						continue
					}
					i++
					break
				}
				value += sql[i]
				i++
			}
			toks.push({ type: 'str', value, upper: value, start, end: i })
			continue
		}
		// backtick / double-quoted identifier
		if (c === '`' || c === '"') {
			const quote = c
			const start = i
			i++
			let value = ''
			while (i < n && sql[i] !== quote) {
				value += sql[i]
				i++
			}
			i++ // closing quote
			toks.push({ type: 'ident', value, upper: value.toUpperCase(), start, end: i })
			continue
		}
		// number — at most one decimal point (a second `.` ends the token, so
		// `1.2.3` tokenizes as `1.2` `.` `3` and fails loudly at parse time rather
		// than silently becoming `NaN`).
		if (c >= '0' && c <= '9') {
			const start = i
			let seenDot = false
			while (i < n) {
				const ch = sql[i]!
				if (ch >= '0' && ch <= '9') {
					i++
					continue
				}
				if (ch === '.' && !seenDot) {
					seenDot = true
					i++
					continue
				}
				break
			}
			const value = sql.slice(start, i)
			toks.push({ type: 'num', value, upper: value, start, end: i })
			continue
		}
		// identifier / keyword
		if (/[A-Za-z_]/.test(c)) {
			const start = i
			while (i < n && /[A-Za-z0-9_]/.test(sql[i]!)) i++
			const value = sql.slice(start, i)
			toks.push({ type: 'ident', value, upper: value.toUpperCase(), start, end: i })
			continue
		}
		// multi-char operators
		const two = sql.slice(i, i + 2)
		if (MULTI_OPS.includes(two)) {
			toks.push({ type: 'op', value: two, upper: two, start: i, end: i + 2 })
			i += 2
			continue
		}
		if (SINGLE_OPS.has(c)) {
			toks.push({ type: 'op', value: c, upper: c, start: i, end: i + 1 })
			i++
			continue
		}
		if (PUNCT.has(c)) {
			toks.push({ type: 'punct', value: c, upper: c, start: i, end: i + 1 })
			i++
			continue
		}
		throw new SqlError(`Unexpected character '${c}' at position ${i}`)
	}
	return toks
}

// ---------------------------------------------------------------------------
// AST
// ---------------------------------------------------------------------------

type Node =
	| { kind: 'num'; value: number }
	| { kind: 'str'; value: string }
	| { kind: 'col'; name: string }
	| { kind: 'star' }
	| { kind: 'func'; name: string; args: Node[]; params?: Node[]; distinct?: boolean }
	| { kind: 'interval'; seconds: number }
	| { kind: 'binary'; op: string; left: Node; right: Node }
	| { kind: 'unary'; op: string; operand: Node }
	| { kind: 'in'; expr: Node; list: Node[]; negate: boolean }
	| { kind: 'like'; expr: Node; pattern: Node; negate: boolean }
	| { kind: 'between'; expr: Node; low: Node; high: Node; negate: boolean }
	| { kind: 'isnull'; expr: Node; negate: boolean }

interface SelectItem {
	expr: Node
	/** Output column name (alias, or the raw source text of the expression). */
	name: string
}

interface OrderItem {
	expr: Node
	desc: boolean
}

interface ParsedQuery {
	select: SelectItem[]
	dataset: string
	where?: Node
	groupBy: Node[]
	orderBy: OrderItem[]
	limit?: number
	format: string
}

const CLAUSE_KEYWORDS = new Set(['FROM', 'WHERE', 'GROUP', 'ORDER', 'LIMIT', 'FORMAT', 'BY', 'ASC', 'DESC', 'AS'])

// Recognised SQL keywords the emulation deliberately doesn't implement — surfaced
// with a clearer error than a generic "unexpected token".
const UNSUPPORTED_KEYWORDS = new Set([
	'HAVING',
	'OFFSET',
	'JOIN',
	'INNER',
	'LEFT',
	'RIGHT',
	'FULL',
	'UNION',
	'WITH',
])

const INTERVAL_UNITS: Record<string, number> = {
	SECOND: 1,
	SECONDS: 1,
	MINUTE: 60,
	MINUTES: 60,
	HOUR: 3600,
	HOURS: 3600,
	DAY: 86400,
	DAYS: 86400,
	WEEK: 604800,
	WEEKS: 604800,
	// Calendar months/years aren't fixed-length; approximate (documented limitation).
	MONTH: 2592000,
	MONTHS: 2592000,
	YEAR: 31536000,
	YEARS: 31536000,
}

// Binary operator precedence (higher binds tighter).
const PRECEDENCE: Record<string, number> = {
	OR: 1,
	AND: 2,
	'=': 3,
	'!=': 3,
	'<>': 3,
	'<': 3,
	'<=': 3,
	'>': 3,
	'>=': 3,
	'+': 4,
	'-': 4,
	'*': 5,
	'/': 5,
	'%': 5,
}

class Parser {
	private pos = 0
	constructor(private toks: Token[], private sql: string) {}

	private peek(): Token | undefined {
		return this.toks[this.pos]
	}
	private next(): Token {
		const t = this.toks[this.pos]
		if (!t) throw new SqlError('Unexpected end of query')
		this.pos++
		return t
	}
	private eof(): boolean {
		return this.pos >= this.toks.length
	}
	private expectKeyword(kw: string): void {
		const t = this.peek()
		if (!t || t.type !== 'ident' || t.upper !== kw) {
			throw new SqlError(`Expected ${kw}${t ? `, got '${t.value}'` : ''}`)
		}
		this.pos++
	}
	private isKeyword(kw: string): boolean {
		const t = this.peek()
		return !!t && t.type === 'ident' && t.upper === kw
	}

	parse(): ParsedQuery {
		this.expectKeyword('SELECT')
		const select = this.parseSelectList()
		this.expectKeyword('FROM')
		const dataset = this.parseDataset()

		let where: Node | undefined
		if (this.isKeyword('WHERE')) {
			this.next()
			where = this.parseExpr(0)
		}
		const groupBy: Node[] = []
		if (this.isKeyword('GROUP')) {
			this.next()
			this.expectKeyword('BY')
			groupBy.push(this.parseExpr(0))
			while (this.peek()?.value === ',') {
				this.next()
				groupBy.push(this.parseExpr(0))
			}
		}
		const orderBy: OrderItem[] = []
		if (this.isKeyword('ORDER')) {
			this.next()
			this.expectKeyword('BY')
			orderBy.push(this.parseOrderItem())
			while (this.peek()?.value === ',') {
				this.next()
				orderBy.push(this.parseOrderItem())
			}
		}
		let limit: number | undefined
		if (this.isKeyword('LIMIT')) {
			this.next()
			const t = this.next()
			if (t.type !== 'num') throw new SqlError(`Expected number after LIMIT, got '${t.value}'`)
			limit = Number.parseInt(t.value, 10)
		}
		let format = 'JSON'
		if (this.isKeyword('FORMAT')) {
			this.next()
			format = this.next().value.toUpperCase()
		}
		// allow trailing semicolon
		if (this.peek()?.value === ';') this.next()
		if (!this.eof()) {
			const t = this.peek()!
			if (UNSUPPORTED_KEYWORDS.has(t.upper)) {
				throw new SqlError(`'${t.value}' is not supported by the local Analytics Engine emulation`)
			}
			throw new SqlError(`Unexpected token '${t.value}' — the local Analytics Engine emulation supports a subset of the SQL API`)
		}
		return { select, dataset, where, groupBy, orderBy, limit, format }
	}

	private parseSelectList(): SelectItem[] {
		const items: SelectItem[] = []
		for (;;) {
			const startTok = this.peek()
			const expr = this.parseExpr(0)
			const endTok = this.toks[this.pos - 1]!
			let name: string
			if (this.isKeyword('AS')) {
				this.next()
				name = this.next().value
			} else if (this.peek()?.type === 'ident' && !CLAUSE_KEYWORDS.has(this.peek()!.upper)) {
				// implicit alias: `expr alias`
				name = this.next().value
			} else {
				// no alias → use the raw source text of the expression (ClickHouse behaviour)
				name = this.sql.slice(startTok!.start, endTok.end).trim()
			}
			items.push({ expr, name })
			if (this.peek()?.value === ',') {
				this.next()
				continue
			}
			break
		}
		return items
	}

	private parseDataset(): string {
		const t = this.next()
		if (t.type !== 'ident' && t.type !== 'str') {
			throw new SqlError(`Expected dataset name after FROM, got '${t.value}'`)
		}
		return t.value
	}

	private parseOrderItem(): OrderItem {
		const expr = this.parseExpr(0)
		let desc = false
		if (this.isKeyword('ASC')) this.next()
		else if (this.isKeyword('DESC')) {
			this.next()
			desc = true
		}
		return { expr, desc }
	}

	// --- Pratt expression parser ---

	private parseExpr(minPrec: number): Node {
		let left = this.parsePrefix()
		for (;;) {
			const t = this.peek()
			if (!t) break
			// Postfix predicates (IN / LIKE / BETWEEN / IS [NOT] NULL) bind at
			// comparison precedence (3). Skip them when parsing a tighter operand.
			if (t.type === 'ident' && 3 >= minPrec) {
				const u = t.upper
				if (u === 'IN' || u === 'LIKE' || u === 'BETWEEN' || u === 'IS') {
					left = this.parsePredicate(left, false)
					continue
				}
				if (u === 'NOT') {
					const after = this.toks[this.pos + 1]
					if (after?.type === 'ident' && (after.upper === 'IN' || after.upper === 'LIKE' || after.upper === 'BETWEEN')) {
						this.next() // consume NOT
						left = this.parsePredicate(left, true)
						continue
					}
				}
			}
			const op = t.type === 'op' ? t.value : t.type === 'ident' && (t.upper === 'AND' || t.upper === 'OR') ? t.upper : undefined
			if (!op) break
			const prec = PRECEDENCE[op]
			if (prec === undefined || prec < minPrec) break
			this.next()
			const right = this.parseExpr(prec + 1)
			left = { kind: 'binary', op, left, right }
		}
		return left
	}

	/** Parse a postfix predicate after `left`: IN (...), LIKE p, BETWEEN a AND b, IS [NOT] NULL. */
	private parsePredicate(left: Node, negate: boolean): Node {
		const kw = this.next().upper
		if (kw === 'IN') {
			if (this.next().value !== '(') throw new SqlError('Expected ( after IN')
			const list: Node[] = []
			if (this.peek()?.value !== ')') {
				list.push(this.parseExpr(0))
				while (this.peek()?.value === ',') {
					this.next()
					list.push(this.parseExpr(0))
				}
			}
			if (this.next().value !== ')') throw new SqlError('Expected ) to close IN list')
			return { kind: 'in', expr: left, list, negate }
		}
		if (kw === 'LIKE') {
			// Parse the pattern above AND/OR/comparison so it doesn't swallow the rest.
			return { kind: 'like', expr: left, pattern: this.parseExpr(4), negate }
		}
		if (kw === 'BETWEEN') {
			const low = this.parseExpr(4)
			this.expectKeyword('AND')
			const high = this.parseExpr(4)
			return { kind: 'between', expr: left, low, high, negate }
		}
		// IS [NOT] NULL
		let neg = false
		if (this.isKeyword('NOT')) {
			this.next()
			neg = true
		}
		this.expectKeyword('NULL')
		return { kind: 'isnull', expr: left, negate: neg }
	}

	/**
	 * Logical `NOT` is a low-precedence prefix: it binds looser than comparison
	 * (so `NOT a = b` is `NOT (a = b)`, matching SQL/ClickHouse) but tighter than
	 * AND/OR. We capture the comparison-level operand to its right, then return so
	 * the binary loop in `parseExpr` can still pick up any following AND/OR.
	 * (Postfix `NOT IN/LIKE/BETWEEN` is handled separately inside `parseExpr`.)
	 */
	private parsePrefix(): Node {
		const t = this.peek()
		if (t?.type === 'ident' && t.upper === 'NOT') {
			this.next()
			// Operand at comparison precedence (3): includes comparisons and tighter
			// operators, but stops before AND (2) / OR (1).
			return { kind: 'unary', op: 'NOT', operand: this.parseExpr(3) }
		}
		return this.parseUnary()
	}

	private parseUnary(): Node {
		const t = this.peek()
		if (t?.type === 'op' && t.value === '-') {
			this.next()
			return { kind: 'unary', op: '-', operand: this.parseUnary() }
		}
		return this.parsePrimary()
	}

	private parsePrimary(): Node {
		const t = this.next()
		if (t.type === 'num') {
			const value = Number(t.value)
			if (Number.isNaN(value)) throw new SqlError(`Invalid numeric literal '${t.value}'`)
			return { kind: 'num', value }
		}
		if (t.type === 'str') return { kind: 'str', value: t.value }
		if (t.type === 'op' && t.value === '*') return { kind: 'star' }
		if (t.value === '(') {
			const inner = this.parseExpr(0)
			if (this.next().value !== ')') throw new SqlError('Expected )')
			return inner
		}
		if (t.type === 'ident') {
			// INTERVAL 'n' UNIT  /  INTERVAL n UNIT
			if (t.upper === 'INTERVAL') return this.parseInterval()
			// function call?
			if (this.peek()?.value === '(') {
				return this.parseFunc(t.value)
			}
			return { kind: 'col', name: t.value }
		}
		throw new SqlError(`Unexpected token '${t.value}'`)
	}

	private parseInterval(): Node {
		const amountTok = this.next()
		const amount = Number(amountTok.value)
		if (Number.isNaN(amount)) throw new SqlError(`Invalid INTERVAL amount '${amountTok.value}'`)
		const unitTok = this.next()
		const secs = INTERVAL_UNITS[unitTok.upper]
		if (secs === undefined) throw new SqlError(`Unsupported INTERVAL unit '${unitTok.value}'`)
		return { kind: 'interval', seconds: amount * secs }
	}

	private parseFunc(name: string): Node {
		const { args: first, distinct } = this.parseArgList(name)
		// Parametric aggregates like quantileWeighted(0.5)(value, weight): a second arg list.
		// The first list holds the parameters (e.g. the level), the second the arguments.
		if (this.peek()?.value === '(') {
			const { args } = this.parseArgList(name)
			return { kind: 'func', name, args, params: first }
		}
		return { kind: 'func', name, args: first, distinct }
	}

	private parseArgList(name: string): { args: Node[]; distinct: boolean } {
		this.next() // (
		let distinct = false
		if (this.isKeyword('DISTINCT')) {
			this.next()
			distinct = true
		}
		const args: Node[] = []
		if (this.peek()?.value !== ')') {
			args.push(this.parseExpr(0))
			while (this.peek()?.value === ',') {
				this.next()
				args.push(this.parseExpr(0))
			}
		}
		if (this.next().value !== ')') throw new SqlError(`Expected ) after ${name}(...)`)
		return { args, distinct }
	}
}

// ---------------------------------------------------------------------------
// Emitter: AST → SQLite expression (+ result type for `meta`)
// ---------------------------------------------------------------------------

interface EmitCtx {
	/** Baked `now()` value in epoch seconds (no UDFs in bun:sqlite). */
	nowSeconds: number
	/** SELECT output aliases — referenceable from GROUP BY / ORDER BY. */
	aliases: Set<string>
	/** Set when a LIKE is emitted, so the runner can force case-sensitive matching. */
	usesLike: boolean
}

const COL_RE = /^(blob([1-9]|1[0-9]|20)|double([1-9]|1[0-9]|20)|index1|_sample_interval|timestamp|dataset)$/

function colType(name: string): string {
	if (name === 'timestamp') return 'DateTime'
	if (name.startsWith('double')) return 'Float64'
	if (name === '_sample_interval') return 'UInt32'
	return 'String'
}

function quoteStr(s: string): string {
	return `'${s.replace(/'/g, "''")}'`
}

function emit(node: Node, ctx: EmitCtx): string {
	switch (node.kind) {
		case 'num':
			return String(node.value)
		case 'str':
			return quoteStr(node.value)
		case 'star':
			return '*'
		case 'interval':
			return String(node.seconds)
		case 'col': {
			// Canonicalise stored ms-epoch timestamp to ClickHouse-style seconds.
			if (node.name === 'timestamp') return '(timestamp / 1000.0)'
			if (COL_RE.test(node.name)) return node.name
			// A reference to a SELECT alias (valid in GROUP BY / ORDER BY).
			if (ctx.aliases.has(node.name)) return JSON.stringify(node.name)
			throw new SqlError(`Unknown column '${node.name}'`)
		}
		case 'unary':
			return node.op === 'NOT' ? `(NOT ${emit(node.operand, ctx)})` : `(-${emit(node.operand, ctx)})`
		case 'binary': {
			// ClickHouse `/` is always floating-point; SQLite `/` truncates when both
			// operands are integers — force real division to match.
			if (node.op === '/') return `(${emit(node.left, ctx)} * 1.0 / ${emit(node.right, ctx)})`
			const op = node.op === '<>' ? '!=' : node.op
			return `(${emit(node.left, ctx)} ${op} ${emit(node.right, ctx)})`
		}
		case 'in': {
			const list = node.list.map(n => emit(n, ctx)).join(', ')
			return `(${emit(node.expr, ctx)} ${node.negate ? 'NOT IN' : 'IN'} (${list}))`
		}
		case 'like':
			// ClickHouse LIKE is case-sensitive; SQLite's is not. Flagged here so the
			// runner flips `PRAGMA case_sensitive_like` for the query.
			ctx.usesLike = true
			return `(${emit(node.expr, ctx)} ${node.negate ? 'NOT LIKE' : 'LIKE'} ${emit(node.pattern, ctx)})`
		case 'between':
			return `(${emit(node.expr, ctx)} ${node.negate ? 'NOT BETWEEN' : 'BETWEEN'} ${emit(node.low, ctx)} AND ${emit(node.high, ctx)})`
		case 'isnull':
			return `(${emit(node.expr, ctx)} IS ${node.negate ? 'NOT NULL' : 'NULL'})`
		case 'func':
			return emitFunc(node, ctx)
	}
}

const QUANTILE_FNS = new Set(['quantile', 'quantileexact', 'quantileweighted', 'quantileexactweighted'])

/** Non-quantile aggregate functions. */
const PLAIN_AGGREGATE_FNS = new Set(['count', 'sum', 'avg', 'min', 'max'])

/**
 * Whether `node` contains a non-quantile aggregate anywhere in its subtree. Used
 * to reject aggregates where they aren't allowed (WHERE / GROUP BY) and nested
 * inside another aggregate — both of which SQLite would otherwise surface as an
 * opaque "misuse of aggregate" error.
 */
function containsPlainAggregate(node: Node): boolean {
	switch (node.kind) {
		case 'func':
			if (PLAIN_AGGREGATE_FNS.has(node.name.toLowerCase())) return true
			return node.args.some(containsPlainAggregate) || (node.params?.some(containsPlainAggregate) ?? false)
		case 'binary':
			return containsPlainAggregate(node.left) || containsPlainAggregate(node.right)
		case 'unary':
			return containsPlainAggregate(node.operand)
		case 'in':
			return containsPlainAggregate(node.expr) || node.list.some(containsPlainAggregate)
		case 'like':
			return containsPlainAggregate(node.expr) || containsPlainAggregate(node.pattern)
		case 'between':
			return containsPlainAggregate(node.expr) || containsPlainAggregate(node.low) || containsPlainAggregate(node.high)
		case 'isnull':
			return containsPlainAggregate(node.expr)
		default:
			return false
	}
}

/**
 * Expected `[min, max]` argument counts per function, enforced before emit so a
 * wrong-arity call fails with a clear error instead of emitting a literal
 * `undefined` (e.g. `if(x, 1)` → `... ELSE undefined`, which SQLite then reads as
 * an unknown column).
 */
const FN_ARITY: Record<string, [number, number]> = {
	count: [0, 1],
	sum: [1, 1],
	avg: [1, 1],
	min: [1, 1],
	max: [1, 1],
	touint32: [1, 1],
	touint64: [1, 1],
	toint32: [1, 1],
	toint64: [1, 1],
	tofloat64: [1, 1],
	tofloat32: [1, 1],
	tostring: [1, 1],
	todatetime: [1, 1],
	intdiv: [2, 2],
	tostartofinterval: [2, 2],
	tostartofminute: [1, 1],
	tostartofhour: [1, 1],
	tostartofday: [1, 1],
	abs: [1, 1],
	round: [1, 2],
	min2: [2, 2],
	max2: [2, 2],
	coalesce: [1, Number.POSITIVE_INFINITY],
	length: [1, 1],
	lower: [1, 1],
	upper: [1, 1],
	floor: [1, 1],
	if: [3, 3],
	now: [0, 0],
}

function checkArity(node: Extract<Node, { kind: 'func' }>): void {
	const arity = FN_ARITY[node.name.toLowerCase()]
	if (!arity) return
	const [min, max] = arity
	const got = node.args.length
	if (got >= min && got <= max) return
	const noun = (n: number) => (n === 1 ? 'argument' : 'arguments')
	const expected = max === Number.POSITIVE_INFINITY
		? `at least ${min} ${noun(min)}`
		: min === max
		? `exactly ${min} ${noun(min)}`
		: `${min} to ${max} arguments`
	throw new SqlError(`Function '${node.name}' expects ${expected}, got ${got}`)
}

function emitFunc(node: Extract<Node, { kind: 'func' }>, ctx: EmitCtx): string {
	const fn = node.name.toLowerCase()
	if (QUANTILE_FNS.has(fn)) {
		throw new SqlError(`Function '${node.name}' is only supported in the SELECT list, not inside other expressions`)
	}
	if (PLAIN_AGGREGATE_FNS.has(fn) && node.args.some(containsPlainAggregate)) {
		throw new SqlError(`Aggregate function '${node.name}' cannot be nested inside another aggregate`)
	}
	checkArity(node)
	const a = node.args.map(arg => emit(arg, ctx))
	switch (fn) {
		// --- aggregates ---
		case 'count':
			if (node.distinct && a.length === 1) return `COUNT(DISTINCT ${a[0]})`
			return 'COUNT(*)'
		case 'sum':
			// ClickHouse sum() over zero/all-NULL rows is 0; SQLite SUM is NULL.
			return `COALESCE(SUM(${a[0]}), 0)`
		case 'avg':
			return `AVG(${a[0]})`
		case 'min':
			return `MIN(${a[0]})`
		case 'max':
			return `MAX(${a[0]})`
		// --- type casts (ClickHouse → SQLite) ---
		case 'touint32':
		case 'touint64':
		case 'toint32':
		case 'toint64':
			return `CAST(${a[0]} AS INTEGER)`
		case 'tofloat64':
		case 'tofloat32':
			return `CAST(${a[0]} AS REAL)`
		case 'tostring':
			return `CAST(${a[0]} AS TEXT)`
		case 'todatetime':
			// Our DateTime is just epoch seconds; identity.
			return `(${a[0]})`
		// --- integer / time bucketing ---
		case 'intdiv':
			return `(CAST(${a[0]} AS INTEGER) / CAST(${a[1]} AS INTEGER))`
		case 'tostartofinterval': {
			// toStartOfInterval(ts, INTERVAL n unit) → floor to bucket (seconds)
			const secs = node.args[1]?.kind === 'interval' ? node.args[1].seconds : undefined
			if (secs === undefined) throw new SqlError('toStartOfInterval requires an INTERVAL literal as its 2nd argument')
			return `((CAST(${a[0]} AS INTEGER) / ${secs}) * ${secs})`
		}
		case 'tostartofminute':
			return `((CAST(${a[0]} AS INTEGER) / 60) * 60)`
		case 'tostartofhour':
			return `((CAST(${a[0]} AS INTEGER) / 3600) * 3600)`
		case 'tostartofday':
			return `((CAST(${a[0]} AS INTEGER) / 86400) * 86400)`
		// --- misc passthrough (SQLite has these) ---
		case 'abs':
		case 'round':
		case 'min2':
		case 'max2':
		case 'coalesce':
		case 'length':
		case 'lower':
		case 'upper':
			return `${fn.toUpperCase()}(${a.join(', ')})`
		case 'floor':
			return `CAST(${a[0]} AS INTEGER)`
		case 'if':
			return `(CASE WHEN ${a[0]} THEN ${a[1]} ELSE ${a[2]} END)`
		case 'now':
			return String(ctx.nowSeconds)
		default:
			throw new SqlError(`Function '${node.name}' is not supported by the local Analytics Engine emulation yet`)
	}
}

function inferType(node: Node): string {
	switch (node.kind) {
		case 'num':
			return Number.isInteger(node.value) ? 'UInt64' : 'Float64'
		case 'str':
			return 'String'
		case 'col':
			return colType(node.name)
		case 'binary':
			return ['=', '!=', '<>', '<', '<=', '>', '>=', 'AND', 'OR'].includes(node.op) ? 'UInt8' : 'Float64'
		case 'unary':
			return node.op === 'NOT' ? 'UInt8' : inferType(node.operand)
		case 'in':
		case 'like':
		case 'between':
		case 'isnull':
			return 'UInt8'
		case 'func': {
			const fn = node.name.toLowerCase()
			if (fn === 'count') return 'UInt64'
			if (['sum', 'avg', 'tofloat64', 'tofloat32', 'abs', 'round'].includes(fn)) return 'Float64'
			if (['min', 'max', 'coalesce', 'if'].includes(fn)) return node.args[0] ? inferType(node.args[0]) : 'String'
			if (['touint32', 'touint64', 'toint32', 'toint64', 'intdiv', 'floor', 'length'].includes(fn)) return 'UInt64'
			if (fn.startsWith('tostartof') || fn === 'todatetime' || fn === 'now') return 'DateTime'
			if (['lower', 'upper', 'tostring'].includes(fn)) return 'String'
			return 'Float64'
		}
		default:
			return 'String'
	}
}

// ---------------------------------------------------------------------------
// Public: translate + run
// ---------------------------------------------------------------------------

/** A quantile that's collected per-group via `group_concat` and computed in JS. */
interface QuantileSpec {
	/** Internal SQLite column holding the comma-joined values for the group. */
	tempCol: string
	/** Output column name. */
	outputName: string
	/** Quantile level in [0, 1]. */
	level: number
	/**
	 * `quantile`/`quantileWeighted` interpolate linearly (ClickHouse default);
	 * the `*Exact*` variants return an actual element (nearest-rank).
	 */
	interpolate: boolean
}

/**
 * Post-processing applied in JS when the query uses quantile functions.
 * `bun:sqlite` has no UDFs and no percentile aggregate, so we collect the
 * per-group values with `group_concat` and finish the computation here. ORDER BY
 * / LIMIT then also have to run in JS (they may reference a computed quantile).
 */
interface PostProcess {
	quantiles: QuantileSpec[]
	orderBy: { name: string; desc: boolean }[]
	limit?: number
}

export interface TranslatedQuery {
	sqlite: string
	columns: { name: string; type: string }[]
	format: string
	/** `SELECT *` — column metadata is derived from the result rows at run time. */
	hasStar?: boolean
	/** Present only when the query uses quantile functions. */
	postProcess?: PostProcess
	/** The query uses LIKE — run it with `PRAGMA case_sensitive_like=ON` (ClickHouse semantics). */
	caseSensitiveLike?: boolean
}

/** Build `meta` from result-row keys (used for `SELECT *`, where columns aren't known up front). */
function deriveMetaFromRows(rows: Record<string, unknown>[]): { name: string; type: string }[] {
	const keys = rows.length ? Object.keys(rows[0]!) : []
	return keys.map(k => ({ name: k, type: colType(k) }))
}

/**
 * Render an epoch-seconds value as a ClickHouse `DateTime` string
 * (`YYYY-MM-DD HH:MM:SS`, UTC) — the form the real Analytics Engine SQL API
 * returns. Fractional seconds are truncated (ClickHouse `DateTime` is
 * second-resolution).
 */
function formatDateTime(epochSeconds: number): string {
	const d = new Date(Math.floor(epochSeconds) * 1000)
	const p = (n: number) => String(n).padStart(2, '0')
	return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`
}

/**
 * Convert `DateTime` output columns from their internal numeric form to ClickHouse
 * datetime strings, in place — the final projection step so prod and local agree
 * on the result shape. Non-`*` queries canonicalise timestamps to **seconds** in
 * the emitted SQL; `SELECT *` returns the raw `timestamp` column, stored as **ms**.
 * NULL DateTimes (e.g. `max(timestamp)` over an empty dataset) are left untouched.
 */
function formatDateTimeColumns(data: Record<string, unknown>[], t: TranslatedQuery): void {
	if (t.hasStar) {
		for (const row of data) {
			const v = row.timestamp
			if (typeof v === 'number') row.timestamp = formatDateTime(v / 1000)
		}
		return
	}
	const dtCols = t.columns.filter(c => c.type === 'DateTime').map(c => c.name)
	for (const row of data) {
		for (const name of dtCols) {
			const v = row[name]
			if (typeof v === 'number') row[name] = formatDateTime(v)
		}
	}
}

function isQuantile(node: Node): node is Extract<Node, { kind: 'func' }> {
	return node.kind === 'func' && QUANTILE_FNS.has(node.name.toLowerCase())
}

function quantileLevel(node: Extract<Node, { kind: 'func' }>): number {
	if (!node.params || node.params.length !== 1 || node.params[0]!.kind !== 'num') {
		throw new SqlError(`${node.name} requires a single numeric level, e.g. ${node.name}(0.95)(double1)`)
	}
	const level = (node.params[0] as { value: number }).value
	if (level < 0 || level > 1) throw new SqlError(`${node.name} level must be between 0 and 1`)
	if (node.args.length < 1) throw new SqlError(`${node.name} requires a value argument`)
	return level
}

/** Translate a Cloudflare Analytics Engine SQL string into a SQLite query. */
export function translateAnalyticsEngineSql(sql: string, nowSeconds: number): TranslatedQuery {
	const parsed = new Parser(tokenize(sql), sql).parse()
	const ctx: EmitCtx = { nowSeconds, aliases: new Set(), usesLike: false }
	const hasQuantiles = parsed.select.some(item => isQuantile(item.expr))
	const hasStar = parsed.select.some(item => item.expr.kind === 'star')
	if (hasStar && hasQuantiles) throw new SqlError('SELECT * cannot be combined with quantile functions')
	// Aggregates aren't valid here; reject with a clear message instead of letting
	// SQLite raise an opaque "misuse of aggregate" error.
	if (parsed.where && containsPlainAggregate(parsed.where)) {
		throw new SqlError('Aggregate functions are not allowed in the WHERE clause')
	}
	if (parsed.groupBy.some(containsPlainAggregate)) {
		throw new SqlError('Aggregate functions are not allowed in GROUP BY')
	}

	// SELECT + WHERE are emitted before aliases become referenceable (SQLite, like
	// most engines, does not allow output aliases in WHERE).
	const quantiles: QuantileSpec[] = []
	const selectParts = parsed.select.map((item, i) => {
		// `*` is emitted bare — SQLite rejects an alias on a wildcard.
		if (item.expr.kind === 'star') return '*'
		if (isQuantile(item.expr)) {
			const level = quantileLevel(item.expr)
			const tempCol = `__q${i}`
			// The `*Exact*` variants return a real element; plain `quantile`/`quantileWeighted` interpolate.
			const interpolate = !item.expr.name.toLowerCase().includes('exact')
			quantiles.push({ tempCol, outputName: item.name, level, interpolate })
			// Collect the (locally unweighted) values for this group; computed in JS.
			return `group_concat(${emit(item.expr.args[0]!, ctx)}) AS ${JSON.stringify(tempCol)}`
		}
		return `${emit(item.expr, ctx)} AS ${JSON.stringify(item.name)}`
	})
	const columns = parsed.select
		.filter(item => item.expr.kind !== 'star')
		.map(item => ({
			name: item.name,
			type: isQuantile(item.expr) ? 'Float64' : inferType(item.expr),
		}))

	let sqlite = `SELECT ${selectParts.join(', ')} FROM analytics_engine`

	const conditions = [`dataset = ${quoteStr(parsed.dataset)}`]
	if (parsed.where) conditions.push(emit(parsed.where, ctx))
	sqlite += ` WHERE ${conditions.join(' AND ')}`

	// GROUP BY / ORDER BY may reference SELECT aliases.
	for (const item of parsed.select) ctx.aliases.add(item.name)
	if (parsed.groupBy.length) sqlite += ` GROUP BY ${parsed.groupBy.map(g => emit(g, ctx)).join(', ')}`

	if (!hasQuantiles) {
		if (parsed.orderBy.length) {
			sqlite += ` ORDER BY ${parsed.orderBy.map(o => `${emit(o.expr, ctx)} ${o.desc ? 'DESC' : 'ASC'}`).join(', ')}`
		}
		if (parsed.limit !== undefined) sqlite += ` LIMIT ${parsed.limit}`
		return { sqlite, columns, format: parsed.format, hasStar, caseSensitiveLike: ctx.usesLike }
	}

	// Quantile path: ORDER BY / LIMIT run in JS after the quantiles are computed.
	const outputNames = new Set(columns.map(c => c.name))
	const orderBy = parsed.orderBy.map(o => {
		if (o.expr.kind !== 'col' || !outputNames.has(o.expr.name)) {
			throw new SqlError('ORDER BY must reference a selected column when using quantile functions')
		}
		return { name: o.expr.name, desc: o.desc }
	})
	return { sqlite, columns, format: parsed.format, caseSensitiveLike: ctx.usesLike, postProcess: { quantiles, orderBy, limit: parsed.limit } }
}

/**
 * Compute a quantile from collected values.
 * - `interpolate` (plain `quantile`/`quantileWeighted`): linear interpolation at
 *   position `level * (n-1)` (the "type 7" definition used by ClickHouse `quantile`,
 *   NumPy, and Excel PERCENTILE.INC).
 * - otherwise (`*Exact*` variants): nearest-rank — returns an actual element.
 */
function computeQuantile(values: number[], level: number, interpolate: boolean): number | null {
	if (values.length === 0) return null
	const sorted = [...values].sort((a, b) => a - b)
	const n = sorted.length
	if (!interpolate) {
		const idx = Math.round(level * (n - 1))
		return sorted[Math.min(Math.max(idx, 0), n - 1)]!
	}
	const pos = level * (n - 1)
	const lo = Math.floor(pos)
	const hi = Math.ceil(pos)
	if (lo === hi) return sorted[lo]!
	return sorted[lo]! + (pos - lo) * (sorted[hi]! - sorted[lo]!)
}

function parseConcatNumbers(value: unknown): number[] {
	if (value == null) return []
	return String(value)
		.split(',')
		.map(Number)
		.filter(n => !Number.isNaN(n))
}

function applyPostProcess(
	rows: Record<string, unknown>[],
	pp: PostProcess,
	columns: { name: string }[],
): Record<string, unknown>[] {
	// Compute each quantile from its group_concat'd values, then reproject rows in
	// declared column order (so output keys match `meta`).
	let out = rows.map(row => {
		for (const q of pp.quantiles) {
			row[q.outputName] = computeQuantile(parseConcatNumbers(row[q.tempCol]), q.level, q.interpolate)
		}
		const projected: Record<string, unknown> = {}
		for (const c of columns) projected[c.name] = row[c.name]
		return projected
	})

	if (pp.orderBy.length) {
		out = out.sort((a, b) => {
			for (const { name, desc } of pp.orderBy) {
				const av = a[name]
				const bv = b[name]
				let cmp: number
				if (typeof av === 'number' && typeof bv === 'number') cmp = av - bv
				else cmp = String(av).localeCompare(String(bv))
				if (cmp !== 0) return desc ? -cmp : cmp
			}
			return 0
		})
	}
	if (pp.limit !== undefined) out = out.slice(0, pp.limit)
	return out
}

export interface AnalyticsEngineSqlResult {
	meta: { name: string; type: string }[]
	data: Record<string, unknown>[]
	rows: number
	rows_before_limit_at_least: number
}

/**
 * Run a translated query, forcing case-sensitive LIKE when needed. The
 * `case_sensitive_like` pragma is connection-global, but the query runs
 * synchronously between toggling it on and off, so no other binding sharing the
 * connection can observe the flip.
 */
function executeTranslated(db: Database, t: TranslatedQuery): Record<string, unknown>[] {
	if (!t.caseSensitiveLike) return db.query(t.sqlite).all() as Record<string, unknown>[]
	db.run('PRAGMA case_sensitive_like=ON')
	try {
		return db.query(t.sqlite).all() as Record<string, unknown>[]
	} finally {
		db.run('PRAGMA case_sensitive_like=OFF')
	}
}

/** Translate + execute a Cloudflare Analytics Engine SQL query against SQLite. */
export function runAnalyticsEngineSql(db: Database, sql: string, nowMs: number = Date.now()): AnalyticsEngineSqlResult {
	const translated = translateAnalyticsEngineSql(sql, Math.floor(nowMs / 1000))
	let data = executeTranslated(db, translated)
	if (translated.postProcess) data = applyPostProcess(data, translated.postProcess, translated.columns)
	formatDateTimeColumns(data, translated)
	const meta = translated.hasStar ? deriveMetaFromRows(data) : translated.columns
	return {
		meta,
		data,
		rows: data.length,
		rows_before_limit_at_least: data.length,
	}
}

/**
 * Run an Analytics Engine SQL string and build a Cloudflare-shaped `Response`
 * (JSON by default, NDJSON for `FORMAT JSONEachRow`, or a 400 with the error
 * message). Synchronous so callers can wrap it in their own tracing span.
 */
export function buildAnalyticsEngineSqlResponse(db: Database, sql: string): Response {
	const trimmed = sql.trim()
	if (!trimmed) return new Response('Empty query', { status: 400 })
	try {
		const translated = translateAnalyticsEngineSql(trimmed, Math.floor(Date.now() / 1000))
		let data = executeTranslated(db, translated)
		if (translated.postProcess) data = applyPostProcess(data, translated.postProcess, translated.columns)
		formatDateTimeColumns(data, translated)
		if (translated.format === 'JSONEACHROW') {
			const body = data.map(row => JSON.stringify(row)).join('\n')
			return new Response(body, { headers: { 'content-type': 'application/x-ndjson' } })
		}
		const meta = translated.hasStar ? deriveMetaFromRows(data) : translated.columns
		const result: AnalyticsEngineSqlResult = { meta, data, rows: data.length, rows_before_limit_at_least: data.length }
		return new Response(JSON.stringify(result), { headers: { 'content-type': 'application/json' } })
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err)
		return new Response(message, { status: 400 })
	}
}

/**
 * Handle an intercepted POST to the Analytics Engine SQL API. Returns a
 * Cloudflare-shaped JSON `Response` (or a 400 with the error message).
 */
export async function handleAnalyticsEngineSqlRequest(db: Database, request: Request): Promise<Response> {
	return buildAnalyticsEngineSqlResponse(db, await request.text())
}
