import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { MediaBinding } from '../src/bindings/media'

let binding: MediaBinding

beforeEach(() => {
	binding = new MediaBinding()
})

function streamFrom(data: Uint8Array): ReadableStream<Uint8Array> {
	return new ReadableStream({
		start(controller) {
			controller.enqueue(data)
			controller.close()
		},
	})
}

// Check if ffmpeg is available for integration tests
let ffmpegAvailable = false
try {
	const proc = Bun.spawn(['ffmpeg', '-version'], { stdout: 'ignore', stderr: 'ignore' })
	ffmpegAvailable = (await proc.exited) === 0
} catch {
	ffmpegAvailable = false
}

describe('MediaBinding', () => {
	test('input returns a transformer with chainable API', () => {
		const stream = streamFrom(new Uint8Array([1, 2, 3]))
		const transformer = binding.input(stream)
		expect(transformer).toBeDefined()
		expect(typeof transformer.transform).toBe('function')
		expect(typeof transformer.output).toBe('function')
	})

	test('transform is chainable', () => {
		const stream = streamFrom(new Uint8Array([1, 2, 3]))
		const transformer = binding.input(stream)
		const result = transformer.transform({ width: 480, height: 270 })
		expect(result).toBe(transformer)
	})

	test('output returns an object with response method', () => {
		const stream = streamFrom(new Uint8Array([1, 2, 3]))
		const result = binding.input(stream).output({ mode: 'video' })
		expect(typeof result.response).toBe('function')
	})

	test('multiple transforms are chainable', () => {
		const stream = streamFrom(new Uint8Array([1, 2, 3]))
		const transformer = binding.input(stream)
			.transform({ width: 1920 })
			.transform({ height: 1080 })
		expect(transformer).toBeDefined()
	})
})

// Generate a real test video with ffmpeg for integration tests
let testVideoData: Uint8Array | null = null

async function getTestVideo(): Promise<Uint8Array> {
	if (testVideoData) return testVideoData
	const proc = Bun.spawn(
		[
			'ffmpeg',
			'-hide_banner',
			'-loglevel',
			'error',
			'-f',
			'lavfi',
			'-i',
			'testsrc=duration=2:size=320x240:rate=10',
			'-f',
			'lavfi',
			'-i',
			'sine=frequency=440:duration=2',
			'-c:v',
			'libx264',
			'-preset',
			'ultrafast',
			'-pix_fmt',
			'yuv420p',
			'-c:a',
			'aac',
			'-shortest',
			'-movflags',
			'+frag_keyframe+empty_moov',
			'-f',
			'mp4',
			'pipe:1',
		],
		{ stdout: 'pipe', stderr: 'pipe' },
	)
	const [output, exitCode] = await Promise.all([
		new Response(proc.stdout).arrayBuffer(),
		proc.exited,
	])
	if (exitCode !== 0) throw new Error('Failed to generate test video')
	testVideoData = new Uint8Array(output)
	return testVideoData
}

describe.if(ffmpegAvailable)('MediaBinding with ffmpeg', () => {
	test('video mode returns mp4', async () => {
		const video = await getTestVideo()
		const response = await binding.input(streamFrom(video))
			.output({ mode: 'video' })
			.response()

		expect(response).toBeInstanceOf(Response)
		expect(response.headers.get('content-type')).toBe('video/mp4')
		const body = new Uint8Array(await response.arrayBuffer())
		expect(body.length).toBeGreaterThan(0)
	})

	test('video mode with transform resizes', async () => {
		const video = await getTestVideo()
		const response = await binding.input(streamFrom(video))
			.transform({ width: 160, height: 120 })
			.output({ mode: 'video' })
			.response()

		expect(response.headers.get('content-type')).toBe('video/mp4')
		const body = new Uint8Array(await response.arrayBuffer())
		expect(body.length).toBeGreaterThan(0)
	})

	test('video mode with duration trims', async () => {
		const video = await getTestVideo()
		const full = await binding.input(streamFrom(video))
			.output({ mode: 'video' })
			.response()
		const trimmed = await binding.input(streamFrom(video))
			.output({ mode: 'video', duration: '1' })
			.response()

		const fullSize = (await full.arrayBuffer()).byteLength
		const trimmedSize = (await trimmed.arrayBuffer()).byteLength
		expect(trimmedSize).toBeLessThan(fullSize)
	})

	test('frame mode extracts a still image', async () => {
		const video = await getTestVideo()
		const response = await binding.input(streamFrom(video))
			.output({ mode: 'frame' })
			.response()

		expect(response.headers.get('content-type')).toBe('image/png')
		const body = new Uint8Array(await response.arrayBuffer())
		// Check PNG magic bytes
		expect(body[0]).toBe(0x89)
		expect(body[1]).toBe(0x50) // P
		expect(body[2]).toBe(0x4e) // N
		expect(body[3]).toBe(0x47) // G
	})

	test('frame mode with jpeg format', async () => {
		const video = await getTestVideo()
		const response = await binding.input(streamFrom(video))
			.output({ mode: 'frame', format: 'jpeg' })
			.response()

		expect(response.headers.get('content-type')).toBe('image/jpeg')
		const body = new Uint8Array(await response.arrayBuffer())
		// JPEG magic bytes
		expect(body[0]).toBe(0xff)
		expect(body[1]).toBe(0xd8)
	})

	test('frame mode with offset', async () => {
		const video = await getTestVideo()
		const response = await binding.input(streamFrom(video))
			.output({ mode: 'frame', offset: '1' })
			.response()

		expect(response.headers.get('content-type')).toBe('image/png')
		const body = new Uint8Array(await response.arrayBuffer())
		expect(body.length).toBeGreaterThan(0)
	})

	test('spritesheet mode generates a tiled image', async () => {
		const video = await getTestVideo()
		const response = await binding.input(streamFrom(video))
			.output({ mode: 'spritesheet', fps: 2, columns: 3, rows: 2 })
			.response()

		expect(response.headers.get('content-type')).toBe('image/png')
		const body = new Uint8Array(await response.arrayBuffer())
		expect(body[0]).toBe(0x89)
		expect(body[1]).toBe(0x50)
	})

	test('audio mode extracts audio as m4a', async () => {
		const video = await getTestVideo()
		const response = await binding.input(streamFrom(video))
			.output({ mode: 'audio' })
			.response()

		expect(response.headers.get('content-type')).toBe('audio/mp4')
		const body = new Uint8Array(await response.arrayBuffer())
		expect(body.length).toBeGreaterThan(0)
	})

	test('transform with cover fit and crop', async () => {
		const video = await getTestVideo()
		const response = await binding.input(streamFrom(video))
			.transform({ width: 100, height: 100, fit: 'cover' })
			.output({ mode: 'frame' })
			.response()

		expect(response.headers.get('content-type')).toBe('image/png')
		const body = new Uint8Array(await response.arrayBuffer())
		expect(body.length).toBeGreaterThan(0)
	})

	test('transform with trim start/end', async () => {
		const video = await getTestVideo()
		const response = await binding.input(streamFrom(video))
			.transform({ trim: { start: '0.5', end: '1.5' } })
			.output({ mode: 'video' })
			.response()

		expect(response.headers.get('content-type')).toBe('video/mp4')
		const body = new Uint8Array(await response.arrayBuffer())
		expect(body.length).toBeGreaterThan(0)
	})

	test('ffmpeg error throws', async () => {
		const response = binding.input(streamFrom(new Uint8Array([1, 2, 3])))
			.output({ mode: 'video' })
			.response()

		await expect(response).rejects.toThrow('[lopata] ffmpeg failed')
	})
})
