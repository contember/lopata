import { Database } from 'bun:sqlite'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CrossScriptDurableObjectNamespace } from '../src/bindings/cross-script-durable-object'
import { buildWorkerEnv } from '../src/bindings/do-worker-env'
import { DurableObjectNamespaceImpl } from '../src/bindings/durable-object'
import type { WranglerConfig } from '../src/config'
import { runMigrations } from '../src/db'
import type { DOMainMessage } from '../src/worker-thread/do-protocol'
import type { WorkerMessage } from '../src/worker-thread/protocol'
import { RpcClient } from '../src/worker-thread/rpc-shared'
import { buildThreadEnv } from '../src/worker-thread/thread-env'
import { WsGuestBridge } from '../src/worker-thread/ws-bridge-shared'

interface IdLike {
	toString(): string
	name?: string
}

interface IdFactory {
	idFromString(id: string): IdLike
	idFromName(name: string): IdLike
	newUniqueId(): IdLike
}

function guestBridge<T>(): WsGuestBridge<T> {
	return new WsGuestBridge<T>(() => {}, {
		remoteMessage: () => {
			throw new Error('unused')
		},
		remoteClose: () => {
			throw new Error('unused')
		},
	})
}

function idFactory(value: unknown): IdFactory {
	if (typeof value !== 'object' || value === null) throw new Error('Missing namespace binding')
	const pick = (key: string) => {
		const fn: unknown = Reflect.get(value, key)
		if (typeof fn !== 'function') throw new Error(`Missing ${key}`)
		return (...args: unknown[]): IdLike => Reflect.apply(fn, value, args)
	}
	return { idFromString: pick('idFromString'), idFromName: pick('idFromName'), newUniqueId: pick('newUniqueId') }
}

let tempDir: string
const namespaces = new Map<string, IdFactory>()

beforeAll(() => {
	tempDir = mkdtempSync(join(tmpdir(), 'lopata-do-id-'))
	const db = new Database(':memory:')
	runMigrations(db)
	const config = { durable_objects: { bindings: [{ name: 'OTHER', class_name: 'OtherDO' }] } } as WranglerConfig
	const rpc = new RpcClient(() => {}, () => undefined)
	namespaces.set('main namespace', idFactory(new DurableObjectNamespaceImpl(db, 'OtherDO')))
	namespaces.set('cross-script namespace', idFactory(new CrossScriptDurableObjectNamespace('OTHER', 'other-worker', 'OtherDO')))
	namespaces.set(
		'Durable Object thread env',
		idFactory(buildWorkerEnv(config, tempDir, tempDir, rpc, 'HostDO', guestBridge<DOMainMessage>()).env.OTHER),
	)
	namespaces.set(
		'worker thread env',
		idFactory(
			buildThreadEnv({
				config,
				baseDir: tempDir,
				dataDir: tempDir,
				workerLoaderDir: join(tempDir, 'worker-loader'),
				rpc,
				envWsBridge: guestBridge<WorkerMessage>(),
			}).env.OTHER,
		),
	)
})

afterAll(() => {
	rmSync(tempDir, { recursive: true, force: true })
})

const HEX_64 = 'a1'.repeat(32)

for (const label of ['main namespace', 'cross-script namespace', 'Durable Object thread env', 'worker thread env']) {
	describe(`idFromString (${label})`, () => {
		const ns = () => {
			const factory = namespaces.get(label)
			if (!factory) throw new Error(`Unknown namespace ${label}`)
			return factory
		}

		for (const invalid of ['../../escape', 'raw-id', '', 'a1'.repeat(31) + 'a', 'g'.repeat(64), `${HEX_64}/..`, '\0'.repeat(64)]) {
			test(`rejects ${JSON.stringify(invalid)}`, () => {
				expect(() => ns().idFromString(invalid)).toThrow(new TypeError('Invalid Durable Object ID: must be 64 hex digits'))
			})
		}

		test('accepts 64 hex digits and normalizes them to lowercase', () => {
			expect(ns().idFromString(HEX_64.toUpperCase()).toString()).toBe(HEX_64)
		})

		test('accepts the 32-digit ids that older Lopata versions minted', () => {
			expect(ns().idFromString('b2'.repeat(16)).toString()).toBe('b2'.repeat(16))
		})

		test('round-trips ids from idFromName and newUniqueId', () => {
			const named = ns().idFromName('alpha').toString()
			const unique = ns().newUniqueId().toString()
			expect(unique).toMatch(/^[0-9a-f]{64}$/)
			expect(ns().idFromString(named).toString()).toBe(named)
			expect(ns().idFromString(unique).toString()).toBe(unique)
		})
	})
}
