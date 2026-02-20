import { Database } from 'bun:sqlite'
import { beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runMigrations } from '../src/db'

/**
 * Helper to run DO migrations as env.ts does, but against a given DB + dataDir.
 */
function runDOMigrations(
	db: Database,
	dataDir: string,
	migrations: {
		tag: string
		renamed_classes?: { from: string; to: string }[]
		deleted_classes?: string[]
	}[],
) {
	const { existsSync: exists, renameSync, rmSync } = require('node:fs')
	const path = require('node:path')

	for (const migration of migrations) {
		const applied = db.query('SELECT 1 FROM do_migrations WHERE tag = ?').get(migration.tag)
		if (applied) continue

		for (const { from, to } of migration.renamed_classes ?? []) {
			db.run('UPDATE do_storage SET namespace = ? WHERE namespace = ?', [to, from])
			db.run('UPDATE do_alarms SET namespace = ? WHERE namespace = ?', [to, from])
			db.run('UPDATE do_instances SET namespace = ? WHERE namespace = ?', [to, from])
			const fromDir = path.join(dataDir, 'do-sql', from)
			const toDir = path.join(dataDir, 'do-sql', to)
			if (exists(fromDir)) {
				renameSync(fromDir, toDir)
			}
		}

		for (const className of migration.deleted_classes ?? []) {
			db.run('DELETE FROM do_storage WHERE namespace = ?', [className])
			db.run('DELETE FROM do_alarms WHERE namespace = ?', [className])
			db.run('DELETE FROM do_instances WHERE namespace = ?', [className])
			const classDir = path.join(dataDir, 'do-sql', className)
			if (exists(classDir)) {
				rmSync(classDir, { recursive: true })
			}
		}

		db.run('INSERT INTO do_migrations (tag) VALUES (?)', [migration.tag])
	}
}

describe('DO migrations', () => {
	let db: Database
	let dataDir: string

	beforeEach(() => {
		db = new Database(':memory:')
		runMigrations(db)
		dataDir = mkdtempSync(join(tmpdir(), 'lopata-do-mig-'))
	})

	test('renamed_classes preserves storage data', () => {
		// Seed data under old namespace
		db.run("INSERT INTO do_instances (namespace, id, name) VALUES ('OldClass', 'id1', 'test')")
		db.run("INSERT INTO do_storage (namespace, id, key, value) VALUES ('OldClass', 'id1', 'counter', '42')")
		db.run("INSERT INTO do_alarms (namespace, id, alarm_time) VALUES ('OldClass', 'id1', 1000)")

		runDOMigrations(db, dataDir, [
			{ tag: 'v1', renamed_classes: [{ from: 'OldClass', to: 'NewClass' }] },
		])

		// Old namespace should be empty
		const oldInstances = db.query('SELECT * FROM do_instances WHERE namespace = ?').all('OldClass')
		expect(oldInstances).toHaveLength(0)

		// New namespace should have the data
		const newInstances = db.query('SELECT * FROM do_instances WHERE namespace = ?').all('NewClass')
		expect(newInstances).toHaveLength(1)

		const storage = db.query('SELECT value FROM do_storage WHERE namespace = ? AND id = ? AND key = ?')
			.get('NewClass', 'id1', 'counter') as { value: string }
		expect(storage.value).toBe('42')

		const alarm = db.query('SELECT alarm_time FROM do_alarms WHERE namespace = ? AND id = ?')
			.get('NewClass', 'id1') as { alarm_time: number }
		expect(alarm.alarm_time).toBe(1000)
	})

	test('renamed_classes renames do-sql directory', () => {
		const fromDir = join(dataDir, 'do-sql', 'OldClass')
		mkdirSync(fromDir, { recursive: true })
		writeFileSync(join(fromDir, 'test.sqlite'), 'dummy')

		runDOMigrations(db, dataDir, [
			{ tag: 'v1', renamed_classes: [{ from: 'OldClass', to: 'NewClass' }] },
		])

		expect(existsSync(fromDir)).toBe(false)
		expect(existsSync(join(dataDir, 'do-sql', 'NewClass', 'test.sqlite'))).toBe(true)
	})

	test('deleted_classes clears all data', () => {
		db.run("INSERT INTO do_instances (namespace, id, name) VALUES ('DeadClass', 'id1', 'test')")
		db.run("INSERT INTO do_storage (namespace, id, key, value) VALUES ('DeadClass', 'id1', 'key', '\"val\"')")
		db.run("INSERT INTO do_alarms (namespace, id, alarm_time) VALUES ('DeadClass', 'id1', 2000)")

		const classDir = join(dataDir, 'do-sql', 'DeadClass')
		mkdirSync(classDir, { recursive: true })
		writeFileSync(join(classDir, 'id1.sqlite'), 'dummy')

		runDOMigrations(db, dataDir, [
			{ tag: 'v1', deleted_classes: ['DeadClass'] },
		])

		expect(db.query('SELECT * FROM do_instances WHERE namespace = ?').all('DeadClass')).toHaveLength(0)
		expect(db.query('SELECT * FROM do_storage WHERE namespace = ?').all('DeadClass')).toHaveLength(0)
		expect(db.query('SELECT * FROM do_alarms WHERE namespace = ?').all('DeadClass')).toHaveLength(0)
		expect(existsSync(classDir)).toBe(false)
	})

	test('migrations are idempotent — re-running skips applied tags', () => {
		db.run("INSERT INTO do_instances (namespace, id, name) VALUES ('ClassA', 'id1', 'test')")

		const migrations = [
			{ tag: 'v1', renamed_classes: [{ from: 'ClassA', to: 'ClassB' }] },
		]

		runDOMigrations(db, dataDir, migrations)

		// Seed data under ClassB to verify it's not wiped by re-run
		db.run("INSERT INTO do_storage (namespace, id, key, value) VALUES ('ClassB', 'id1', 'after', '\"yes\"')")

		// Run again — should skip
		runDOMigrations(db, dataDir, migrations)

		const storage = db.query('SELECT value FROM do_storage WHERE namespace = ? AND id = ? AND key = ?')
			.get('ClassB', 'id1', 'after') as { value: string }
		expect(storage.value).toBe('"yes"')
	})

	test('does not affect other namespaces', () => {
		db.run("INSERT INTO do_storage (namespace, id, key, value) VALUES ('KeepMe', 'id1', 'k', '\"v\"')")
		db.run("INSERT INTO do_storage (namespace, id, key, value) VALUES ('DeleteMe', 'id1', 'k', '\"v\"')")

		runDOMigrations(db, dataDir, [
			{ tag: 'v1', deleted_classes: ['DeleteMe'] },
		])

		const kept = db.query('SELECT * FROM do_storage WHERE namespace = ?').all('KeepMe')
		expect(kept).toHaveLength(1)
	})
})
