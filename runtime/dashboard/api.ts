import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { WranglerConfig } from '../config'
import { getDatabase, getDataDir } from '../db'
import type { GenerationManager } from '../generation-manager'
import type { WorkerRegistry } from '../worker-registry'
import { dispatch } from './rpc/server'
import type { HandlerContext } from './rpc/types'

const ctx: HandlerContext = { config: null, manager: null, registry: null }

export function setDashboardConfig(config: WranglerConfig): void {
	ctx.config = config
}

export function setGenerationManager(manager: GenerationManager): void {
	ctx.manager = manager
}

export function setWorkerRegistry(registry: WorkerRegistry): void {
	ctx.registry = registry
}

// ─── Pre-built dashboard assets ──────────────────────────────────────────
// We use Bun.build() with bun-plugin-tailwind to pre-build the dashboard
// so Tailwind CSS works regardless of the CWD where bunflare is launched.

let dashboardAssets: Map<string, { content: Uint8Array; contentType: string }> | null = null
let dashboardHtmlContent: string | null = null

async function buildDashboard(): Promise<void> {
	const tailwindPlugin = (await import('bun-plugin-tailwind')).default
	const htmlEntry = join(import.meta.dir, 'index.html')

	const result = await Bun.build({
		entrypoints: [htmlEntry],
		plugins: [tailwindPlugin],
	})

	if (!result.success) {
		console.error('[bunflare] Dashboard build failed:', result.logs)
		throw new Error('Dashboard build failed')
	}

	const assets = new Map<string, { content: Uint8Array; contentType: string }>()
	let html = ''

	for (const output of result.outputs) {
		const name = output.path.split('/').pop()!
		const content = new Uint8Array(await output.arrayBuffer())

		if (output.kind === 'entry-point' && name.endsWith('.html')) {
			html = new TextDecoder().decode(content)
		} else {
			const contentType = name.endsWith('.css')
				? 'text/css'
				: name.endsWith('.js')
				? 'application/javascript'
				: 'application/octet-stream'
			assets.set(name, { content, contentType })
		}
	}

	// Rewrite asset paths in HTML from "./chunk-xxx" to "/__dashboard/assets/chunk-xxx"
	for (const name of assets.keys()) {
		html = html.replaceAll(`./${name}`, `/__dashboard/assets/${name}`)
	}

	dashboardHtmlContent = html
	dashboardAssets = assets
}

// Build on import
await buildDashboard()

export function handleDashboardRequest(request: Request): Response | Promise<Response> {
	const url = new URL(request.url)

	// Serve dashboard HTML
	if (url.pathname === '/__dashboard') {
		return new Response(dashboardHtmlContent, {
			headers: { 'Content-Type': 'text/html; charset=utf-8' },
		})
	}

	// Serve dashboard assets (JS, CSS)
	const assetMatch = url.pathname.match(/^\/__dashboard\/assets\/(.+)$/)
	if (assetMatch && dashboardAssets) {
		const asset = dashboardAssets.get(assetMatch[1]!)
		if (asset) {
			return new Response(asset.content as unknown as BodyInit, {
				headers: {
					'Content-Type': asset.contentType,
					'Cache-Control': 'public, max-age=31536000, immutable',
				},
			})
		}
	}

	// RPC endpoint
	if (url.pathname === '/__dashboard/api/rpc' && request.method === 'POST') {
		return dispatch(request, ctx)
	}

	// R2 upload (multipart/form-data)
	if (url.pathname === '/__dashboard/api/r2/upload' && request.method === 'POST') {
		return handleR2Upload(request)
	}

	// R2 download
	if (url.pathname === '/__dashboard/api/r2/download' && request.method === 'GET') {
		return handleR2Download(url)
	}

	return new Response('Not found', { status: 404 })
}

async function handleR2Upload(request: Request): Promise<Response> {
	try {
		const formData = await request.formData()
		const bucket = formData.get('bucket') as string
		const key = formData.get('key') as string
		const file = formData.get('file') as File

		if (!bucket || !key || !file) {
			return Response.json({ error: 'Missing bucket, key, or file' }, { status: 400 })
		}

		const data = await file.arrayBuffer()
		const fp = join(getDataDir(), 'r2', bucket, key)
		mkdirSync(dirname(fp), { recursive: true })
		await Bun.write(fp, data)

		const hasher = new Bun.CryptoHasher('md5')
		hasher.update(new Uint8Array(data))
		const etag = hasher.digest('hex')

		const db = getDatabase()
		db.run(
			`INSERT OR REPLACE INTO r2_objects (bucket, key, size, etag, version, uploaded, http_metadata, custom_metadata)
       VALUES (?, ?, ?, ?, ?, ?, NULL, NULL)`,
			[bucket, key, data.byteLength, etag, crypto.randomUUID(), new Date().toISOString()],
		)

		return Response.json({ ok: true })
	} catch (err) {
		console.error('[bunflare dashboard] R2 upload error:', err)
		return Response.json({ error: String(err) }, { status: 500 })
	}
}

function handleR2Download(url: URL): Response {
	const bucket = url.searchParams.get('bucket')
	const key = url.searchParams.get('key')

	if (!bucket || !key) {
		return Response.json({ error: 'Missing bucket or key' }, { status: 400 })
	}

	const fp = join(getDataDir(), 'r2', bucket, key)
	const file = Bun.file(fp)

	if (!existsSync(fp)) {
		return new Response('Not found', { status: 404 })
	}

	const filename = key.split('/').pop() ?? key
	return new Response(file as unknown as BodyInit, {
		headers: {
			'Content-Disposition': `attachment; filename="${filename}"`,
			'Content-Type': file.type || 'application/octet-stream',
		},
	})
}
