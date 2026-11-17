import type { Subprocess } from 'bun'
import { Database } from 'bun:sqlite'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { runMigrations } from '../src/db'

/**
 * The main worker ("alpha") and an auxiliary worker ("beta") both declare a Durable Object class named Counter. Each
 * worker's data is stored apart: the main worker under the bare class name, which data stored before per-worker keys
 * also uses, and the auxiliary worker under `beta/Counter`.
 */

const FIXTURE_DIR = resolve(import.meta.dir, 'fixtures/same-class-do')
const DATA_DIR = join(FIXTURE_DIR, '.lopata')
const CLI_PATH = resolve(import.meta.dir, '../src/cli.ts')
const PORT = 18883
const base = `http://localhost:${PORT}`

async function waitForServer(url: string, timeoutMs: number): Promise<void> {
	const deadline = Date.now() + timeoutMs
	while (Date.now() < deadline) {
		try {
			await fetch(url)
			return
		} catch {
			await new Promise(r => setTimeout(r, 200))
		}
	}
	throw new Error(`Server ${url} did not become ready in ${timeoutMs}ms`)
}

async function getJson(path: string): Promise<unknown> {
	const res = await fetch(`${base}${path}`)
	if (res.status !== 200) throw new Error(`GET ${path} returned ${res.status}: ${await res.text()}`)
	return res.json()
}

async function dashboardRpc(procedure: string, input: unknown): Promise<unknown> {
	const res = await fetch(`${base}/__api/rpc`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ procedure, input }),
	})
	return res.json()
}

function cleanup() {
	rmSync(DATA_DIR, { recursive: true, force: true })
}

/** Data as an earlier lopata, which stored every worker's classes under the bare class name, left it. */
function seedLegacyData() {
	mkdirSync(join(DATA_DIR, 'do-sql', 'Solo'), { recursive: true })
	writeFileSync(join(DATA_DIR, 'do-sql', 'Solo', 'solo-id.sqlite'), '')
	const db = new Database(join(DATA_DIR, 'data.sqlite'), { create: true })
	runMigrations(db)
	const insert = db.prepare(`INSERT INTO do_storage (namespace, id, key, value) VALUES (?, ?, 'k', '1')`)
	insert.run('OldCounter', 'old-id')
	insert.run('Solo', 'solo-id')
	db.close()
}

function storedNamespaces(): Record<string, string> {
	const db = new Database(join(DATA_DIR, 'data.sqlite'), { readonly: true })
	try {
		const rows = db.query<{ id: string; namespace: string }, []>(`SELECT id, namespace FROM do_storage WHERE key = 'k'`).all()
		return Object.fromEntries(rows.map(row => [row.id, row.namespace]))
	} finally {
		db.close()
	}
}

function migrationTags(): string[] {
	const db = new Database(join(DATA_DIR, 'data.sqlite'), { readonly: true })
	try {
		return db.query<{ tag: string }, []>(`SELECT tag FROM do_migrations ORDER BY tag`).all().map(row => row.tag)
	} finally {
		db.close()
	}
}

describe('Durable Object classes with the same name in two workers', () => {
	let proc: Subprocess

	beforeAll(async () => {
		cleanup()
		seedLegacyData()
		proc = Bun.spawn(['bun', CLI_PATH, 'dev', '--port', String(PORT)], {
			cwd: FIXTURE_DIR,
			stdout: 'pipe',
			stderr: 'pipe',
		})
		await waitForServer(`${base}/__api/rpc`, 20_000)
	}, 25_000)

	afterAll(() => {
		proc?.kill()
		cleanup()
	})

	test('each worker counts in its own instance', async () => {
		expect(await getJson('/inc')).toBe(1)
		expect(await getJson('/inc')).toBe(2)
		expect(await getJson('/beta/inc')).toBe(1)
		expect(await getJson('/inc')).toBe(3)
		expect(await getJson('/beta/inc')).toBe(2)
	})

	test('each worker keeps its SQL storage in its own directory', () => {
		const databases = (...dir: string[]) => readdirSync(join(DATA_DIR, 'do-sql', ...dir)).filter(file => file.endsWith('.sqlite'))
		expect(databases('Counter')).toHaveLength(1)
		expect(databases('beta', 'Counter')).toEqual(databases('Counter'))
	})

	test('the main worker keeps data stored under the bare class name; each worker applies its own migrations', () => {
		expect(storedNamespaces()).toMatchObject({ 'old-id': 'Counter' })
		expect(migrationTags()).toEqual(['beta/v1', 'beta/v2', 'v1', 'v2'])
	})

	test('data of a class only an auxiliary worker hosts moves to that worker', () => {
		expect(storedNamespaces()).toMatchObject({ 'solo-id': 'beta/Solo' })
		expect(existsSync(join(DATA_DIR, 'do-sql', 'Solo'))).toBe(false)
		expect(existsSync(join(DATA_DIR, 'do-sql', 'beta', 'Solo', 'solo-id.sqlite'))).toBe(true)
	})

	test("the dashboard lists and opens each worker's namespace by its storage key", async () => {
		expect(await dashboardRpc('do.listNamespaces', {})).toEqual([
			{ namespace: 'beta/Counter', count: 1 },
			{ namespace: 'beta/Solo', count: 0 },
			{ namespace: 'Counter', count: 1 },
		])
		expect(await dashboardRpc('do.listInstances', { ns: 'beta/Counter' })).toMatchObject([{ key_count: 1 }])
		const workers = await dashboardRpc('workers.list', {})
		expect(workers).toMatchObject([
			{ name: 'alpha', bindings: [{ name: 'COUNTER', href: '#/do/Counter' }] },
			{ name: 'beta', bindings: [{ name: 'COUNTER', href: '#/do/beta%2FCounter' }, { name: 'SOLO', href: '#/do/beta%2FSolo' }] },
		])
	})
})
