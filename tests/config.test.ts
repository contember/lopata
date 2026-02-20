import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse as parseTOML } from 'smol-toml'
import { autoLoadConfig, loadConfig } from '../src/config'

describe('loadConfig', () => {
	test('parses valid wrangler.jsonc', async () => {
		const path = join(tmpdir(), `test-config-${Date.now()}.jsonc`)
		await Bun.write(
			path,
			`{
  // This is a comment
  "name": "test-worker",
  "main": "src/index.ts",
  "kv_namespaces": [
    { "binding": "KV", "id": "abc" }
  ],
  "r2_buckets": [
    { "binding": "R2", "bucket_name": "my-bucket" }
  ],
  "durable_objects": {
    "bindings": [
      { "name": "DO", "class_name": "MyDO" }
    ]
  },
  "workflows": [
    { "name": "wf", "binding": "WF", "class_name": "MyWF" }
  ]
}`,
		)

		const config = await loadConfig(path)
		expect(config.name).toBe('test-worker')
		expect(config.main).toBe('src/index.ts')
		expect(config.kv_namespaces!).toHaveLength(1)
		expect(config.kv_namespaces![0]!.binding).toBe('KV')
		expect(config.r2_buckets!).toHaveLength(1)
		expect(config.r2_buckets![0]!.bucket_name).toBe('my-bucket')
		expect(config.durable_objects!.bindings).toHaveLength(1)
		expect(config.durable_objects!.bindings[0]!.class_name).toBe('MyDO')
		expect(config.workflows!).toHaveLength(1)
		expect(config.workflows![0]!.class_name).toBe('MyWF')
	})

	test('handles config without optional fields', async () => {
		const path = join(tmpdir(), `test-config-minimal-${Date.now()}.jsonc`)
		await Bun.write(path, `{ "name": "minimal", "main": "index.ts" }`)

		const config = await loadConfig(path)
		expect(config.name).toBe('minimal')
		expect(config.kv_namespaces).toBeUndefined()
		expect(config.r2_buckets).toBeUndefined()
		expect(config.durable_objects).toBeUndefined()
		expect(config.workflows).toBeUndefined()
	})

	test('strips single-line comments', async () => {
		const path = join(tmpdir(), `test-config-comments-${Date.now()}.jsonc`)
		await Bun.write(
			path,
			`{
  // comment at start
  "name": "commented", // inline comment
  "main": "src/index.ts"
  // trailing comment
}`,
		)

		const config = await loadConfig(path)
		expect(config.name).toBe('commented')
	})
})

describe('parseTOML', () => {
	test('parses basic key-value pairs', () => {
		const result = parseTOML('name = "my-worker"\nmain = "src/index.ts"')
		expect(result.name).toBe('my-worker')
		expect(result.main).toBe('src/index.ts')
	})

	test('parses numbers', () => {
		const result = parseTOML('port = 8787\npi = 3.14')
		expect(result.port).toBe(8787)
		expect(result.pi).toBe(3.14)
	})

	test('parses booleans', () => {
		const result = parseTOML('enabled = true\ndisabled = false')
		expect(result.enabled).toBe(true)
		expect(result.disabled).toBe(false)
	})

	test('parses inline arrays', () => {
		const result = parseTOML('flags = ["flag1", "flag2"]')
		expect(result.flags).toEqual(['flag1', 'flag2'])
	})

	test('parses tables', () => {
		const result = parseTOML('[assets]\ndirectory = "./public"\nbinding = "ASSETS"')
		expect((result.assets as Record<string, unknown>).directory).toBe('./public')
		expect((result.assets as Record<string, unknown>).binding).toBe('ASSETS')
	})

	test('parses nested tables', () => {
		const result = parseTOML('[durable_objects]\n\n[durable_objects.bindings]\nname = "DO"')
		const doObj = result.durable_objects as Record<string, unknown>
		const bindings = doObj.bindings as Record<string, unknown>
		expect(bindings.name).toBe('DO')
	})

	test('parses array of tables', () => {
		const result = parseTOML(
			'[[kv_namespaces]]\nbinding = "KV"\nid = "abc"\n\n[[kv_namespaces]]\nbinding = "KV2"\nid = "def"',
		)
		const kv = result.kv_namespaces as { binding: string; id: string }[]
		expect(kv).toHaveLength(2)
		expect(kv[0]!.binding).toBe('KV')
		expect(kv[1]!.binding).toBe('KV2')
	})

	test('parses inline tables', () => {
		const result = parseTOML('images = { binding = "IMG" }')
		expect((result.images as Record<string, unknown>).binding).toBe('IMG')
	})

	test('ignores comments', () => {
		const result = parseTOML('# this is a comment\nname = "test" # inline comment')
		expect(result.name).toBe('test')
	})

	test('ignores empty lines', () => {
		const result = parseTOML('\n\nname = "test"\n\nmain = "index.ts"\n\n')
		expect(result.name).toBe('test')
		expect(result.main).toBe('index.ts')
	})

	test('parses literal strings', () => {
		const result = parseTOML("path = 'C:\\Users\\test'")
		expect(result.path).toBe('C:\\Users\\test')
	})

	test('handles escaped strings', () => {
		const result = parseTOML('msg = "hello\\nworld"')
		expect(result.msg).toBe('hello\nworld')
	})
})

