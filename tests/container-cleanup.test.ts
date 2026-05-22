import { describe, expect, test } from 'bun:test'
import {
	_activeContainersSnapshot,
	containerLabels,
	LOPATA_LABEL_KEY,
	LOPATA_LABEL_VALUE,
	LOPATA_PID_LABEL_KEY,
	registerContainer,
	unregisterContainer,
} from '../src/bindings/container-cleanup'
import { DockerManager } from '../src/bindings/container-docker'

describe('container-cleanup registry', () => {
	test('register / unregister round-trips through the snapshot', () => {
		registerContainer('cleanup-test-a')
		registerContainer('cleanup-test-b')
		expect(_activeContainersSnapshot()).toContain('cleanup-test-a')
		expect(_activeContainersSnapshot()).toContain('cleanup-test-b')

		unregisterContainer('cleanup-test-a')
		expect(_activeContainersSnapshot()).not.toContain('cleanup-test-a')
		expect(_activeContainersSnapshot()).toContain('cleanup-test-b')

		unregisterContainer('cleanup-test-b')
	})

	test('unregister is a no-op for unknown names', () => {
		// Must not throw.
		unregisterContainer('never-registered')
	})

	test('register is idempotent (Set semantics)', () => {
		registerContainer('cleanup-test-dup')
		registerContainer('cleanup-test-dup')
		const snap = _activeContainersSnapshot()
		expect(snap.filter(n => n === 'cleanup-test-dup')).toHaveLength(1)
		unregisterContainer('cleanup-test-dup')
	})
})

describe('containerLabels()', () => {
	test('includes the marker + current pid for orphan reaping', () => {
		const labels = containerLabels()
		expect(labels[LOPATA_LABEL_KEY]).toBe(LOPATA_LABEL_VALUE)
		expect(labels[LOPATA_PID_LABEL_KEY]).toBe(String(process.pid))
	})
})

describe('DockerManager constructor wiring', () => {
	test('passes onRegister and onRemove without touching docker for a no-op spy', () => {
		// We don't actually `run()` here — this just confirms callbacks land on
		// the instance and that the constructor accepts the options shape.
		// `run()` requires docker which isn't available in CI test boxes.
		const registered: string[] = []
		const removed: string[] = []
		const docker = new DockerManager({
			onRegister: name => registered.push(name),
			onRemove: name => removed.push(name),
			labels: { lopata: '1', 'lopata.pid': '42' },
		})
		expect(docker).toBeInstanceOf(DockerManager)
		// Sanity: arrays are still empty (no docker call attempted).
		expect(registered).toEqual([])
		expect(removed).toEqual([])
	})
})
