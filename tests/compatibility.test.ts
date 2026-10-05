import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type CompatibilitySelection, parseCompatibility, resolveCompatibility } from '../src/compatibility'
import { loadConfig } from '../src/config'

interface DatedCase {
	key: 'deleteAllDeletesAlarm' | 'websocketCloseReasonByteLimit' | 'websocketStandardBinaryType' | 'websocketAutoReplyToClose'
	enable: string
	disable: string
	before: string
	date: string
}

const datedCases: DatedCase[] = [
	{
		key: 'deleteAllDeletesAlarm',
		enable: 'delete_all_deletes_alarm',
		disable: 'delete_all_preserves_alarm',
		before: '2026-02-23',
		date: '2026-02-24',
	},
	{
		key: 'websocketCloseReasonByteLimit',
		enable: 'websocket_close_reason_byte_limit',
		disable: 'no_websocket_close_reason_byte_limit',
		before: '2026-03-02',
		date: '2026-03-03',
	},
	{
		key: 'websocketStandardBinaryType',
		enable: 'websocket_standard_binary_type',
		disable: 'no_websocket_standard_binary_type',
		before: '2026-03-16',
		date: '2026-03-17',
	},
	{
		key: 'websocketAutoReplyToClose',
		enable: 'web_socket_auto_reply_to_close',
		disable: 'web_socket_manual_reply_to_close',
		before: '2026-04-06',
		date: '2026-04-07',
	},
]

describe('compatibility selection', () => {
	for (const rule of datedCases) {
		test(`${rule.key} selects its threshold and preserves no-date local behavior`, () => {
			expect(resolveCompatibility({})[rule.key]).toBe('legacy-local')
			expect(resolveCompatibility({ date: rule.before })[rule.key]).toBe('disabled')
			expect(resolveCompatibility({ date: rule.date })[rule.key]).toBe('enabled')
			expect(resolveCompatibility({ date: '2999-12-31' })[rule.key]).toBe('enabled')
		})

		test(`${rule.key} lets explicit flags override dates and no-date defaults`, () => {
			for (const date of [undefined, rule.before, rule.date, '2999-12-31']) {
				expect(resolveCompatibility({ date, flags: [rule.enable] })[rule.key]).toBe('enabled')
				expect(resolveCompatibility({ date, flags: [rule.disable] })[rule.key]).toBe('disabled')
			}
		})

		test(`${rule.key} rejects contradictory flags in either order`, () => {
			for (const flags of [[rule.enable, rule.disable], [rule.disable, rule.enable]]) {
				for (const date of [undefined, rule.before, rule.date]) {
					expect(() => parseCompatibility({ date, flags })).toThrow('Conflicting compatibility flags')
					expect(() => resolveCompatibility({ date, flags })).toThrow('Conflicting compatibility flags')
				}
			}
		})
	}

	test('crypto is always opt-in and has no invented disable flag', () => {
		for (const date of [undefined, '2000-01-01', '2026-10-05', '2999-12-31']) {
			expect(resolveCompatibility({ date }).modernCrypto).toBe(false)
			expect(resolveCompatibility({ date, flags: ['webcrypto_modern_algorithms'] }).modernCrypto).toBe(true)
			const selection = resolveCompatibility({ date, flags: ['no_webcrypto_modern_algorithms', 'webcrypto_modern_algorithms'] })
			expect(selection.modernCrypto).toBe(true)
			expect(selection.unimplementedFlags).toEqual(['no_webcrypto_modern_algorithms'])
		}
	})

	test('unimplemented flags are retained in order without inferred conflicts or Node selection', () => {
		const flags = ['nodejs_compat', 'no_nodejs_compat', 'nodejs_compat_v2', 'future_feature', 'no_future_feature']
		const selection = resolveCompatibility({ flags })
		expect(selection.flags).toEqual(flags)
		expect(selection.unimplementedFlags).toEqual(flags)
		expect(selection.date).toBeNull()
		expect(selection.modernCrypto).toBe(false)
		for (const { key } of datedCases) expect(selection[key]).toBe('legacy-local')
	})

	test('registered flags are separated from unimplemented input without dropping raw flags', () => {
		const flags = ['unknown', ...datedCases.map(rule => rule.disable), 'webcrypto_modern_algorithms']
		const selection = resolveCompatibility({ flags })
		expect(selection.flags).toEqual(flags)
		expect(selection.unimplementedFlags).toEqual(['unknown'])
	})

	test('parsing copies input and selection remains an immutable snapshot', () => {
		const flags = ['future_feature']
		const input = { date: '2026-02-23', flags }
		const parsed = parseCompatibility(input)
		const selection = resolveCompatibility(input)
		flags.push('delete_all_deletes_alarm')
		input.date = '2026-04-07'
		expect(parsed).toEqual({ date: '2026-02-23', flags: ['future_feature'] })
		expect(selection.date).toBe('2026-02-23')
		expect(selection.deleteAllDeletesAlarm).toBe('disabled')
		expect(selection.flags).toEqual(['future_feature'])
		expect(Reflect.set(selection, 'modernCrypto', true)).toBe(false)
		expect(Reflect.set(selection.flags, '0', 'webcrypto_modern_algorithms')).toBe(false)
		expect(Reflect.set(selection.unimplementedFlags, '0', 'changed')).toBe(false)
	})

	test('rejects malformed objects, dates, flag arrays and duplicates', () => {
		const invalid: unknown[] = [
			null,
			undefined,
			[],
			'2026-01-01',
			123,
			...[
				null,
				20260101,
				'',
				'1999-12-31',
				'3000-01-01',
				'2026-1-01',
				'2026-01-1',
				'2026-01-01\n',
				' 2026-01-01',
				'2026-01-01T00:00:00Z',
				'2026-00-01',
				'2026-13-01',
				'2026-01-00',
				'2026-01-32',
				'2026-02-29',
				'2026-02-30',
				'2100-02-29',
				'2026-04-31',
			].map(date => ({ date })),
			...[null, 'nodejs_compat', {}, [null], [1], [''], ['unknown', 'unknown'], ['webcrypto_modern_algorithms', 'webcrypto_modern_algorithms']]
				.map(flags => ({ flags })),
		]
		for (const input of invalid) expect(() => parseCompatibility(input)).toThrow(TypeError)
		expect(() => resolveCompatibility({ date: '2026-02-30' })).toThrow(TypeError)
		expect(() => resolveCompatibility({ flags: ['unknown', 'unknown'] })).toThrow(TypeError)
	})

	test('accepts Gregorian leap days and valid future dates independently of the clock', () => {
		for (const date of ['2000-02-29', '2024-02-29', '2400-02-29', '2999-12-31']) {
			expect(resolveCompatibility({ date }).date).toBe(date)
		}
	})
})

