import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { loadLopataConfig } from '../src/lopata-config'

describe('loadLopataConfig', () => {
	let baseDir: string

	beforeEach(() => {
		baseDir = mkdtempSync(join(tmpdir(), 'lopata-config-'))
	})

	afterEach(() => {
		rmSync(baseDir, { recursive: true, force: true })
	})

	test('returns null when no lopata.config.ts is present', async () => {
		expect(await loadLopataConfig(baseDir)).toBeNull()
	})

	test('resolves main path against baseDir', async () => {
		writeFileSync(
			join(baseDir, 'lopata.config.ts'),
			`export default { main: './wrangler.jsonc' }\n`,
		)
		const config = await loadLopataConfig(baseDir)
		expect(config?.main).toBe(resolve(baseDir, 'wrangler.jsonc'))
	})

	test('resolves watchExtra paths against baseDir', async () => {
		writeFileSync(
			join(baseDir, 'lopata.config.ts'),
			`export default {
				main: './wrangler.jsonc',
				watchExtra: ['packages/lib/src', './packages/shared'],
			}\n`,
		)
		const config = await loadLopataConfig(baseDir)
		expect(config?.watchExtra).toEqual([
			resolve(baseDir, 'packages/lib/src'),
			resolve(baseDir, 'packages/shared'),
		])
	})

	test('leaves watchExtra undefined when not configured', async () => {
		writeFileSync(
			join(baseDir, 'lopata.config.ts'),
			`export default { main: './wrangler.jsonc' }\n`,
		)
		const config = await loadLopataConfig(baseDir)
		expect(config?.watchExtra).toBeUndefined()
	})

	test('resolves auxiliary worker config paths against baseDir', async () => {
		writeFileSync(
			join(baseDir, 'lopata.config.ts'),
			`export default {
				main: './wrangler.jsonc',
				workers: [{ name: 'api', config: './workers/api/wrangler.jsonc' }],
			}\n`,
		)
		const config = await loadLopataConfig(baseDir)
		expect(config?.workers?.[0]?.config).toBe(resolve(baseDir, 'workers/api/wrangler.jsonc'))
	})
})
