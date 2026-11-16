// Measures the conformance pass rate per area: runs tests/conformance with every case as a plain
// test (CONFORMANCE_RECORD=1), reads bun's JUnit report and prints a markdown table.
//   bun scripts/conformance-report.ts [--update] [test files…]
// --update rewrites tests/conformance/known-failures/<corpus>.json from the measured failures.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'

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
	if (!match?.[1]) throw new Error(`JUnit testcase without ${name}: ${tag}`)
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
		if (isSkipped) continue
		results.push({
			corpus: basename(attribute(tag, 'file')).replace(/\.test\.ts$/, ''),
			area: attribute(tag, 'classname'),
			id: attribute(tag, 'name'),
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

	if (update) {
		const corpora = new Set(results.map(r => r.corpus))
		for (const corpus of corpora) {
			const failures = Object.fromEntries(
				results
					.filter(r => r.corpus === corpus && r.failure !== null)
					.sort((a, b) => a.id.localeCompare(b.id))
					.map(r => [r.id, firstLine(r.failure ?? '')]),
			)
			writeFileSync(join(CONFORMANCE_DIR, 'known-failures', `${corpus}.json`), `${JSON.stringify(failures, null, '\t')}\n`)
		}
		console.log(`\nUpdated known failures for: ${[...corpora].join(', ')}`)
	}
} finally {
	rmSync(scratch, { recursive: true, force: true })
}