const dir = mkdtempSync(join(tmpdir(), 'compatibility-config-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('compatibility config boundary', () => {
	test('preserves absent fields, cache controls and mixed exports in JSONC', async () => {
		const path = join(dir, 'baseline.jsonc')
		await Bun.write(
			path,
			`{
			// No compatibility date means the local baseline.
			"name": "baseline", "cache": {"enabled": true},
			"exports": {"Room": {"type": "durable-object", "storage": "sqlite"}},
		}`,
		)
		const config = await loadConfig(path)
		expect(config).toEqual({ name: 'baseline', cache: { enabled: true }, exports: { Room: { type: 'durable-object', storage: 'sqlite' } } })
	})

	test('validates the effective JSON environment rather than an overridden invalid base', async () => {
		const path = join(dir, 'override.json')
		await Bun.write(
			path,
			JSON.stringify({
				name: 'override',
				compatibility_date: 123,
				compatibility_flags: false,
				env: { production: { compatibility_date: '2026-03-17', compatibility_flags: ['no_websocket_standard_binary_type', 'future_feature'] } },
			}),
		)
		await expect(loadConfig(path)).rejects.toThrow(TypeError)
		const config = await loadConfig(path, 'production')
		expect(config.compatibility_date).toBe('2026-03-17')
		expect(config.compatibility_flags).toEqual(['no_websocket_standard_binary_type', 'future_feature'])
	})

	test('applies TOML overrides before checking conflicts and selects the effective input', async () => {
		const path = join(dir, 'override.toml')
		await Bun.write(
			path,
			`name = "override"
compatibility_date = "2026-02-23"
compatibility_flags = ["delete_all_deletes_alarm", "delete_all_preserves_alarm"]
[env.production]
compatibility_date = "2026-02-24"
compatibility_flags = ["delete_all_preserves_alarm", "unknown"]
`,
		)
		await expect(loadConfig(path)).rejects.toThrow('Conflicting compatibility flags')
		const config = await loadConfig(path, 'production')
		const selection: CompatibilitySelection = resolveCompatibility({ date: config.compatibility_date, flags: config.compatibility_flags })
		expect(selection.deleteAllDeletesAlarm).toBe('disabled')
		expect(selection.unimplementedFlags).toEqual(['unknown'])
	})

	test('rejects wrong JSON shapes and invalid values at top level and in the selected environment', async () => {
		const invalid = [
			{ compatibility_date: null },
			{ compatibility_date: 20260101 },
			{ compatibility_date: [] },
			{ compatibility_date: '2026-02-30' },
			{ compatibility_flags: null },
			{ compatibility_flags: 'webcrypto_modern_algorithms' },
			{ compatibility_flags: {} },
			{ compatibility_flags: [true] },
			{ compatibility_flags: [''] },
			{ compatibility_flags: ['unknown', 'unknown'] },
			{ compatibility_flags: ['web_socket_auto_reply_to_close', 'web_socket_manual_reply_to_close'] },
		]
		for (const [index, fields] of invalid.entries()) {
			const path = join(dir, `invalid-${index}.json`)
			await Bun.write(path, JSON.stringify({ name: 'invalid', ...fields }))
			await expect(loadConfig(path)).rejects.toThrow(TypeError)
			await Bun.write(path, JSON.stringify({ name: 'invalid', env: { production: fields } }))
			await expect(loadConfig(path, 'production')).rejects.toThrow(TypeError)
		}
	})

	test('rejects wrong TOML shapes including unquoted native dates', async () => {
		const invalid = [
			'compatibility_date = 2026-03-17',
			'compatibility_date = 123',
			'compatibility_date = ["2026-03-17"]',
			'compatibility_flags = "nodejs_compat"',
			'compatibility_flags = [1]',
			'compatibility_flags = { enabled = true }',
			'compatibility_flags = ["unknown", "unknown"]',
		]
		for (const [index, fields] of invalid.entries()) {
			const path = join(dir, `invalid-${index}.toml`)
			await Bun.write(path, `name = "invalid"\n${fields}\n`)
			await expect(loadConfig(path)).rejects.toThrow(TypeError)
			await Bun.write(path, `name = "invalid"\n[env.production]\n${fields}\n`)
			await expect(loadConfig(path, 'production')).rejects.toThrow(TypeError)
		}
	})
})
