/**
 * Local Browser Run binding (`env.BROWSER`).
 *
 * Sessions live in the main process (`browserRunSessions`): they outlive a worker reload and every
 * worker and Durable Object thread sees the same sessions, like the account-wide sessions on
 * Cloudflare. Each session is a local headless Chrome launched through puppeteer, or the external
 * browser at `browser.wsEndpoint` / `browser.httpEndpoint`. A connection's `webSocket` Fetcher upgrades to a WebSocket
 * bridged to that browser's CDP endpoint, so main also sees the traffic that keeps a session alive.
 *
 * Worker threads reach the sessions over the binding RPC channel (`createRemoteBrowserRunBackend`).
 * The legacy `@cloudflare/puppeteer` shim (`PuppeteerShim`) stays in the calling thread, because it
 * returns a live puppeteer Browser that cannot cross threads.
 */

import { isIP } from 'node:net'
import { type CFWebSocket, type ResponseWithWebSocket, WebSocketPair } from './websocket-pair'

export interface BrowserConfig {
	/** Browser-level CDP WebSocket URL of an external Chrome. Every session then shares that browser. */
	wsEndpoint?: string
	/**
	 * HTTP DevTools endpoint of an external Chrome (puppeteer's `browserURL`), e.g. `http://chrome:9222`.
	 * Each session start reads the WebSocket URL from `/json/version`, so a Chrome restart is picked up.
	 */
	httpEndpoint?: string
	/** Chrome executable for the browsers lopata launches itself. */
	executablePath?: string
	/** Headless mode for the browsers lopata launches itself (default: true). */
	headless?: boolean
	/** Concurrent sessions allowed (default 200, the Cloudflare Workers Paid limit). */
	maxConcurrentSessions?: number
	/** New sessions allowed per second (default 3, the Cloudflare Workers Paid limit). */
	newSessionsPerSecond?: number
	/**
	 * Lopata-only, for tests that wait for an idle close: the smallest `keepAlive` accepted, in ms.
	 * Default 10 000, the Cloudflare minimum.
	 */
	minKeepAlive?: number
}

export interface BrowserRunAcquireOptions {
	/** Idle session lifetime in milliseconds (default 60 000). */
	keepAlive?: number
	recording?: boolean
	location?: string
	outboundByHost?: Record<string, unknown>
	guardrails?: { allowedDomains?: string[]; allowedDomainSets?: string[] }
	targets?: boolean
	liveViewUrlExpiresInMs?: number
}

export interface BrowserRunDevToolsTarget {
	id: string
	type: string
	url: string
	title?: string
	description?: string
	webSocketDebuggerUrl?: string
	devtoolsFrontendUrl?: string
}

export interface BrowserRunAcquireResult {
	sessionId: string
	targets?: BrowserRunDevToolsTarget[]
}

export interface BrowserRunConnectOptions {
	targetId?: string
}

export interface BrowserRunFetcher {
	fetch(input: Request | string | URL, init?: RequestInit): Promise<ResponseWithWebSocket>
	connect(): never
}

export interface BrowserRunConnection {
	sessionId: string
	webSocket: BrowserRunFetcher
	targets?: BrowserRunDevToolsTarget[]
}

export interface BrowserRunSession {
	sessionId: string
	startTime?: number
	endTime?: number
	closeReason?: number
	closeReasonText?: string
	connectionId?: string
	connectionStartTime?: number
	connectionEndTime?: number
	lastUpdated?: number
}

export interface BrowserRunListOptions {
	limit?: number
	offset?: number
}

export interface BrowserRunCloseSessionResult {
	status: 'closing' | 'closed'
}

const DEFAULT_KEEP_ALIVE_MS = 60_000
const MIN_KEEP_ALIVE_MS = 10_000
const MAX_KEEP_ALIVE_MS = 20 * 60_000
const DEFAULT_MAX_CONCURRENT_SESSIONS = 200
const DEFAULT_NEW_SESSIONS_PER_SECOND = 3

interface CloseReason {
	closeReason?: number
	closeReasonText: string
}
const NORMAL_CLOSURE: CloseReason = { closeReason: 1, closeReasonText: 'NormalClosure' }
const BROWSER_IDLE: CloseReason = { closeReason: 2, closeReasonText: 'BrowserIdle' }
/** Cloudflare documents this reason by name only; its numeric code is not published. */
const CHROMIUM_CRASHED: CloseReason = { closeReasonText: 'ChromiumCrashed' }

