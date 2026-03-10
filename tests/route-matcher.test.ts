import { describe, expect, test } from 'bun:test'
import { extractPathPattern, matchHost, matchRoute, RouteDispatcher } from '../src/route-matcher'

describe('extractPathPattern', () => {
	test('strips domain from route pattern', () => {
		expect(extractPathPattern('example.com/api/*')).toBe('/api/*')
	})

	test('strips domain with subdomain', () => {
		expect(extractPathPattern('app.example.com/api/v1/*')).toBe('/api/v1/*')
	})

	test('preserves path-only patterns', () => {
		expect(extractPathPattern('/api/*')).toBe('/api/*')
	})

	test('handles domain-only pattern (no path)', () => {
		expect(extractPathPattern('example.com')).toBe('/*')
	})

	test('handles object route format', () => {
		expect(extractPathPattern({ pattern: 'example.com/api/*' })).toBe('/api/*')
	})

	test('handles object route with extra fields', () => {
		expect(extractPathPattern({ pattern: 'example.com/api/*' })).toBe('/api/*')
	})

	test('strips https:// protocol prefix', () => {
		expect(extractPathPattern('https://example.com/api/*')).toBe('/api/*')
	})

	test('strips http:// protocol prefix', () => {
		expect(extractPathPattern('http://example.com/api/*')).toBe('/api/*')
	})

	test('handles protocol with domain-only (no path)', () => {
		expect(extractPathPattern('https://example.com')).toBe('/*')
	})

	test('handles domain with port', () => {
		expect(extractPathPattern('example.com:8080/api/*')).toBe('/api/*')
	})

	test('handles protocol + domain + port', () => {
		expect(extractPathPattern('https://example.com:8080/api/*')).toBe('/api/*')
	})

	test('strips query string from pattern', () => {
		expect(extractPathPattern('example.com/api/data?key=value')).toBe('/api/data')
	})

	test('strips hash fragment from pattern', () => {
		expect(extractPathPattern('example.com/api/data#section')).toBe('/api/data')
	})

	test('strips query string from path-only pattern', () => {
		expect(extractPathPattern('/api/data?key=value')).toBe('/api/data')
	})

	test('strips hash from path-only pattern', () => {
		expect(extractPathPattern('/api/data#section')).toBe('/api/data')
	})

	test('strips query string before hash', () => {
		expect(extractPathPattern('example.com/api/data?key=value#section')).toBe('/api/data')
	})

	test('handles wildcard in domain part', () => {
		expect(extractPathPattern('*.example.com/api/*')).toBe('/api/*')
	})

	test('handles domain-only with port and no path', () => {
		expect(extractPathPattern('localhost:3000')).toBe('/*')
	})
})

describe('matchRoute', () => {
	test('wildcard /* matches everything', () => {
		expect(matchRoute('/', '/*')).toBe(true)
		expect(matchRoute('/foo', '/*')).toBe(true)
		expect(matchRoute('/foo/bar', '/*')).toBe(true)
	})

	test('/api/* matches paths under /api/', () => {
		expect(matchRoute('/api/foo', '/api/*')).toBe(true)
		expect(matchRoute('/api/foo/bar', '/api/*')).toBe(true)
		expect(matchRoute('/api/', '/api/*')).toBe(true)
	})

	test('/api/* does not match /api without trailing slash', () => {
		expect(matchRoute('/api', '/api/*')).toBe(false)
	})

	test('/api/* does not match unrelated paths', () => {
		expect(matchRoute('/other', '/api/*')).toBe(false)
		expect(matchRoute('/apifoo', '/api/*')).toBe(false)
	})

	test('exact path match without wildcard', () => {
		expect(matchRoute('/api/users', '/api/users')).toBe(true)
		expect(matchRoute('/api/users/', '/api/users')).toBe(false)
		expect(matchRoute('/api/users/1', '/api/users')).toBe(false)
	})

	test('trailing * without slash matches prefix', () => {
		expect(matchRoute('/api-v2/test', '/api*')).toBe(true)
		expect(matchRoute('/api', '/api*')).toBe(true)
	})

	test('exact match for root path /', () => {
		expect(matchRoute('/', '/')).toBe(true)
		expect(matchRoute('/foo', '/')).toBe(false)
	})

	test('bare * matches everything', () => {
		expect(matchRoute('/', '*')).toBe(true)
		expect(matchRoute('/anything', '*')).toBe(true)
	})

	test('root / does not match specific wildcard patterns', () => {
		expect(matchRoute('/', '/api/*')).toBe(false)
		expect(matchRoute('/', '/api*')).toBe(false)
	})

	test('trailing slash exact match differences', () => {
		expect(matchRoute('/api/', '/api')).toBe(false)
		expect(matchRoute('/api', '/api/')).toBe(false)
		expect(matchRoute('/api/', '/api/')).toBe(true)
	})
})

