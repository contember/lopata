import { describe, expect, test } from 'bun:test'
import {
	_activeContainersSnapshot,
	_selectOrphanNames,
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

describe('_selectOrphanNames (orphan filter)', () => {
	// `alive` is always called with pid > 0 — the caller guards against ≤0.
	const aliveOnly = (pids: number[]) => (pid: number) => pids.includes(pid)

	test('reaps container labeled lopata.pid=0 even when alive() would lie', () => {
		// On POSIX `process.kill(0, 0)` signals the whole process group and
		// succeeds — so a buggy `alive(0) === true` would keep the orphan
		// alive forever. The filter must short-circuit pid ≤ 0 BEFORE calling
		// `alive`, so this test passes an `alive` that returns true for
		// everything and asserts the pid=0 row is still reaped.
		const listOut = 'orphan-zero|0\n'
		const alive = () => true
		expect(_selectOrphanNames(listOut, alive)).toEqual(['orphan-zero'])
	})

	test('reaps containers with missing / unparseable pid labels', () => {
		const listOut = ['no-pid|', 'garbage-pid|not-a-number', 'lone-name'].join('\n')
		const orphans = _selectOrphanNames(listOut, aliveOnly([]))
		expect(orphans).toEqual(['no-pid', 'garbage-pid', 'lone-name'])
	})

	test('keeps containers whose owner pid is alive', () => {
		const listOut = ['alive-1|1111', 'dead-1|9999'].join('\n')
		const orphans = _selectOrphanNames(listOut, aliveOnly([1111]))
		expect(orphans).toEqual(['dead-1'])
	})

	test('treats negative pid labels as orphans', () => {
		// Negative pid is invalid; alive() should not even be called for it.
		const listOut = 'weird-neg|-1\n'
		const alive = () => true
		expect(_selectOrphanNames(listOut, alive)).toEqual(['weird-neg'])
	})

	test('ignores blank lines and lines without a name', () => {
		const listOut = '\n\n|orphan-without-name\nrealname|1234\n'
		const orphans = _selectOrphanNames(listOut, aliveOnly([1234]))
		expect(orphans).toEqual([])
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
