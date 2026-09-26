import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildEnv, parseDevVars } from '../src/env'

describe('parseDevVars', () => {
	test('parses simple KEY=VALUE pairs', () => {
		const result = parseDevVars('FOO=bar\nBAZ=qux')
		expect(result).toEqual({ FOO: 'bar', BAZ: 'qux' })
	})

	test('ignores comments and empty lines', () => {
		const result = parseDevVars('# comment\n\nFOO=bar\n  # another comment\nBAZ=qux\n')
		expect(result).toEqual({ FOO: 'bar', BAZ: 'qux' })
	})

	test('strips double quotes from values', () => {
		const result = parseDevVars('SECRET="my secret value"')
		expect(result).toEqual({ SECRET: 'my secret value' })
	})

	test('strips single quotes from values', () => {
		const result = parseDevVars("SECRET='my secret value'")
		expect(result).toEqual({ SECRET: 'my secret value' })
	})

	test('handles values with equals signs', () => {
		const result = parseDevVars('URL=https://example.com?a=1&b=2')
		expect(result).toEqual({ URL: 'https://example.com?a=1&b=2' })
	})

	test('trims whitespace around keys and values', () => {
		const result = parseDevVars('  FOO  =  bar  ')
		expect(result).toEqual({ FOO: 'bar' })
	})

	test('ignores lines without equals sign', () => {
		const result = parseDevVars('INVALID_LINE\nFOO=bar')
		expect(result).toEqual({ FOO: 'bar' })
	})

	test('returns empty object for empty input', () => {
		expect(parseDevVars('')).toEqual({})
		expect(parseDevVars('  \n  \n')).toEqual({})
	})
})

describe('buildEnv - environment variables', () => {
	test('injects vars from config into env', () => {
		const { env } = buildEnv({
			name: 'test',
			main: 'index.ts',
			vars: { API_HOST: 'https://api.example.com', ENVIRONMENT: 'development' },
		})
		expect(env.API_HOST).toBe('https://api.example.com')
		expect(env.ENVIRONMENT).toBe('development')
	})

	test('works with no vars in config', () => {
		const { env } = buildEnv({ name: 'test', main: 'index.ts' })
		// Should not throw, env should still be a valid object
		expect(env).toBeDefined()
	})

	test('reads .dev.vars file and merges into env', () => {
		const tmpDir = mkdtempSync(join(tmpdir(), 'lopata-test-'))
		writeFileSync(join(tmpDir, '.dev.vars'), 'SECRET_KEY=supersecret\nDB_URL=postgres://localhost/test')

		const { env } = buildEnv({ name: 'test', main: 'index.ts' }, tmpDir)
		expect(env.SECRET_KEY).toBe('supersecret')
		expect(env.DB_URL).toBe('postgres://localhost/test')

		rmSync(tmpDir, { recursive: true })
	})

	test('.dev.vars overrides vars from config', () => {
		const tmpDir = mkdtempSync(join(tmpdir(), 'lopata-test-'))
		writeFileSync(join(tmpDir, '.dev.vars'), 'API_HOST=http://localhost:3000')

		const { env } = buildEnv(
			{
				name: 'test',
				main: 'index.ts',
				vars: { API_HOST: 'https://api.example.com', KEEP_ME: 'yes' },
			},
			tmpDir,
		)
		expect(env.API_HOST).toBe('http://localhost:3000')
		expect(env.KEEP_ME).toBe('yes')

		rmSync(tmpDir, { recursive: true })
	})

	test('handles non-existent .dev.vars gracefully', () => {
		const tmpDir = mkdtempSync(join(tmpdir(), 'lopata-test-'))
		const { env } = buildEnv(
			{
				name: 'test',
				main: 'index.ts',
				vars: { FOO: 'bar' },
			},
			tmpDir,
		)
		expect(env.FOO).toBe('bar')
		rmSync(tmpDir, { recursive: true })
	})

	test('reads .env file when .dev.vars does not exist', () => {
		const tmpDir = mkdtempSync(join(tmpdir(), 'lopata-test-'))
		writeFileSync(join(tmpDir, '.env'), 'FROM_ENV=yes\nDB=postgres')

		const { env } = buildEnv({ name: 'test', main: 'index.ts' }, tmpDir)
		expect(env.FROM_ENV).toBe('yes')
		expect(env.DB).toBe('postgres')

		rmSync(tmpDir, { recursive: true })
	})

	test('.dev.vars takes priority over .env', () => {
		const tmpDir = mkdtempSync(join(tmpdir(), 'lopata-test-'))
		writeFileSync(join(tmpDir, '.dev.vars'), 'KEY=from-dev-vars')
		writeFileSync(join(tmpDir, '.env'), 'KEY=from-env')

		const { env } = buildEnv({ name: 'test', main: 'index.ts' }, tmpDir)
		expect(env.KEY).toBe('from-dev-vars')

		rmSync(tmpDir, { recursive: true })
	})
})