describe('loadConfig with TOML', () => {
	test('loads wrangler.toml file', async () => {
		const path = join(tmpdir(), `test-config-${Date.now()}.toml`)
		await Bun.write(
			path,
			`name = "toml-worker"
main = "src/index.ts"
compatibility_date = "2025-01-01"
compatibility_flags = ["nodejs_compat_v2"]

[[kv_namespaces]]
binding = "KV"
id = "abc123"

[assets]
directory = "./public"
`,
		)

		const config = await loadConfig(path)
		expect(config.name).toBe('toml-worker')
		expect(config.main).toBe('src/index.ts')
		expect(config.compatibility_date).toBe('2025-01-01')
		expect(config.compatibility_flags).toEqual(['nodejs_compat_v2'])
		expect(config.kv_namespaces!).toHaveLength(1)
		expect(config.kv_namespaces![0]!.binding).toBe('KV')
		expect((config.assets as Record<string, unknown>)!.directory).toBe('./public')
	})
})

describe('autoLoadConfig', () => {
	test('auto-detects wrangler.jsonc', async () => {
		const tmpDir = mkdtempSync(join(tmpdir(), 'lopata-autoload-'))
		writeFileSync(join(tmpDir, 'wrangler.jsonc'), '{ "name": "jsonc-worker", "main": "index.ts" }')

		const config = await autoLoadConfig(tmpDir)
		expect(config.name).toBe('jsonc-worker')
		rmSync(tmpDir, { recursive: true })
	})

	test('auto-detects wrangler.json when no .jsonc', async () => {
		const tmpDir = mkdtempSync(join(tmpdir(), 'lopata-autoload-'))
		writeFileSync(join(tmpDir, 'wrangler.json'), '{ "name": "json-worker", "main": "index.ts" }')

		const config = await autoLoadConfig(tmpDir)
		expect(config.name).toBe('json-worker')
		rmSync(tmpDir, { recursive: true })
	})

	test('auto-detects wrangler.toml when no JSON files', async () => {
		const tmpDir = mkdtempSync(join(tmpdir(), 'lopata-autoload-'))
		writeFileSync(join(tmpDir, 'wrangler.toml'), 'name = "toml-worker"\nmain = "index.ts"')

		const config = await autoLoadConfig(tmpDir)
		expect(config.name).toBe('toml-worker')
		rmSync(tmpDir, { recursive: true })
	})

	test('prefers wrangler.jsonc over wrangler.toml', async () => {
		const tmpDir = mkdtempSync(join(tmpdir(), 'lopata-autoload-'))
		writeFileSync(join(tmpDir, 'wrangler.jsonc'), '{ "name": "jsonc-wins", "main": "index.ts" }')
		writeFileSync(join(tmpDir, 'wrangler.toml'), 'name = "toml-loses"\nmain = "index.ts"')

		const config = await autoLoadConfig(tmpDir)
		expect(config.name).toBe('jsonc-wins')
		rmSync(tmpDir, { recursive: true })
	})

	test('throws when no config found', async () => {
		const tmpDir = mkdtempSync(join(tmpdir(), 'lopata-autoload-'))
		expect(autoLoadConfig(tmpDir)).rejects.toThrow('No wrangler config found')
		rmSync(tmpDir, { recursive: true })
	})
})

