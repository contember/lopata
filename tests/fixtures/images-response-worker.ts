import type { ImagesBinding } from '../../src/bindings/images'

export default {
	async fetch(request: Request, env: { IMAGES: ImagesBinding }): Promise<Response> {
		if (!request.body) return new Response('Image body required', { status: 400 })
		const result = await env.IMAGES.input(request.body)
			.transform({ width: 12, height: 6 })
			.output({ format: 'image/webp' })
		return result.response({ headers: { 'Content-Type': 'text/html', 'X-Image-Worker': 'transformed', 'Cache-Control': 'public, max-age=60' } })
	},
}
