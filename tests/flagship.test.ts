import { Database } from 'bun:sqlite'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { deleteFlag, FlagshipBinding, setFlagValue } from '../src/bindings/flagship'
import { runMigrations } from '../src/db'

let db: Database
let flags: FlagshipBinding

beforeEach(() => {
	db = new Database(':memory:')
	runMigrations(db)
	flags = new FlagshipBinding(db, 'app-1')
})

afterEach(() => {
	db.close()
})

describe('FlagshipBinding', () => {
	test('missing flag returns defaultValue with reason DEFAULT', async () => {
		expect(await flags.getBooleanValue('missing', true)).toBe(true)
		expect(await flags.getBooleanValue('missing', false)).toBe(false)

		const details = await flags.getBooleanValueDetails('missing', false)
		expect(details.value).toBe(false)
		expect(details.reason).toBe('DEFAULT')
	})

	test('boolean flag returns stored value with reason STATIC', async () => {
		setFlagValue(db, 'app-1', 'new-ui', 'boolean', true)
		expect(await flags.getBooleanValue('new-ui', false)).toBe(true)

		const details = await flags.getBooleanValueDetails('new-ui', false)
		expect(details.reason).toBe('STATIC')
	})

	test('string flag evaluates as string', async () => {
		setFlagValue(db, 'app-1', 'variant', 'string', 'blue', 'blue-variant')
		const details = await flags.getStringValueDetails('variant', 'red')
		expect(details.value).toBe('blue')
		expect(details.variant).toBe('blue-variant')
	})

	test('number flag parses numeric value', async () => {
		setFlagValue(db, 'app-1', 'threshold', 'number', 42)
		expect(await flags.getNumberValue('threshold', 0)).toBe(42)
	})

	test('object flag parses JSON', async () => {
		setFlagValue(db, 'app-1', 'config', 'object', { foo: 'bar', n: 1 })
		const value = await flags.getObjectValue('config', {})
		expect(value).toEqual({ foo: 'bar', n: 1 })
	})

	test('type mismatch falls back to default with ERROR reason', async () => {
		setFlagValue(db, 'app-1', 'misc', 'string', 'hello')
		const details = await flags.getBooleanValueDetails('misc', false)
		expect(details.value).toBe(false)
		expect(details.reason).toBe('ERROR')
		expect(details.errorCode).toBe('TYPE_MISMATCH')
	})

	test('app isolation — flag in one app is not visible to another', async () => {
		setFlagValue(db, 'app-1', 'only-here', 'boolean', true)
		const other = new FlagshipBinding(db, 'app-2')
		expect(await other.getBooleanValue('only-here', false)).toBe(false)
	})

	test('setFlagValue upserts — second call overrides', async () => {
		setFlagValue(db, 'app-1', 'x', 'number', 1)
		setFlagValue(db, 'app-1', 'x', 'number', 99)
		expect(await flags.getNumberValue('x', 0)).toBe(99)
	})

	test('deleteFlag removes override and evaluation falls back', async () => {
		setFlagValue(db, 'app-1', 'gone', 'boolean', true)
		expect(await flags.getBooleanValue('gone', false)).toBe(true)
		deleteFlag(db, 'app-1', 'gone')
		expect(await flags.getBooleanValue('gone', false)).toBe(false)
	})
})