/** A rejected acquire, with the HTTP status Cloudflare answers with (400, 429) and its error text. */
export class BrowserRunError extends Error {
	constructor(
		readonly status: number,
		reason: string,
	) {
		super(`Unable to create new browser: code: ${status}: message: ${reason}`)
		this.name = 'BrowserRunError'
	}
}

/** Carry the connection's session (and page target) from its Fetcher to `fetch()` on the main-side binding. */
const SESSION_HEADER = 'x-lopata-browser-run-session'
const TARGET_HEADER = 'x-lopata-browser-run-target'

function notSupportedLocally(feature: string): Error {
	return new Error(`Browser Run ${feature} is not supported locally by lopata`)
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function optionalString(value: unknown): string | undefined {
	return typeof value === 'string' ? value : undefined
}

function assertSupportedAcquireOptions(options: BrowserRunAcquireOptions): void {
	if (options.outboundByHost !== undefined) throw notSupportedLocally('acquire option "outboundByHost"')
	if (options.guardrails !== undefined) throw notSupportedLocally('acquire option "guardrails"')
	if (options.recording) throw notSupportedLocally('acquire option "recording"')
}

function parseDevToolsTarget(value: unknown): BrowserRunDevToolsTarget {
	if (!isRecord(value) || typeof value.id !== 'string' || typeof value.type !== 'string' || typeof value.url !== 'string') {
		throw new Error(`Unexpected DevTools target: ${JSON.stringify(value)}`)
	}
	return {
		id: value.id,
		type: value.type,
		url: value.url,
		title: optionalString(value.title),
		description: optionalString(value.description),
		webSocketDebuggerUrl: optionalString(value.webSocketDebuggerUrl),
		devtoolsFrontendUrl: optionalString(value.devtoolsFrontendUrl),
	}
}

function parseDevToolsTargets(value: unknown): BrowserRunDevToolsTarget[] {
	if (!Array.isArray(value)) throw new Error(`Unexpected DevTools target list: ${JSON.stringify(value)}`)
	return value.map(parseDevToolsTarget)
}

function parseAcquireResult(value: unknown): BrowserRunAcquireResult {
	if (!isRecord(value) || typeof value.sessionId !== 'string') {
		throw new Error(`Unexpected Browser Run acquire result: ${JSON.stringify(value)}`)
	}
	return {
		sessionId: value.sessionId,
		targets: value.targets === undefined ? undefined : parseDevToolsTargets(value.targets),
	}
}

function paginate<T>(items: T[], options: BrowserRunListOptions): T[] {
	const offset = options.offset ?? 0
	return items.slice(offset, options.limit === undefined ? undefined : offset + options.limit)
}

interface LocalBrowser {
	/** Browser-level CDP WebSocket URL (`ws://host:port/devtools/browser/<id>`). */
	cdpEndpoint: string
	close(): Promise<void>
}

/** Chrome refuses DevTools requests whose Host is not an IP address or localhost, so a hostname endpoint sends `localhost`. */
function devtoolsHeaders(url: string): Record<string, string> {
	const { hostname, port } = new URL(url)
	if (hostname === 'localhost' || isIP(hostname.replace(/^\[|\]$/g, '')) !== 0) return {}
	return { Host: port ? `localhost:${port}` : 'localhost' }
}

/** Resolve the browser-level WebSocket URL through `/json/version`, addressed at `httpEndpoint`'s host. */
async function resolveWsEndpoint(httpEndpoint: string): Promise<string> {
	const versionUrl = new URL('/json/version', httpEndpoint)
	const response = await fetch(versionUrl, { headers: devtoolsHeaders(httpEndpoint) })
	if (!response.ok) throw new Error(`Reading ${versionUrl} failed: HTTP ${response.status} ${await response.text()}`)
	const version: unknown = await response.json()
	if (!isRecord(version) || typeof version.webSocketDebuggerUrl !== 'string') {
		throw new Error(`${versionUrl} has no webSocketDebuggerUrl: ${JSON.stringify(version)}`)
	}
	// Behind a port forward Chrome reports its own host and port; connect through the configured one instead.
	const wsEndpoint = new URL(version.webSocketDebuggerUrl)
	const configured = new URL(httpEndpoint)
	wsEndpoint.protocol = configured.protocol === 'https:' ? 'wss:' : 'ws:'
	wsEndpoint.host = configured.host
	return wsEndpoint.toString()
}

/** The browser-level CDP WebSocket URL of the configured external Chrome, or undefined when lopata launches its own. */
async function externalWsEndpoint(config: BrowserConfig): Promise<string | undefined> {
	if (config.wsEndpoint && config.httpEndpoint) throw new Error('Set either browser.wsEndpoint or browser.httpEndpoint, not both')
	if (config.httpEndpoint) return resolveWsEndpoint(config.httpEndpoint)
	return config.wsEndpoint
}

async function startBrowser(config: BrowserConfig): Promise<LocalBrowser> {
	const external = await externalWsEndpoint(config)
	if (external) {
		// A shared external browser: closing one session must not close it for the others.
		return { cdpEndpoint: external, close: async () => {} }
	}
	const puppeteer = await import('puppeteer')
	const browser = await puppeteer.default.launch({
		headless: config.headless ?? true,
		executablePath: config.executablePath,
	})
	return { cdpEndpoint: browser.wsEndpoint(), close: () => browser.close() }
}

function pageEndpoint(cdpEndpoint: string, targetId: string): string {
	const url = new URL(cdpEndpoint)
	url.pathname = `/devtools/page/${encodeURIComponent(targetId)}`
	return url.toString()
}

async function listTargets(cdpEndpoint: string): Promise<BrowserRunDevToolsTarget[]> {
	const url = new URL(cdpEndpoint)
	url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:'
	url.pathname = '/json/list'
	const response = await fetch(url, { headers: devtoolsHeaders(cdpEndpoint) })
	if (!response.ok) throw new Error(`Listing DevTools targets failed: HTTP ${response.status}`)
	return parseDevToolsTargets(await response.json())
}

async function openUpstream(url: string): Promise<WebSocket> {
	const socket = new WebSocket(url, { headers: devtoolsHeaders(url) })
	socket.binaryType = 'arraybuffer'
	await new Promise<void>((resolve, reject) => {
		socket.addEventListener('open', () => resolve(), { once: true })
		socket.addEventListener('error', () => reject(new Error(`Cannot open the CDP WebSocket ${url}`)), { once: true })
	})
	return socket
}

class ActiveBrowserRunSession {
	readonly sessionId = crypto.randomUUID()
	readonly startTime = Date.now()
	private lastUpdated = this.startTime
	private connectionId: string | undefined
	private connectionStartTime: number | undefined
	private connectionEndTime: number | undefined
	private readonly upstreams = new Set<WebSocket>()
	private idleTimer: ReturnType<typeof setTimeout> | undefined

	/**
	 * `browserSocket` is a browser-level CDP connection lopata keeps for the session's lifetime: it closes when the
	 * browser exits, crashes or restarts, and then the session ends with it.
	 */
	constructor(
		readonly browser: LocalBrowser,
		private readonly browserSocket: WebSocket,
		private readonly keepAliveMs: number,
		private readonly onIdle: () => void,
		onBrowserGone: () => void,
	) {
		browserSocket.addEventListener('close', onBrowserGone)
		this.touch()
	}

	/** Restart the idle countdown; Browser Run closes a session that receives no CDP commands for `keepAlive`. */
	touch(): void {
		this.lastUpdated = Date.now()
		clearTimeout(this.idleTimer)
		this.idleTimer = setTimeout(this.onIdle, this.keepAliveMs)
	}

	connect(upstream: WebSocket): CFWebSocket {
		this.upstreams.add(upstream)
		this.connectionId = crypto.randomUUID()
		this.connectionStartTime = Date.now()
		this.connectionEndTime = undefined
		this.touch()

		const pair = new WebSocketPair()
		const client = pair[0]
		const server = pair[1]
		server.accept()
		server.onmessage = event => {
			const data: unknown = event.data
			this.touch()
			if (upstream.readyState === WebSocket.OPEN && (typeof data === 'string' || data instanceof ArrayBuffer)) upstream.send(data)
		}
		server.onclose = () => upstream.close()
		upstream.addEventListener('message', event => {
			const data: unknown = event.data
			if (server.readyState === server.OPEN && (typeof data === 'string' || data instanceof ArrayBuffer)) server.send(data)
		})
		upstream.addEventListener('close', event => {
			this.upstreams.delete(upstream)
			if (this.upstreams.size === 0) this.connectionEndTime = Date.now()
			server.close(event.code, event.reason)
		})
		return client
	}

	async close(): Promise<void> {
		clearTimeout(this.idleTimer)
		for (const upstream of this.upstreams) upstream.close()
		this.browserSocket.close()
		await this.browser.close()
	}

	describe(): BrowserRunSession {
		return {
			sessionId: this.sessionId,
			startTime: this.startTime,
			connectionId: this.connectionId,
			connectionStartTime: this.connectionStartTime,
			connectionEndTime: this.connectionEndTime,
			lastUpdated: this.lastUpdated,
		}
	}
}

/** The Browser Run sessions of one process. Main owns the process-wide `browserRunSessions`. */
export class BrowserRunSessions {
	private readonly active = new Map<string, ActiveBrowserRunSession>()
	private readonly closed: BrowserRunSession[] = []
	/** Sessions whose browser is still starting; they count against the concurrency limit. */
	private starting = 0
	/** Start times of the sessions acquired within the last second. */
	private recentStarts: number[] = []

	async acquire(config: BrowserConfig, options: BrowserRunAcquireOptions): Promise<BrowserRunAcquireResult> {
		const keepAlive = this.checkAcquireLimits(config, options)
		this.starting++
		let browser: LocalBrowser
		let browserSocket: WebSocket
		try {
			browser = await startBrowser(config)
			browserSocket = await openUpstream(browser.cdpEndpoint).catch(async error => {
				await browser.close()
				throw error
			})
		} finally {
			this.starting--
		}
		const endSession = (reason: CloseReason, label: string) => () => {
			this.close(session.sessionId, reason).catch(error => console.warn(`[lopata] Closing ${label} Browser Run session failed:`, error))
		}
		const session: ActiveBrowserRunSession = new ActiveBrowserRunSession(
			browser,
			browserSocket,
			keepAlive,
			endSession(BROWSER_IDLE, 'idle'),
			endSession(CHROMIUM_CRASHED, 'a crashed'),
		)
		this.active.set(session.sessionId, session)
		if (!options.targets) return { sessionId: session.sessionId }
		return { sessionId: session.sessionId, targets: await listTargets(browser.cdpEndpoint) }
	}

	/** Reject an acquire Cloudflare would reject; returns the session's keepAlive. */
	private checkAcquireLimits(config: BrowserConfig, options: BrowserRunAcquireOptions): number {
		const keepAlive = options.keepAlive ?? DEFAULT_KEEP_ALIVE_MS
		const minKeepAlive = config.minKeepAlive ?? MIN_KEEP_ALIVE_MS
		if (!(keepAlive >= minKeepAlive && keepAlive <= MAX_KEEP_ALIVE_MS)) {
			throw new BrowserRunError(400, `keepAlive must be between ${minKeepAlive} and ${MAX_KEEP_ALIVE_MS} ms, got ${keepAlive}`)
		}
		const maxConcurrent = config.maxConcurrentSessions ?? DEFAULT_MAX_CONCURRENT_SESSIONS
		if (this.active.size + this.starting >= maxConcurrent) {
			throw new BrowserRunError(429, `Browser instance limit reached: ${maxConcurrent} concurrent sessions`)
		}
		const now = Date.now()
		this.recentStarts = this.recentStarts.filter(start => now - start < 1_000)
		const perSecond = config.newSessionsPerSecond ?? DEFAULT_NEW_SESSIONS_PER_SECOND
		if (this.recentStarts.length >= perSecond) {
			throw new BrowserRunError(429, `Rate limit exceeded: ${perSecond} new browser sessions per second`)
		}
		this.recentStarts.push(now)
		return keepAlive
	}

	get(sessionId: string): BrowserRunSession | null {
		return this.active.get(sessionId)?.describe() ?? null
	}

	list(options: BrowserRunListOptions): BrowserRunSession[] {
		return paginate([...this.active.values()].map(session => session.describe()), options)
	}

	/** Active and closed sessions, most recently started first. */
	history(options: BrowserRunListOptions): BrowserRunSession[] {
		const sessions = [...this.list({}), ...this.closed].sort((a, b) => (b.startTime ?? 0) - (a.startTime ?? 0))
		return paginate(sessions, options)
	}

	async close(sessionId: string, reason: CloseReason = NORMAL_CLOSURE): Promise<BrowserRunCloseSessionResult> {
		const session = this.active.get(sessionId)
		if (!session) {
			if (this.closed.some(closed => closed.sessionId === sessionId)) return { status: 'closed' }
			throw new Error(`Browser Run session "${sessionId}" not found`)
		}
		// The session ends for every caller when it leaves `active`, not once Chrome finishes shutting down.
		this.active.delete(sessionId)
		this.closed.push({ ...session.describe(), endTime: Date.now(), ...reason })
		await session.close()
		return { status: 'closed' }
	}

	/** Open a CDP WebSocket to the session's browser, or to one page target of it. */
	async openCdpSocket(sessionId: string, targetId: string | undefined): Promise<CFWebSocket> {
		const session = this.active.get(sessionId)
		if (!session) throw new Error(`Browser Run session "${sessionId}" is not active`)
		const cdpEndpoint = session.browser.cdpEndpoint
		const upstream = await openUpstream(targetId === undefined ? cdpEndpoint : pageEndpoint(cdpEndpoint, targetId))
		return session.connect(upstream)
	}
}

export const browserRunSessions = new BrowserRunSessions()

/** What the user-facing methods need from the sessions: direct access in main, RPC in a worker thread. */
export interface BrowserRunBackend {
	acquire(options: BrowserRunAcquireOptions): Promise<BrowserRunAcquireResult>
	isActive(sessionId: string): Promise<boolean>
	/** Handle a connection Fetcher's upgrade request (it carries the session headers). */
	openCdp(request: Request): Promise<ResponseWithWebSocket>
}

/** Backend for a worker thread: `call`/`fetch` reach the main-side binding from `createBrowserRunBinding`. */
export function createRemoteBrowserRunBackend(
	call: (method: string, args: unknown[]) => Promise<unknown>,
	fetch: (request: Request) => Promise<Response>,
): BrowserRunBackend {
	return {
		acquire: async options => parseAcquireResult(await call('acquire', [options])),
		isActive: async sessionId => (await call('getSession', [sessionId])) !== null,
		openCdp: fetch,
	}
}

function connectionFetcher(backend: BrowserRunBackend, sessionId: string, targetId: string | undefined): BrowserRunFetcher {
	return {
		fetch: (input, init) => {
			const request = input instanceof Request ? new Request(input, init) : new Request(input.toString(), init)
			const headers = new Headers(request.headers)
			headers.set(SESSION_HEADER, sessionId)
			if (targetId !== undefined) headers.set(TARGET_HEADER, targetId)
			return backend.openCdp(new Request(request, { headers }))
		},
		connect: () => {
			throw notSupportedLocally('webSocket.connect()')
		},
	}
}

export interface ActiveSession {
	sessionId: string
	startTime: number
	connectionId?: string
	connectionStartTime?: number
}

/** Runs the legacy `@cloudflare/puppeteer` flow in the calling thread with real puppeteer / puppeteer-core. */
export class PuppeteerShim {
	/** Managed browser instance (when launched locally, not via an external endpoint). */
	private _browser: any = null

	constructor(private config: BrowserConfig) {}

	/** Launch a new browser and return a puppeteer Browser instance. */
	async launch(opts?: { keep_alive?: number }): Promise<any> {
		const external = await externalWsEndpoint(this.config)
		if (external) {
			const puppeteer = await import('puppeteer-core')
			this._browser = await puppeteer.default.connect({ browserWSEndpoint: external, headers: devtoolsHeaders(external) })
			return this._browser
		}
		const puppeteer = await import('puppeteer')
		this._browser = await puppeteer.default.launch({
			headless: this.config.headless ?? true,
			executablePath: this.config.executablePath,
		})
		return this._browser
	}

	/** Connect to an existing browser session by sessionId. */
	async connect(sessionId: string): Promise<any> {
		const external = await externalWsEndpoint(this.config)
		if (external) {
			const puppeteer = await import('puppeteer-core')
			return puppeteer.default.connect({ browserWSEndpoint: external, headers: devtoolsHeaders(external) })
		}
		// In local dev without an external endpoint, return the existing managed browser if available
		if (this._browser?.isConnected()) {
			return this._browser
		}
		throw new Error('connect() requires browser.wsEndpoint or browser.httpEndpoint, or launch() first')
	}

	/** List active sessions (stub — local dev has at most one). */
	async sessions(): Promise<ActiveSession[]> {
		if (this._browser?.isConnected()) {
			return [{ sessionId: 'local', startTime: Date.now() }]
		}
		return []
	}
}

/** Where the `@cloudflare/puppeteer` shim finds the `PuppeteerShim` on `env.BROWSER`; `launch` belongs to Browser Run now. */
export const PUPPETEER_SHIM = Symbol.for('lopata.browser.puppeteerShim')

export interface PuppeteerShimHost {
	[PUPPETEER_SHIM]: PuppeteerShim
}

/**
 * The user-facing methods both env shapes share. A worker thread mixes them into its RPC proxy, which
 * forwards the remaining methods (`getSession`, `listSessions`, `history`, `closeSession`, `fetch`) to main.
 */
export function createBrowserRunMethods(backend: BrowserRunBackend, config: BrowserConfig) {
	const connection = (sessionId: string, targetId: string | undefined, targets: BrowserRunDevToolsTarget[] | undefined): BrowserRunConnection => {
		const webSocket = connectionFetcher(backend, sessionId, targetId)
		return targets === undefined ? { sessionId, webSocket } : { sessionId, webSocket, targets }
	}
	const unsupported = (feature: string) => async (): Promise<never> => {
		throw notSupportedLocally(feature)
	}

	return {
		acquire: async (options: BrowserRunAcquireOptions = {}): Promise<BrowserRunAcquireResult> => {
			assertSupportedAcquireOptions(options)
			return backend.acquire(options)
		},
		launch: async (options: BrowserRunAcquireOptions = {}): Promise<BrowserRunConnection> => {
			assertSupportedAcquireOptions(options)
			const acquired = await backend.acquire(options)
			return connection(acquired.sessionId, undefined, acquired.targets)
		},
		connectSession: async (sessionId: string, options: BrowserRunConnectOptions = {}): Promise<BrowserRunConnection> => {
			if (!(await backend.isActive(sessionId))) throw new Error(`Browser Run session "${sessionId}" is not active`)
			return connection(sessionId, options.targetId, undefined)
		},
		limits: unsupported('limits()'),
		getLiveView: unsupported('getLiveView()'),
		quickAction: unsupported('quickAction()'),
		devtools: {
			getVersion: unsupported('devtools.getVersion()'),
			getProtocol: unsupported('devtools.getProtocol()'),
			listTargets: unsupported('devtools.listTargets()'),
			getTarget: unsupported('devtools.getTarget()'),
			newTarget: unsupported('devtools.newTarget()'),
			activateTarget: unsupported('devtools.activateTarget()'),
			closeTarget: unsupported('devtools.closeTarget()'),
		},
		[PUPPETEER_SHIM]: new PuppeteerShim(config),
	}
}

/** Answer a connection Fetcher's upgrade request with a 101 carrying a WebSocket bridged to CDP. */
async function openCdpFromRequest(sessions: BrowserRunSessions, request: Request): Promise<ResponseWithWebSocket> {
	const sessionId = request.headers.get(SESSION_HEADER)
	if (sessionId === null) throw notSupportedLocally('fetch() (the raw HTTP API)')
	if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
		throw new Error('A Browser Run connection fetch() must be a WebSocket upgrade (Upgrade: websocket)')
	}
	const client = await sessions.openCdpSocket(sessionId, request.headers.get(TARGET_HEADER) ?? undefined)
	const response: ResponseWithWebSocket = new Response(null, { status: 101 })
	response.webSocket = client
	return response
}

/** The main-side `env.BROWSER`. Worker threads reach it through RPC proxies built around `createBrowserRunMethods`. */
export function createBrowserRunBinding(config: BrowserConfig, sessions: BrowserRunSessions = browserRunSessions) {
	const backend: BrowserRunBackend = {
		acquire: options => sessions.acquire(config, options),
		isActive: async sessionId => sessions.get(sessionId) !== null,
		openCdp: request => openCdpFromRequest(sessions, request),
	}
	return {
		...createBrowserRunMethods(backend, config),
		getSession: async (sessionId: string): Promise<BrowserRunSession | null> => sessions.get(sessionId),
		listSessions: async (options: BrowserRunListOptions = {}): Promise<BrowserRunSession[]> => sessions.list(options),
		history: async (options: BrowserRunListOptions = {}): Promise<BrowserRunSession[]> => sessions.history(options),
		closeSession: (sessionId: string): Promise<BrowserRunCloseSessionResult> => sessions.close(sessionId),
		fetch: (request: Request): Promise<Response> => openCdpFromRequest(sessions, request),
	}
}