describe('environment-specific config', () => {
	test('applies env overrides from JSON config', async () => {
		const path = join(tmpdir(), `test-config-env-${Date.now()}.json`)
		await Bun.write(
			path,
			JSON.stringify({
				name: 'my-worker',
				main: 'src/index.ts',
				vars: { API_URL: 'https://api.example.com', MODE: 'development' },
				env: {
					production: {
						vars: { API_URL: 'https://api.prod.com', MODE: 'production' },
					},
					staging: {
						vars: { API_URL: 'https://api.staging.com' },
					},
				},
			}),
		)

		const prodConfig = await loadConfig(path, 'production')
		expect(prodConfig.vars!.API_URL).toBe('https://api.prod.com')
		expect(prodConfig.vars!.MODE).toBe('production')
		expect(prodConfig.name).toBe('my-worker')
		// env section should be stripped
		expect(prodConfig.env).toBeUndefined()

		const stagingConfig = await loadConfig(path, 'staging')
		expect(stagingConfig.vars!.API_URL).toBe('https://api.staging.com')
	})

	test('returns base config when no envName specified', async () => {
		const path = join(tmpdir(), `test-config-env2-${Date.now()}.json`)
		await Bun.write(
			path,
			JSON.stringify({
				name: 'my-worker',
				main: 'src/index.ts',
				vars: { MODE: 'dev' },
				env: { production: { vars: { MODE: 'prod' } } },
			}),
		)

		const config = await loadConfig(path)
		expect(config.vars!.MODE).toBe('dev')
	})

	test('throws for unknown environment', async () => {
		const path = join(tmpdir(), `test-config-env3-${Date.now()}.json`)
		await Bun.write(
			path,
			JSON.stringify({
				name: 'my-worker',
				main: 'src/index.ts',
				env: { production: {} },
			}),
		)

		expect(loadConfig(path, 'nonexistent')).rejects.toThrow('Environment "nonexistent" not found')
	})

	test('env overrides bindings', async () => {
		const path = join(tmpdir(), `test-config-env4-${Date.now()}.json`)
		await Bun.write(
			path,
			JSON.stringify({
				name: 'my-worker',
				main: 'src/index.ts',
				kv_namespaces: [{ binding: 'KV', id: 'dev-id' }],
				env: {
					production: {
						kv_namespaces: [{ binding: 'KV', id: 'prod-id' }],
					},
				},
			}),
		)

		const config = await loadConfig(path, 'production')
		expect(config.kv_namespaces![0]!.id).toBe('prod-id')
	})

	test('env-specific config from TOML', async () => {
		const path = join(tmpdir(), `test-config-env-${Date.now()}.toml`)
		await Bun.write(
			path,
			`name = "my-worker"
main = "src/index.ts"

[vars]
MODE = "dev"

[env.production.vars]
MODE = "prod"
`,
		)

		const config = await loadConfig(path, 'production')
		expect(config.vars!.MODE).toBe('prod')
	})
})

describe('compatibility fields', () => {
	test('parses compatibility_date and compatibility_flags from JSON', async () => {
		const path = join(tmpdir(), `test-compat-${Date.now()}.json`)
		await Bun.write(
			path,
			JSON.stringify({
				name: 'my-worker',
				main: 'src/index.ts',
				compatibility_date: '2025-03-01',
				compatibility_flags: ['nodejs_compat_v2', 'some_flag'],
			}),
		)

		const config = await loadConfig(path)
		expect(config.compatibility_date).toBe('2025-03-01')
		expect(config.compatibility_flags).toEqual(['nodejs_compat_v2', 'some_flag'])
	})

	test('parses compatibility fields from TOML', async () => {
		const path = join(tmpdir(), `test-compat-${Date.now()}.toml`)
		await Bun.write(
			path,
			`name = "my-worker"
main = "src/index.ts"
compatibility_date = "2025-03-01"
compatibility_flags = ["nodejs_compat_v2"]
`,
		)

		const config = await loadConfig(path)
		expect(config.compatibility_date).toBe('2025-03-01')
		expect(config.compatibility_flags).toEqual(['nodejs_compat_v2'])
	})
})
