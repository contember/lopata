import { describe, expect, test } from 'bun:test'
import type { WranglerConfig } from '../src/config'
import type { ClassRegistry } from '../src/generation'
import { Generation } from '../src/generation'
import type { WorkerThreadExecutor } from '../src/worker-thread/executor'

type Counters = 'pendingWaitUntil' | 'pendingHandlerWork' | 'pendingFetch' | 'openStreamCount'

function makeExecutor(over: Partial<Record<Counters, () => number>> = {}): WorkerThreadExecutor {
	return {
		pendingWaitUntil: () => 0,
		pendingHandlerWork: () => 0,
		pendingFetch: () => 0,
		openStreamCount: () => 0,
		...over,
	} as unknown as WorkerThreadExecutor
}

const emptyRegistry: ClassRegistry = {
	durableObjects: [],
	workflows: [],
	containers: [],
	queueConsumers: [],
	serviceBindings: [],
	staticAssets: null,
}

const config = { main: 'index.ts' } as unknown as WranglerConfig

function gen(executor: WorkerThreadExecutor): Generation {
	return new Generation(1, {}, emptyRegistry, config, executor)
}

describe('Generation.isIdle()', () => {
	test('idle when nothing is pending', () => {
		expect(gen(makeExecutor()).isIdle()).toBe(true)
	})

	test('not idle while a waitUntil promise is in flight', () => {
		expect(gen(makeExecutor({ pendingWaitUntil: () => 1 })).isIdle()).toBe(false)
	})

	test('not idle while a scheduled/email/inbound-RPC handler is in flight', () => {
		expect(gen(makeExecutor({ pendingHandlerWork: () => 1 })).isIdle()).toBe(false)
	})

	// CORR-LIFECYCLE-1: a cross-worker service-binding fetch lands in the
	// executor's _pending map without touching activeRequests, so the drain must
	// see it — otherwise reloading the target severs the request mid-flight.
	test('not idle while a top-level/cross-worker fetch is in flight', () => {
		expect(gen(makeExecutor({ pendingFetch: () => 1 })).isIdle()).toBe(false)
	})

	// CORR-3: streamed bodies (SSE / large download / upload) outlive the
	// executeFetch promise — drain must keep the generation alive while any are
	// open, or reload cuts them off mid-stream.
	test('not idle while a streamed body is still flowing', () => {
		expect(gen(makeExecutor({ openStreamCount: () => 1 })).isIdle()).toBe(false)
	})
})
