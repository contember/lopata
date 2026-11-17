import { FileR2Bucket, R2ObjectBody } from '../bindings/r2'
import { getDatabase, getDataDir } from '../db'
import { withCors } from './cors'

function openBucket(bucket: string): FileR2Bucket {
	return new FileR2Bucket(getDatabase(), bucket, getDataDir())
}

export async function handleR2Upload(request: Request): Promise<Response> {
	try {
		const formData = await request.formData()
		const bucket = formData.get('bucket') as string
		const key = formData.get('key') as string
		const file = formData.get('file') as File

		if (!bucket || !key || !file) {
			return withCors(Response.json({ error: 'Missing bucket, key, or file' }, { status: 400 }))
		}

		await openBucket(bucket).put(key, await file.arrayBuffer())

		return withCors(Response.json({ ok: true }))
	} catch (err) {
		console.error('[lopata api] R2 upload error:', err)
		return withCors(Response.json({ error: String(err) }, { status: 500 }))
	}
}

export async function handleR2Download(url: URL): Promise<Response> {
	const bucket = url.searchParams.get('bucket')
	const key = url.searchParams.get('key')

	if (!bucket || !key) {
		return withCors(Response.json({ error: 'Missing bucket or key' }, { status: 400 }))
	}

	const object = await openBucket(bucket).get(key)
	if (!(object instanceof R2ObjectBody)) {
		return withCors(new Response('Not found', { status: 404 }))
	}

	const filename = key.split('/').pop() ?? key
	const response = new Response(object.body, {
		headers: {
			'Content-Disposition': `attachment; filename="${filename}"`,
			// Without a stored content type, guess from the key's extension
			'Content-Type': object.httpMetadata?.contentType || Bun.file(filename).type || 'application/octet-stream',
		},
	})
	return withCors(response)
}