describe('matchHost', () => {
	test('exact match', () => {
		expect(matchHost('localhost', 'localhost')).toBe(true)
		expect(matchHost('example.com', 'example.com')).toBe(true)
	})

	test('exact match fails for different hosts', () => {
		expect(matchHost('other.com', 'example.com')).toBe(false)
	})

	test('wildcard *.localhost matches subdomains', () => {
		expect(matchHost('site-xxx.localhost', '*.localhost')).toBe(true)
		expect(matchHost('foo.localhost', '*.localhost')).toBe(true)
	})

	test('wildcard *.localhost does not match bare hostname', () => {
		expect(matchHost('localhost', '*.localhost')).toBe(false)
	})

	test('wildcard *.example.com matches subdomains', () => {
		expect(matchHost('app.example.com', '*.example.com')).toBe(true)
		expect(matchHost('api.example.com', '*.example.com')).toBe(true)
	})

	test('wildcard *.example.com does not match bare domain', () => {
		expect(matchHost('example.com', '*.example.com')).toBe(false)
	})

	test('wildcard does not match nested subdomains partially', () => {
		// *.localhost should match a.b.localhost too (suffix match)
		expect(matchHost('a.b.localhost', '*.localhost')).toBe(true)
	})

	test('non-wildcard pattern does not match subdomains', () => {
		expect(matchHost('sub.localhost', 'localhost')).toBe(false)
	})
})

