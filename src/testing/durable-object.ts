import type { InProcessExecutor } from '../bindings/do-executor-inprocess'
import type { DurableObjectNamespaceImpl, SqliteDurableObjectStorage } from '../bindings/durable-object'
import type { SqlStorage } from '../bindings/durable-object'
import type { CFWebSocket } from '../bindings/websocket-pair'

export class TestDurableObjectStorage {
	private storage: SqliteDurableObjectStorage

	constructor(storage: SqliteDurableObjectStorage) {
		this.storage = storage
	}

	async get<T = unknown>(key: string): Promise<T | undefined>
	async get<T = unknown>(keys: string[]): Promise<Map<string, T>>
	async get<T = unknown>(keyOrKeys: string | string[]): Promise<T | undefined | Map<string, T>> {
		return this.storage.get(keyOrKeys as any)
	}

	async list(
		options?: { prefix?: string; start?: string; startAfter?: string; end?: string; limit?: number; reverse?: boolean },
	): Promise<Map<string, unknown>> {
		return this.storage.list(options)
	}

	async put(key: string, value: unknown): Promise<void>
	async put(entries: Record<string, unknown>): Promise<void>
	async put(keyOrEntries: string | Record<string, unknown>, value?: unknown): Promise<void> {
		if (typeof keyOrEntries === 'string') {
			return this.storage.put(keyOrEntries, value)
		}
		return this.storage.put(keyOrEntries)
	}

	async delete(key: string): Promise<boolean>
	async delete(keys: string[]): Promise<number>
	async delete(keyOrKeys: string | string[]): Promise<boolean | number> {
		return this.storage.delete(keyOrKeys as any)
	}

	async deleteAll(): Promise<void> {
		return this.storage.deleteAll()
	}

	async getAlarm(): Promise<number | null> {
		return this.storage.getAlarm()
	}

	async setAlarm(scheduledTime: number | Date): Promise<void> {
		return this.storage.setAlarm(scheduledTime)
	}

	async deleteAlarm(): Promise<void> {
		return this.storage.deleteAlarm()
	}
}

// --- TestWebSocket ---

export class TestWebSocket {
	readonly raw: CFWebSocket
	private _messages: (string | ArrayBuffer)[] = []
	private _messageWaiters: { resolve: (msg: string | ArrayBuffer) => void; reject: (err: Error) => void }[] = []
	private _closeWaiters: { resolve: (ev: { code: number; reason: string }) => void; reject: (err: Error) => void }[] = []
	private _closed = false
	private _closeData: { code: number; reason: string } | null = null

	constructor(ws: CFWebSocket) {
		this.raw = ws

		ws.addEventListener('message', (event: Event) => {
			const data = (event as MessageEvent).data as string | ArrayBuffer
			const waiter = this._messageWaiters.shift()
			if (waiter) {
				waiter.resolve(data)
			} else {
				this._messages.push(data)
			}
		})

		ws.addEventListener('close', (event: Event) => {
			this._closed = true
			const ce = event as CloseEvent
			const closeData = { code: ce.code, reason: ce.reason }
			this._closeData = closeData
			// Reject all pending message waiters
			for (const w of this._messageWaiters) {
				w.reject(new Error('WebSocket closed'))
			}
			this._messageWaiters = []
			// Resolve close waiters
			for (const w of this._closeWaiters) {
				w.resolve(closeData)
			}
			this._closeWaiters = []
		})
	}

	get readyState(): number {
		return this.raw.readyState
	}

	/** All received messages so far. */
	get messages(): ReadonlyArray<string | ArrayBuffer> {
		return this._messages
	}

	/** Send data to the DO via the WebSocket. */
	send(data: string | ArrayBuffer | ArrayBufferView): void {
		this.raw.send(data)
	}

	/** Wait for the next message from the DO. */
	waitForMessage(timeout = 5000): Promise<string | ArrayBuffer> {
		// Check queue first
		const queued = this._messages.shift()
		if (queued !== undefined) return Promise.resolve(queued)

		if (this._closed) return Promise.reject(new Error('WebSocket closed'))

		return new Promise<string | ArrayBuffer>((resolve, reject) => {
			const timer = setTimeout(() => {
				const idx = this._messageWaiters.findIndex(w => w.resolve === resolve)
				if (idx !== -1) this._messageWaiters.splice(idx, 1)
				reject(new Error(`waitForMessage timed out after ${timeout}ms`))
			}, timeout)

			this._messageWaiters.push({
				resolve: (msg) => {
					clearTimeout(timer)
					resolve(msg)
				},
				reject: (err) => {
					clearTimeout(timer)
					reject(err)
				},
			})
		})
	}

	/** Wait for the WebSocket to close. */
	waitForClose(timeout = 5000): Promise<{ code: number; reason: string }> {
		if (this._closed) {
			return Promise.resolve(this._closeData ?? { code: 1000, reason: '' })
		}

		return new Promise<{ code: number; reason: string }>((resolve, reject) => {
			const timer = setTimeout(() => {
				const idx = this._closeWaiters.findIndex(w => w.resolve === resolve)
				if (idx !== -1) this._closeWaiters.splice(idx, 1)
				reject(new Error(`waitForClose timed out after ${timeout}ms`))
			}, timeout)

			this._closeWaiters.push({
				resolve: (ev) => {
					clearTimeout(timer)
					resolve(ev)
				},
				reject: (err) => {
					clearTimeout(timer)
					reject(err)
				},
			})
		})
	}

