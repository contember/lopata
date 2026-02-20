import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { getDatabase, getDataDir } from '../db'
import { withCors } from './cors'

export async function handleR2Upload(request: Request): Promise<Response> {
	try {
		const formData = await request.formData()
		const bucket = formData.get('bucket') as string
		const key = formData.get('key') as string
		const file = formData.get('file') as File

		if (!bucket || !key || !file) {
			return withCors(Response.json({ error: 'Missing bucket, key, or file' }, { status: 400 }))
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

		return withCors(Response.json({ ok: true }))
	} catch (err) {
		console.error('[lopata api] R2 upload error:', err)
		return withCors(Response.json({ error: String(err) }, { status: 500 }))
	}
}

export function handleR2Download(url: URL): Response {
	const bucket = url.searchParams.get('bucket')
	const key = url.searchParams.get('key')

	if (!bucket || !key) {
		return withCors(Response.json({ error: 'Missing bucket or key' }, { status: 400 }))
	}

	const fp = join(getDataDir(), 'r2', bucket, key)
	const file = Bun.file(fp)

	if (!existsSync(fp)) {
		return withCors(new Response('Not found', { status: 404 }))
	}

	const filename = key.split('/').pop() ?? key
	const response = new Response(file as unknown as BodyInit, {
		headers: {
			'Content-Disposition': `attachment; filename="${filename}"`,
			'Content-Type': file.type || 'application/octet-stream',
		},
	})
	return withCors(response)
}