describe('RouteDispatcher', () => {
	function mockManager(name: string) {
		return { _name: name } as any
	}

	test('more specific routes should match first (segment depth over string length)', () => {
		const fallback = mockManager('main')
		const dispatcher = new RouteDispatcher(fallback)

		const apiWorker = mockManager('api')
		const catchAllWorker = mockManager('catchall')

		// /api/v1/* has more segments than /longername/*
		dispatcher.addRoutes({ routes: ['/api/v1/*'] } as any, apiWorker, 'api')
		dispatcher.addRoutes({ routes: ['/longername/*'] } as any, catchAllWorker, 'catchall')

		const routes = dispatcher.getRegisteredRoutes()
		// /api/v1/* has 2 segments, /longername/* has 1 — api should come first
		expect(routes[0]!.pattern).toBe('/api/v1/*')
		expect(routes[1]!.pattern).toBe('/longername/*')
	})

	test('non-wildcard patterns come before wildcard patterns', () => {
		const fallback = mockManager('main')
		const dispatcher = new RouteDispatcher(fallback)

		const exactWorker = mockManager('exact')
		const wildWorker = mockManager('wild')

		dispatcher.addRoutes({ routes: ['/api/*'] } as any, wildWorker, 'wild')
		dispatcher.addRoutes({ routes: ['/api/users'] } as any, exactWorker, 'exact')

		const routes = dispatcher.getRegisteredRoutes()
		expect(routes[0]!.pattern).toBe('/api/users')
		expect(routes[1]!.pattern).toBe('/api/*')
	})

	test('resolve returns matching aux worker manager', () => {
		const fallback = mockManager('main')
		const dispatcher = new RouteDispatcher(fallback)

		const apiWorker = mockManager('api')
		dispatcher.addRoutes({ routes: ['/api/*'] } as any, apiWorker, 'api')

		expect(dispatcher.resolve('/api/foo')).toBe(apiWorker)
		expect(dispatcher.resolve('/other')).toBe(fallback)
	})

	test('resolve returns fallback for unmatched paths', () => {
		const fallback = mockManager('main')
		const dispatcher = new RouteDispatcher(fallback)

		const apiWorker = mockManager('api')
		dispatcher.addRoutes({ routes: ['/api/*'] } as any, apiWorker, 'api')

		expect(dispatcher.resolve('/other')).toBe(fallback)
	})

	test('isFallback identifies the fallback manager', () => {
		const fallback = mockManager('main')
		const dispatcher = new RouteDispatcher(fallback)

		const apiWorker = mockManager('api')
		dispatcher.addRoutes({ routes: ['/api/*'] } as any, apiWorker, 'api')

		expect(dispatcher.isFallback(fallback)).toBe(true)
		expect(dispatcher.isFallback(apiWorker)).toBe(false)
	})

	test('removeWorkerRoutes removes routes for a specific worker', () => {
		const fallback = mockManager('main')
		const dispatcher = new RouteDispatcher(fallback)

		const apiWorker = mockManager('api')
		const authWorker = mockManager('auth')
		dispatcher.addRoutes({ routes: ['/api/*'] } as any, apiWorker, 'api')
		dispatcher.addRoutes({ routes: ['/auth/*'] } as any, authWorker, 'auth')

		expect(dispatcher.getRegisteredRoutes()).toHaveLength(2)

		dispatcher.removeWorkerRoutes('api')
		const remaining = dispatcher.getRegisteredRoutes()
		expect(remaining).toHaveLength(1)
		expect(remaining[0]!.workerName).toBe('auth')

		// /api/foo should now fall through to fallback
		expect(dispatcher.resolve('/api/foo')).toBe(fallback)
	})

	test('segment-based sorting: deeper paths win over longer strings', () => {
		const fallback = mockManager('main')
		const dispatcher = new RouteDispatcher(fallback)

		// "/a/b/c/*" has 3 segments, "/very-long-name/*" has 1 segment
		// Even though "/very-long-name/*" is a longer string, /a/b/c/* is more specific
		const deepWorker = mockManager('deep')
		const longWorker = mockManager('long')

		dispatcher.addRoutes({ routes: ['/very-long-name/*'] } as any, longWorker, 'long')
		dispatcher.addRoutes({ routes: ['/a/b/c/*'] } as any, deepWorker, 'deep')

		const routes = dispatcher.getRegisteredRoutes()
		expect(routes[0]!.pattern).toBe('/a/b/c/*')
		expect(routes[1]!.pattern).toBe('/very-long-name/*')
	})

	test('hasRoutes returns false when no routes are registered', () => {
		const fallback = mockManager('main')
		const dispatcher = new RouteDispatcher(fallback)
		expect(dispatcher.hasRoutes()).toBe(false)
	})

	test('hasRoutes returns true when routes exist', () => {
		const fallback = mockManager('main')
		const dispatcher = new RouteDispatcher(fallback)
		dispatcher.addRoutes({ routes: ['/api/*'] } as any, mockManager('api'), 'api')
		expect(dispatcher.hasRoutes()).toBe(true)
	})

	test('duplicate pattern from different workers is skipped with warning', () => {
		const fallback = mockManager('main')
		const dispatcher = new RouteDispatcher(fallback)

		const warnings: string[] = []
		const origWarn = console.warn
		console.warn = (...args: any[]) => warnings.push(args.join(' '))

		const workerA = mockManager('worker-a')
		const workerB = mockManager('worker-b')

		try {
			dispatcher.addRoutes({ routes: ['/api/*'] } as any, workerA, 'worker-a')
			dispatcher.addRoutes({ routes: ['/api/*'] } as any, workerB, 'worker-b')

			expect(warnings.some(w => w.includes('worker-a') && w.includes('worker-b'))).toBe(true)
			// First registered worker wins — duplicate is skipped
			expect(dispatcher.resolve('/api/foo')).toBe(workerA)
			expect(dispatcher.getRegisteredRoutes()).toHaveLength(1)
		} finally {
			console.warn = origWarn
		}
	})

	test('same worker re-adding replaces old routes without warning', () => {
		const fallback = mockManager('main')
		const dispatcher = new RouteDispatcher(fallback)

		const warnings: string[] = []
		const origWarn = console.warn
		console.warn = (...args: any[]) => warnings.push(args.join(' '))

		const workerA = mockManager('worker-a')

		try {
			dispatcher.addRoutes({ routes: ['/api/*', '/old/*'] } as any, workerA, 'worker-a')
			expect(dispatcher.getRegisteredRoutes()).toHaveLength(2)

			// Re-register with different routes — old ones are cleared
			dispatcher.addRoutes({ routes: ['/api/*', '/new/*'] } as any, workerA, 'worker-a')
			expect(dispatcher.getRegisteredRoutes()).toHaveLength(2)

			expect(dispatcher.resolve('/old/foo')).toBe(fallback) // old route gone
			expect(dispatcher.resolve('/new/foo')).toBe(workerA) // new route works
			expect(warnings).toHaveLength(0) // no warnings
		} finally {
			console.warn = origWarn
		}
	})

	test('overlapping /api/* and /api* resolve correctly', () => {
		const fallback = mockManager('main')
		const dispatcher = new RouteDispatcher(fallback)

		const slashWorker = mockManager('slash')
		const noSlashWorker = mockManager('noslash')

		dispatcher.addRoutes({ routes: ['/api/*'] } as any, slashWorker, 'slash')
		dispatcher.addRoutes({ routes: ['/api*'] } as any, noSlashWorker, 'noslash')

		// /api/foo should match /api/* (non-wildcard-at-segment-boundary is more specific)
		expect(dispatcher.resolve('/api/foo')).toBe(slashWorker)
		// /api-v2 should match /api* (prefix match without slash)
		expect(dispatcher.resolve('/api-v2')).toBe(noSlashWorker)
		// /other should fall through to fallback
		expect(dispatcher.resolve('/other')).toBe(fallback)
	})

	test('exact route from one worker wins over wildcard from another', () => {
		const fallback = mockManager('main')
		const dispatcher = new RouteDispatcher(fallback)

		const exactWorker = mockManager('exact-worker')
		const wildcardWorker = mockManager('wildcard-worker')

		dispatcher.addRoutes({ routes: ['/api/*'] } as any, wildcardWorker, 'wildcard-worker')
		dispatcher.addRoutes({ routes: ['/api/users'] } as any, exactWorker, 'exact-worker')

		expect(dispatcher.resolve('/api/users')).toBe(exactWorker)
		expect(dispatcher.resolve('/api/other')).toBe(wildcardWorker)
		expect(dispatcher.resolve('/other')).toBe(fallback)
	})

	test('config with no routes is silently ignored', () => {
		const fallback = mockManager('main')
		const dispatcher = new RouteDispatcher(fallback)

		dispatcher.addRoutes({} as any, mockManager('no-routes'), 'no-routes')
		expect(dispatcher.hasRoutes()).toBe(false)
		expect(dispatcher.resolve('/anything')).toBe(fallback)
	})

	test('custom_domain routes are skipped', () => {
		const fallback = mockManager('main')
		const dispatcher = new RouteDispatcher(fallback)

		const worker = mockManager('worker')
		dispatcher.addRoutes(
			{
				routes: [
					{ pattern: 'api.example.com', custom_domain: true },
					'/api/*',
				],
			} as any,
			worker,
			'worker',
		)

		expect(dispatcher.getRegisteredRoutes()).toHaveLength(1)
		expect(dispatcher.getRegisteredRoutes()[0]!.pattern).toBe('/api/*')
	})

	test('empty route patterns are skipped with warning', () => {
		const fallback = mockManager('main')
		const dispatcher = new RouteDispatcher(fallback)

		const warnings: string[] = []
		const origWarn = console.warn
		console.warn = (...args: any[]) => warnings.push(args.join(' '))

		try {
			const worker = mockManager('worker')
			dispatcher.addRoutes({ routes: ['', '/api/*'] } as any, worker, 'worker')

			expect(dispatcher.getRegisteredRoutes()).toHaveLength(1)
			expect(dispatcher.getRegisteredRoutes()[0]!.pattern).toBe('/api/*')
			expect(warnings.some(w => w.includes('empty route pattern'))).toBe(true)
		} finally {
			console.warn = origWarn
		}
	})

	test('whitespace-only route patterns are skipped with warning', () => {
		const fallback = mockManager('main')
		const dispatcher = new RouteDispatcher(fallback)

		const warnings: string[] = []
		const origWarn = console.warn
		console.warn = (...args: any[]) => warnings.push(args.join(' '))

		try {
			const worker = mockManager('worker')
			dispatcher.addRoutes({ routes: ['  ', '/api/*'] } as any, worker, 'worker')

			expect(dispatcher.getRegisteredRoutes()).toHaveLength(1)
			expect(warnings.some(w => w.includes('empty route pattern'))).toBe(true)
		} finally {
			console.warn = origWarn
		}
	})

	test('multiple routes from same worker all register', () => {
		const fallback = mockManager('main')
		const dispatcher = new RouteDispatcher(fallback)

		const worker = mockManager('multi')
		dispatcher.addRoutes({ routes: ['/api/*', '/auth/*', '/webhooks/stripe'] } as any, worker, 'multi')

		expect(dispatcher.resolve('/api/foo')).toBe(worker)
		expect(dispatcher.resolve('/auth/login')).toBe(worker)
		expect(dispatcher.resolve('/webhooks/stripe')).toBe(worker)
		expect(dispatcher.resolve('/other')).toBe(fallback)
	})

	test('host-scoped routes only match when hostname matches', () => {
		const fallback = mockManager('main')
		const dispatcher = new RouteDispatcher(fallback)

		const hostingWorker = mockManager('hosting')
		dispatcher.addRoutes({ routes: ['*.example.com/*'] } as any, hostingWorker, 'hosting', ['*.localhost'])

		// Without matching host, route should not match
		expect(dispatcher.resolve('/anything', 'localhost')).toBe(fallback)
		// With matching host, route should match
		expect(dispatcher.resolve('/anything', 'site.localhost')).toBe(hostingWorker)
	})

	test('host-scoped routes do not interfere with unscoped routes', () => {
		const fallback = mockManager('main')
		const dispatcher = new RouteDispatcher(fallback)

		const apiWorker = mockManager('api')
		const hostingWorker = mockManager('hosting')

		dispatcher.addRoutes({ routes: ['/api/*'] } as any, apiWorker, 'api')
		dispatcher.addRoutes({ routes: ['*.example.com/*'] } as any, hostingWorker, 'hosting', ['*.localhost'])

		// Unscoped route matches regardless of host
		expect(dispatcher.resolve('/api/foo', 'localhost')).toBe(apiWorker)
		expect(dispatcher.resolve('/api/foo', 'site.localhost')).toBe(apiWorker)
		// Host-scoped route only matches with correct host
		expect(dispatcher.resolve('/other', 'site.localhost')).toBe(hostingWorker)
		expect(dispatcher.resolve('/other', 'localhost')).toBe(fallback)
	})

	test('host-scoped routes with path constraints are respected', () => {
		const fallback = mockManager('main')
		const dispatcher = new RouteDispatcher(fallback)

		const hostingWorker = mockManager('hosting')
		dispatcher.addRoutes({ routes: ['*.example.com/api/*'] } as any, hostingWorker, 'hosting', ['*.localhost'])

		// Matching host + matching path
		expect(dispatcher.resolve('/api/foo', 'site.localhost')).toBe(hostingWorker)
		// Matching host + non-matching path
		expect(dispatcher.resolve('/other', 'site.localhost')).toBe(fallback)
		// Non-matching host + matching path
		expect(dispatcher.resolve('/api/foo', 'localhost')).toBe(fallback)
	})

	test('exact host patterns take priority over wildcard host patterns', () => {
		const fallback = mockManager('main')
		const dispatcher = new RouteDispatcher(fallback)

		const hostingWorker = mockManager('hosting')
		const mainWorker = mockManager('main-hosts')

		// Register wildcard host worker first
		dispatcher.addHostWorker(hostingWorker, 'hosting', ['*.localhost'])
		// Register exact host worker second
		dispatcher.addHostWorker(mainWorker, 'main-hosts', ['admin.localhost', 'localhost'])

		// Exact host match should win over wildcard
		expect(dispatcher.resolve('/', 'admin.localhost')).toBe(mainWorker)
		expect(dispatcher.resolve('/anything', 'admin.localhost')).toBe(mainWorker)
		expect(dispatcher.resolve('/', 'localhost')).toBe(mainWorker)
		// Wildcard should still match other subdomains
		expect(dispatcher.resolve('/', 'site.localhost')).toBe(hostingWorker)
		// No host match falls through to fallback
		expect(dispatcher.resolve('/', 'other.com')).toBe(fallback)
	})

	test('same path pattern with different host scopes both register', () => {
		const fallback = mockManager('main')
		const dispatcher = new RouteDispatcher(fallback)

		const workerA = mockManager('worker-a')
		const workerB = mockManager('worker-b')

		dispatcher.addRoutes({ routes: ['a.example.com/*'] } as any, workerA, 'worker-a', ['a.localhost'])
		dispatcher.addRoutes({ routes: ['b.example.com/*'] } as any, workerB, 'worker-b', ['b.localhost'])

		expect(dispatcher.resolve('/foo', 'a.localhost')).toBe(workerA)
		expect(dispatcher.resolve('/foo', 'b.localhost')).toBe(workerB)
		expect(dispatcher.resolve('/foo', 'other.localhost')).toBe(fallback)
	})
})
