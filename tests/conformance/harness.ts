import { test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// Conformance tests that lopata is known to fail are listed in known-failures/<corpus>.json
// (`id → first line of the error`). They run as `test.failing`, so the suite stays green while
// a regression (a passing test that starts failing) or a fix (a known failure that starts
// passing) both fail it. `CONFORMANCE_RECORD=1` runs every case as a plain test so
// `scripts/conformance-report.ts` can measure the real pass rate and rewrite the lists.

export const RECORD_MODE = process.env.CONFORMANCE_RECORD === '1'

export function knownFailuresPath(corpus: string): string {
	return resolve(import.meta.dir, 'known-failures', `${corpus}.json`)
}

function parseKnownFailures(raw: unknown, path: string): Map<string, string> {
	if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error(`${path}: expected an object of id → reason`)
	const entries = new Map<string, string>()
	for (const [id, reason] of Object.entries(raw)) {
		if (typeof reason !== 'string') throw new Error(`${path}: reason for "${id}" must be a string`)
		entries.set(id, reason)
	}
	return entries
}

export function loadKnownFailures(corpus: string): Map<string, string> {
	const path = knownFailuresPath(corpus)
	let text: string
	try {
		text = readFileSync(path, 'utf8')
	} catch {
		return new Map()
	}
	return parseKnownFailures(JSON.parse(text), path)
}

/** Registers one conformance case. `id` is unique within the corpus and is the key in its known-failures file. */
export function conformanceTest(known: Map<string, string>, id: string, fn: () => Promise<void> | void, timeout?: number): void {
	if (!RECORD_MODE && known.has(id)) {
		test.failing(id, fn, timeout)
		return
	}
	test(id, fn, timeout)
}