describe('buildEnv - process.env', () => {
	const touched: string[] = []
	const setEnv = (key: string, value: string) => {
		touched.push(key)
		process.env[key] = value
	}

	afterEach(() => {
		for (const key of touched.splice(0)) delete process.env[key]
	})

	test('overrides a var declared in config', () => {
		setEnv('API_HOST', 'http://from-process')

		const { env } = buildEnv({ name: 'test', main: 'index.ts', vars: { API_HOST: 'https://api.example.com' } })
		expect(env.API_HOST).toBe('http://from-process')
	})

	test('wins over .dev.vars', () => {
		const tmpDir = mkdtempSync(join(tmpdir(), 'lopata-test-'))
		writeFileSync(join(tmpDir, '.dev.vars'), 'KEY=from-dev-vars')
		setEnv('KEY', 'from-process')

		const { env } = buildEnv({ name: 'test', main: 'index.ts' }, tmpDir)
		expect(env.KEY).toBe('from-process')

		rmSync(tmpDir, { recursive: true })
	})

	test('picks up a name that only .dev.vars declares', () => {
		const tmpDir = mkdtempSync(join(tmpdir(), 'lopata-test-'))
		writeFileSync(join(tmpDir, '.dev.vars'), 'SECRET_KEY=placeholder')
		setEnv('SECRET_KEY', 'real-secret')

		const { env } = buildEnv({ name: 'test', main: 'index.ts' }, tmpDir)
		expect(env.SECRET_KEY).toBe('real-secret')

		rmSync(tmpDir, { recursive: true })
	})

	test('ignores host variables the worker does not declare', () => {
		setEnv('HOME_GROWN_HOST_VAR', 'leaked')

		const { env } = buildEnv({ name: 'test', main: 'index.ts', vars: { API_HOST: 'https://api.example.com' } })
		expect(env.HOME_GROWN_HOST_VAR).toBeUndefined()
	})

	test('a value Bun autoloaded from .env does not beat .dev.vars', () => {
		const tmpDir = mkdtempSync(join(tmpdir(), 'lopata-test-'))
		writeFileSync(join(tmpDir, '.dev.vars'), 'API_KEY=dev-secret')
		writeFileSync(join(tmpDir, '.env'), 'API_KEY=from-dotenv')
		// What Bun does at startup when .env sits in the working directory
		setEnv('API_KEY', 'from-dotenv')
		const cwd = process.cwd()
		process.chdir(tmpDir)
		try {
			const { env } = buildEnv({ name: 'test', main: 'index.ts' }, tmpDir)
			expect(env.API_KEY).toBe('dev-secret')
		} finally {
			process.chdir(cwd)
			rmSync(tmpDir, { recursive: true })
		}
	})

	test('a shell value still beats .dev.vars when .env has a different one', () => {
		const tmpDir = mkdtempSync(join(tmpdir(), 'lopata-test-'))
		writeFileSync(join(tmpDir, '.dev.vars'), 'API_KEY=dev-secret')
		writeFileSync(join(tmpDir, '.env'), 'API_KEY=from-dotenv')
		setEnv('API_KEY', 'from-shell')
		const cwd = process.cwd()
		process.chdir(tmpDir)
		try {
			const { env } = buildEnv({ name: 'test', main: 'index.ts' }, tmpDir)
			expect(env.API_KEY).toBe('from-shell')
		} finally {
			process.chdir(cwd)
			rmSync(tmpDir, { recursive: true })
		}
	})

	test('an empty process.env value still overrides', () => {
		setEnv('API_HOST', '')

		const { env } = buildEnv({ name: 'test', main: 'index.ts', vars: { API_HOST: 'https://api.example.com' } })
		expect(env.API_HOST).toBe('')
	})
})
