import { expect, test } from 'bun:test'
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

export function parseKnownFailures(raw: unknown, path: string): Map<string, string> {
	if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error(`${path}: expected an object of id → reason`)
	const entries = new Map<string, string>()
	for (const [id, reason] of Object.entries(raw)) {
		if (typeof reason !== 'string') throw new Error(`${path}: reason for "${id}" must be a string`)
		entries.set(id, reason)
	}
	return entries
}

export const STALE_CHECK_PREFIX = 'known-failures/'

const registered = new WeakMap<Map<string, string>, Set<string>>()

/**
 * Loads the corpus's known failures and registers a check that every listed id belongs to a registered case, so a renamed or
 * removed case cannot leave a dead entry behind. Skipped when only a subset runs (record mode, CONFORMANCE_ONLY).
 */
export function loadKnownFailures(corpus: string): Map<string, string> {
	const path = knownFailuresPath(corpus)
	let known = new Map<string, string>()
	try {
		known = parseKnownFailures(JSON.parse(readFileSync(path, 'utf8')), path)
	} catch (err) {
		if (!(err instanceof Error && 'code' in err && err.code === 'ENOENT')) throw err
	}
	const ids = new Set<string>()
	registered.set(known, ids)
	if (!RECORD_MODE && !process.env.CONFORMANCE_ONLY) {
		test(`${STALE_CHECK_PREFIX}${corpus}.json lists only registered cases`, () => {
			expect([...known.keys()].filter(id => !ids.has(id))).toEqual([])
		})
	}
	return known
}

/** Registers one conformance case. `id` is unique within the corpus and is the key in its known-failures file. */
export function conformanceTest(known: Map<string, string>, id: string, fn: () => Promise<void> | void, timeout?: number): void {
	const ids = registered.get(known)
	if (!ids) throw new Error('conformanceTest needs the map returned by loadKnownFailures()')
	if (ids.has(id)) throw new Error(`duplicate conformance case id: ${id}`)
	ids.add(id)
	if (!RECORD_MODE && known.has(id)) {
		test.failing(id, fn, timeout)
		return
	}
	test(id, fn, timeout)
}
