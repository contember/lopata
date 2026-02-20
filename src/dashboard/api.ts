import { join } from 'node:path'

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

export function handleDashboardRequest(request: Request): Response {
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

	return new Response('Not found', { status: 404 })
}
