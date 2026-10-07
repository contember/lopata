import { Database } from 'bun:sqlite'
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HyperdriveBinding } from '../src/bindings/hyperdrive'
import { addStatelessBindings } from '../src/bindings/stateless-env'
import type { WranglerConfig } from '../src/config'

const overrideKey = 'CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_F06C_TEST'
const originalOverride = process.env[overrideKey]

afterEach(() => {
	if (originalOverride === undefined) delete process.env[overrideKey]
	else process.env[overrideKey] = originalOverride
})

function build(connectionString?: string, vars: Record<string, unknown> = {}) {
	const db = new Database(':memory:')
	const config: WranglerConfig = {
		name: 'hyperdrive-test',
		hyperdrive: [{ binding: 'F06C_TEST', id: 'test', localConnectionString: connectionString }],
	}
	try {
		addStatelessBindings(vars, { config, db, dataDir: '/unused', baseDir: '/unused' })
		const binding = vars.F06C_TEST
		if (!(binding instanceof HyperdriveBinding)) throw new Error('Missing Hyperdrive binding')
		return { binding, env: vars, config }
	} finally {
		db.close()
	}
}

describe('Hyperdrive local override', () => {
	test.each([undefined, ''])('absent or empty override (%s) falls back to config', override => {
		if (override === undefined) delete process.env[overrideKey]
		else process.env[overrideKey] = override
		expect(build('postgres://u:p@config.example/db').binding.host).toBe('config.example')
		const missing = build().binding
		expect(missing.connectionString).toBe('')
		expect(() => missing.connect()).toThrow('no connection string configured')
	})

	test('host override wins without mutating config or becoming an application secret', () => {
		process.env[overrideKey] = 'mysql://u:p@override.example/db'
		const { binding, env, config } = build('invalid configured URL')
		expect(binding.host).toBe('override.example')
		expect(binding.port).toBe(3306)
		expect(env).not.toHaveProperty(overrideKey)
		expect(config.hyperdrive?.[0]?.localConnectionString).toBe('invalid configured URL')
		expect(build().binding.connectionString).toBe(process.env[overrideKey])
	})

	test('application vars do not supply the host override', () => {
		delete process.env[overrideKey]
		const { binding, env } = build('postgres://u:p@config.example/db', { [overrideKey]: 'mysql://u:p@app.example/db' })
		expect(binding.host).toBe('config.example')
		expect(env[overrideKey]).toBe('mysql://u:p@app.example/db')
	})

	test('non-empty invalid override fails rather than silently using config', () => {
		process.env[overrideKey] = 'not a URL'
		expect(() => build('postgres://u:p@config.example/db')).toThrow()
	})

	test.each([undefined, '', 'mysql://u:p@override.example/db'])('main, worker and DO agree with override %s', async override => {
		const tempDir = mkdtempSync(join(tmpdir(), 'lopata-hyperdrive-'))
		const env = { ...process.env }
		for (const name of ['PRIMARY', 'SECONDARY', 'MISSING']) delete env[`CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_${name}`]
		if (override !== undefined) env.CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_PRIMARY = override
		const proc = Bun.spawn([process.execPath, join(import.meta.dir, 'fixtures/hyperdrive-runner.ts')], {
			cwd: tempDir,
			env,
			stdout: 'pipe',
			stderr: 'pipe',
		})
		const timeout = setTimeout(() => proc.kill(), 15_000)
		try {
			const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
			expect(exitCode, stderr).toBe(0)
			const result = stdout.split('\n').find(line => line.startsWith('RESULT '))
			if (!result) throw new Error(`Missing result: ${stdout}\n${stderr}`)
			const expected = {
				bindings: {
					PRIMARY: {
						connectionString: override || 'postgres://u:p@config.example/db',
						port: override ? 3306 : 5432,
						host: override ? 'override.example' : 'config.example',
					},
					SECONDARY: { connectionString: 'mysql://u:p@secondary.example:3310/db', port: 3310, host: 'secondary.example' },
					MISSING: { connectionString: '', port: 5432, host: '' },
				},
				overrideExposed: false,
			}
			expect(JSON.parse(result.slice(7))).toEqual({ main: expected, worker: expected, durableObject: expected })
		} finally {
			clearTimeout(timeout)
			proc.kill()
			await proc.exited
			rmSync(tempDir, { recursive: true, force: true })
		}
	}, 20_000)
})