	/** Close the WebSocket from the client side. */
	close(code?: number, reason?: string): void {
		this.raw.close(code, reason)
	}

	/** Read the server-side WebSocket's serialized attachment. */
	deserializeAttachment(): unknown {
		const peer = this.raw._peer
		if (!peer) return null
		return peer.deserializeAttachment()
	}

	/** Write to the server-side WebSocket's serialized attachment. */
	serializeAttachment(value: unknown): void {
		const peer = this.raw._peer
		if (!peer) throw new Error('No peer WebSocket')
		peer.serializeAttachment(value)
	}
}

// --- TestDurableObjectHandle ---

export class TestDurableObjectHandle {
	private namespace: DurableObjectNamespaceImpl
	private idStr: string
	private _stub: unknown | null = null

	constructor(namespace: DurableObjectNamespaceImpl, idStr: string) {
		this.namespace = namespace
		this.idStr = idStr
	}

	/** The DO instance ID. */
	get id(): string {
		return this.idStr
	}

	/** RPC proxy stub. Forces executor creation on first access. */
	get stub(): any {
		if (!this._stub) {
			const doId = this.namespace.idFromString(this.idStr)
			this._stub = this.namespace.get(doId)
		}
		return this._stub
	}

	private getExecutor(): InProcessExecutor {
		// Ensure executor exists by accessing the stub
		// eslint-disable-next-line @typescript-eslint/no-unused-expressions
		this.stub
		const executor = this.namespace._getExecutor(this.idStr)
		if (!executor) throw new Error(`Durable Object executor not found for ${this.idStr}`)
		return executor as InProcessExecutor
	}

	/** Access KV-style storage for this DO instance. */
	get storage(): TestDurableObjectStorage {
		const executor = this.getExecutor()
		return new TestDurableObjectStorage(executor._rawState.storage)
	}

	/** Access SQL storage for this DO instance. */
	get sql(): SqlStorage {
		const executor = this.getExecutor()
		return executor._rawState.storage.sql
	}

	/** Get the scheduled alarm time, or null. */
	async getAlarm(): Promise<number | null> {
		const executor = this.getExecutor()
		return executor._rawState.storage.getAlarm()
	}

	/** Trigger the alarm handler immediately. */
	async triggerAlarm(): Promise<void> {
		return this.namespace.triggerAlarm(this.idStr)
	}

	/** Cancel a scheduled alarm without firing it. */
	async cancelAlarm(): Promise<void> {
		this.namespace.cancelAlarm(this.idStr)
	}

	/** Delete this DO instance and all its data. */
	async delete(): Promise<void> {
		this.namespace.deleteInstance(this.idStr)
		this._stub = null
	}

	/** Connect a WebSocket to this DO, simulating the upgrade handshake. */
	async connectWebSocket(options?: {
		path?: string
		headers?: Record<string, string>
	}): Promise<TestWebSocket> {
		const executor = this.getExecutor()
		const path = options?.path ?? '/'
		const url = `http://localhost${path}`
		const headers = new Headers(options?.headers)
		headers.set('upgrade', 'websocket')

		const request = new Request(url, { headers })
		const response = await executor.executeFetch(request)

		// Extract the server-side WebSocket from the response
		const serverWs = (response as any).webSocket as CFWebSocket | undefined
		if (!serverWs) {
			throw new Error('DO fetch handler did not return a WebSocket upgrade response (no response.webSocket)')
		}

		// Accept the client side (simulates what Bun.serve does)
		serverWs.accept()

		return new TestWebSocket(serverWs)
	}

	/** Get all accepted WebSockets for this DO instance (via DurableObjectState). */
	getWebSockets(tag?: string): WebSocket[] {
		const executor = this.getExecutor()
		return executor._rawState.getWebSockets(tag)
	}

	/** Get tags for a specific WebSocket. */
	getTags(ws: WebSocket): string[] {
		const executor = this.getExecutor()
		return executor._rawState.getTags(ws)
	}
}

export class TestDurableObjectNamespace {
	private namespace: DurableObjectNamespaceImpl
	private handles: TestDurableObjectHandle[] = []

	constructor(namespace: DurableObjectNamespaceImpl) {
		this.namespace = namespace
	}

	/** Get a DO handle by name (uses idFromName). */
	get(name: string): TestDurableObjectHandle {
		const doId = this.namespace.idFromName(name)
		const handle = new TestDurableObjectHandle(this.namespace, doId.toString())
		this.handles.push(handle)
		return handle
	}

	/** Get a DO handle by raw ID string. */
	getById(idStr: string): TestDurableObjectHandle {
		const handle = new TestDurableObjectHandle(this.namespace, idStr)
		this.handles.push(handle)
		return handle
	}

	/** List all instance IDs in this namespace. */
	listIds(): string[] {
		return this.namespace._listInstanceIds()
	}

	dispose(): void {
		this.handles = []
	}
}
