// Measures the conformance pass rate per area: runs tests/conformance with every case as a plain
// test (CONFORMANCE_RECORD=1), reads bun's JUnit report and prints a markdown table.
//   bun scripts/conformance-report.ts [--update] [test files…]
// --update rewrites tests/conformance/known-failures/<corpus>.json from the measured failures.

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { knownFailuresPath, parseKnownFailures, STALE_CHECK_PREFIX } from '../tests/conformance/harness'

const ROOT = resolve(import.meta.dir, '..')
const CONFORMANCE_DIR = join(ROOT, 'tests/conformance')

interface CaseResult {
	corpus: string
	area: string
	id: string
	failure: string | null
}

function decodeXml(text: string): string {
	return text
		.replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'")
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&amp;/g, '&')
}

function attribute(tag: string, name: string): string {
	const match = new RegExp(`\\s${name}="([^"]*)"`).exec(tag)
	if (match?.[1] === undefined) throw new Error(`JUnit testcase without ${name}: ${tag}`)
	return decodeXml(match[1])
}

function parseJunit(xml: string): CaseResult[] {
	const results: CaseResult[] = []
	const testcase = /<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g
	for (const match of xml.matchAll(testcase)) {
		const tag = match[1] ?? ''
		const body = match[3] ?? ''
		const failure = /<failure\b[^>]*?message="([^"]*)"/.exec(body)
		const isSkipped = /<skipped\b/.test(body)
		const id = attribute(tag, 'name')
		if (isSkipped || id.startsWith(STALE_CHECK_PREFIX)) continue
		results.push({
			corpus: basename(attribute(tag, 'file')).replace(/\.test\.ts$/, ''),
			area: attribute(tag, 'classname'),
			id,
			failure: failure?.[1] !== undefined ? decodeXml(failure[1]) : /<failure\b/.test(body) ? 'failed' : null,
		})
	}
	return results
}

function firstLine(message: string): string {
	const line = message.split('\n').find(l => l.trim() !== '') ?? 'failed'
	return line.length > 200 ? `${line.slice(0, 197)}...` : line
}

function percent(passed: number, total: number): string {
	return total === 0 ? '-' : `${((passed / total) * 100).toFixed(1)}%`
}

const args = process.argv.slice(2)
const update = args.includes('--update')
const files = args.filter(a => a !== '--update')

const scratch = mkdtempSync(join(tmpdir(), 'lopata-conformance-report-'))
try {
	const junitPath = join(scratch, 'junit.xml')
	const proc = Bun.spawn(['bun', 'test', ...(files.length ? files : [CONFORMANCE_DIR]), '--reporter=junit', `--reporter-outfile=${junitPath}`], {
		cwd: ROOT,
		env: { ...process.env, CONFORMANCE_RECORD: '1' },
		stdout: 'ignore',
		stderr: 'inherit',
	})
	await proc.exited
	const results = parseJunit(readFileSync(junitPath, 'utf8'))

	const byArea = new Map<string, { corpus: string; passed: number; total: number }>()
	for (const r of results) {
		const key = `${r.corpus}\u0000${r.area}`
		const row = byArea.get(key) ?? { corpus: r.corpus, passed: 0, total: 0 }
		row.total++
		if (r.failure === null) row.passed++
		byArea.set(key, row)
	}

	const lines = ['| Corpus | Area | Passed | Failed | Total | Pass rate |', '| --- | --- | ---: | ---: | ---: | ---: |']
	let passed = 0
	let total = 0
	for (const [key, row] of [...byArea].sort(([a], [b]) => a.localeCompare(b))) {
		const area = key.split('\u0000')[1]
		lines.push(`| ${row.corpus} | ${area} | ${row.passed} | ${row.total - row.passed} | ${row.total} | ${percent(row.passed, row.total)} |`)
		passed += row.passed
		total += row.total
	}
	lines.push(`| **all** | | **${passed}** | **${total - passed}** | **${total}** | **${percent(passed, total)}** |`)
	console.log(lines.join('\n'))

	const requested = (files.length ? files : [...new Bun.Glob('*.test.ts').scanSync(CONFORMANCE_DIR)]).map(f => basename(f).replace(/\.test\.ts$/, ''))
	const missing = requested.filter(corpus => ![...byArea.keys()].some(key => key.startsWith(`${corpus}\u0000`)))
	if (missing.length) console.error(`\nNo results for: ${missing.join(', ')} (the file failed to load or registered no cases)`)

	if (update) {
		// Merge per id, so a run over a subset (CONFORMANCE_ONLY) keeps the entries of cases it did not run.
		const corpora = new Set(results.map(r => r.corpus))
		for (const corpus of corpora) {
			const path = knownFailuresPath(corpus)
			const ran = new Set(results.filter(r => r.corpus === corpus).map(r => r.id))
			const previous = existsSync(path) ? parseKnownFailures(JSON.parse(readFileSync(path, 'utf8')), path) : new Map<string, string>()
			const merged = new Map([...previous].filter(([id]) => !ran.has(id)))
			for (const r of results) if (r.corpus === corpus && r.failure !== null) merged.set(r.id, firstLine(r.failure))
			const sorted = Object.fromEntries([...merged].sort(([a], [b]) => a.localeCompare(b)))
			writeFileSync(path, `${JSON.stringify(sorted, null, '\t')}\n`)
		}
		console.log(`\nUpdated known failures for: ${[...corpora].join(', ')}`)
	}
	if (missing.length) process.exitCode = 1
} finally {
	rmSync(scratch, { recursive: true, force: true })
}
