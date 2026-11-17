import { Database } from 'bun:sqlite'
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { moveAuxiliaryDurableObjectData } from '../src/bindings/do-storage-key'
import type { WranglerConfig } from '../src/config'
import { runMigrations } from '../src/db'

let db: Database
let dataDir: string

beforeEach(() => {
	db = new Database(':memory:')
	runMigrations(db)
	dataDir = mkdtempSync(join(tmpdir(), 'do-storage-key-'))
})

afterEach(() => {
	db.close()
	rmSync(dataDir, { recursive: true, force: true })
})

function worker(name: string, classes: string[]): { name: string; config: WranglerConfig } {
	return {
		name,
		config: {
			name,
			main: 'index.ts',
			durable_objects: { bindings: classes.map(className => ({ name: className.toUpperCase(), class_name: className })) },
		},
	}
}

function store(namespace: string, id: string) {
	db.run(`INSERT INTO do_storage (namespace, id, key, value) VALUES (?, ?, 'k', '1')`, [namespace, id])
	db.run(`INSERT INTO do_instances (namespace, id) VALUES (?, ?)`, [namespace, id])
	mkdirSync(join(dataDir, 'do-sql', namespace), { recursive: true })
	writeFileSync(join(dataDir, 'do-sql', namespace, `${id}.sqlite`), '')
}

function namespaces(): string[] {
	return db.query<{ namespace: string }, []>(`SELECT DISTINCT namespace FROM do_storage ORDER BY namespace`).all().map(row => row.namespace)
}

test('data of a class only one auxiliary worker hosts moves to that worker, rows and SQL files together', () => {
	store('Solo', 'a')
	moveAuxiliaryDurableObjectData(db, dataDir, worker('main', ['Shared']).config, [worker('aux', ['Solo'])])
	expect(namespaces()).toEqual(['aux/Solo'])
	expect(db.query(`SELECT namespace FROM do_instances`).all()).toEqual([{ namespace: 'aux/Solo' }])
	expect(existsSync(join(dataDir, 'do-sql', 'aux', 'Solo', 'a.sqlite'))).toBe(true)
	expect(existsSync(join(dataDir, 'do-sql', 'Solo'))).toBe(false)
})

test('data of a class the main worker hosts stays with the main worker', () => {
	store('Shared', 'a')
	moveAuxiliaryDurableObjectData(db, dataDir, worker('main', ['Shared']).config, [worker('aux', ['Shared'])])
	expect(namespaces()).toEqual(['Shared'])
	expect(existsSync(join(dataDir, 'do-sql', 'Shared', 'a.sqlite'))).toBe(true)
})

test('data of a class two auxiliary workers host stays where it is', () => {
	store('Solo', 'a')
	moveAuxiliaryDurableObjectData(db, dataDir, worker('main', []).config, [worker('one', ['Solo']), worker('two', ['Solo'])])
	expect(namespaces()).toEqual(['Solo'])
	expect(existsSync(join(dataDir, 'do-sql', 'Solo', 'a.sqlite'))).toBe(true)
})

test('nothing is moved onto data the auxiliary worker already stored under its own key', () => {
	store('Solo', 'old')
	store('aux/Solo', 'new')
	moveAuxiliaryDurableObjectData(db, dataDir, worker('main', []).config, [worker('aux', ['Solo'])])
	expect(namespaces()).toEqual(['Solo', 'aux/Solo'])
	expect(existsSync(join(dataDir, 'do-sql', 'Solo', 'old.sqlite'))).toBe(true)
	expect(existsSync(join(dataDir, 'do-sql', 'aux', 'Solo', 'old.sqlite'))).toBe(false)
})
