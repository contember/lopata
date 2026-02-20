#!/usr/bin/env bun
/**
 * Pre-build dashboard and error-page assets for npm publishing.
 * Output goes to dist/dashboard/ and dist/error-page.html.
 */
import { join } from 'node:path'
import { readdirSync, rmSync } from 'node:fs'
import tailwindPlugin from 'bun-plugin-tailwind'

const rootDir = join(import.meta.dir, '..')
const distDir = join(rootDir, 'dist')

// Clean dist/
rmSync(distDir, { recursive: true, force: true })

// ─── Dashboard ───────────────────────────────────────────────────────────────

const dashboardResult = await Bun.build({
	entrypoints: [join(rootDir, 'src/dashboard/index.html')],
	plugins: [tailwindPlugin],
})

if (!dashboardResult.success) {
	console.error('Dashboard build failed:', dashboardResult.logs)
	process.exit(1)
}

const dashboardDir = join(distDir, 'dashboard')

const assetNames: string[] = []
let dashboardHtml = ''

for (const output of dashboardResult.outputs) {
	const name = output.path.split('/').pop()!
	if (output.kind === 'entry-point' && name.endsWith('.html')) {
		dashboardHtml = await output.text()
	} else {
		assetNames.push(name)
		await Bun.write(join(dashboardDir, name), output)
	}
}

// Rewrite asset paths: ./chunk-xxx → /__dashboard/assets/chunk-xxx
for (const name of assetNames) {
	dashboardHtml = dashboardHtml.replaceAll(`./${name}`, `/__dashboard/assets/${name}`)
}

await Bun.write(join(dashboardDir, 'index.html'), dashboardHtml)
console.log('Built dist/dashboard/')
for (const entry of readdirSync(dashboardDir)) {
	console.log(`  ${entry}`)
}

// ─── Error page ──────────────────────────────────────────────────────────────

const errorResult = await Bun.build({
	entrypoints: [join(rootDir, 'src/error-page/index.html')],
	plugins: [tailwindPlugin],
})

if (!errorResult.success) {
	console.error('Error page build failed:', errorResult.logs)
	process.exit(1)
}

const assets = new Map<string, { content: Uint8Array; contentType: string }>()
let errorHtml = ''

for (const output of errorResult.outputs) {
	const name = output.path.split('/').pop()!
	const content = new Uint8Array(await output.arrayBuffer())
	if (output.kind === 'entry-point' && name.endsWith('.html')) {
		errorHtml = new TextDecoder().decode(content)
	} else {
		const contentType = name.endsWith('.css')
			? 'text/css'
			: name.endsWith('.js')
				? 'application/javascript'
				: 'application/octet-stream'
		assets.set(name, { content, contentType })
	}
}

// Inline all CSS/JS into the HTML to make it self-contained
for (const [name, asset] of assets) {
	const assetText = new TextDecoder().decode(asset.content)
	if (name.endsWith('.css')) {
		errorHtml = errorHtml.replace(
			new RegExp(`<link[^>]*href="\\./${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"[^>]*/?>`),
			`<style>${assetText}</style>`,
		)
	} else if (name.endsWith('.js')) {
		errorHtml = errorHtml.replace(
			new RegExp(`<script[^>]*src="\\./${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"[^>]*>[^<]*</script>`),
			`<script type="module">${assetText}</script>`,
		)
	}
}

await Bun.write(join(distDir, 'error-page.html'), errorHtml)
console.log('Built dist/error-page.html')
