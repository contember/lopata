import { describe, expect, test } from 'bun:test'
import sharp from 'sharp'
import { ImagesBinding } from '../bindings/images'

function toStream(data: Uint8Array): ReadableStream<Uint8Array> {
	return new ReadableStream({
		start(controller) {
			controller.enqueue(data)
			controller.close()
		},
	})
}

// --- Minimal valid image buffers ---

// 1x1 white PNG
const PNG_1X1 = new Uint8Array([
	0x89,
	0x50,
	0x4e,
	0x47,
	0x0d,
	0x0a,
	0x1a,
	0x0a, // PNG signature
	0x00,
	0x00,
	0x00,
	0x0d, // IHDR length
	0x49,
	0x48,
	0x44,
	0x52, // IHDR
	0x00,
	0x00,
	0x00,
	0x01, // width: 1
	0x00,
	0x00,
	0x00,
	0x01, // height: 1
	0x08,
	0x02, // bit depth 8, color type 2 (RGB)
	0x00,
	0x00,
	0x00, // compression, filter, interlace
	0x90,
	0x77,
	0x53,
	0xde, // CRC
])

// Minimal JPEG (SOI + SOF0 frame)
function makeJpeg(width: number, height: number): Uint8Array {
	const buf = new Uint8Array(20)
	const view = new DataView(buf.buffer)
	buf[0] = 0xff
	buf[1] = 0xd8 // SOI
	buf[2] = 0xff
	buf[3] = 0xc0 // SOF0
	view.setUint16(4, 14) // segment length
	buf[6] = 8 // precision
	view.setUint16(7, height)
	view.setUint16(9, width)
	buf[11] = 3 // num components
	return buf
}

// Minimal GIF89a
function makeGif(width: number, height: number): Uint8Array {
	const buf = new Uint8Array(13)
	const view = new DataView(buf.buffer)
	buf[0] = 0x47
	buf[1] = 0x49
	buf[2] = 0x46 // GIF
	buf[3] = 0x38
	buf[4] = 0x39
	buf[5] = 0x61 // 89a
	view.setUint16(6, width, true)
	view.setUint16(8, height, true)
	return buf
}

// Simple SVG
function makeSvg(width: number, height: number): Uint8Array {
	const xml = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="1" height="1"/></svg>`
	return new TextEncoder().encode(xml)
}

// SVG with viewBox only
function makeSvgViewBox(vw: number, vh: number): Uint8Array {
	const xml = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${vw} ${vh}"><rect width="1" height="1"/></svg>`
	return new TextEncoder().encode(xml)
}

// Create a real PNG via Sharp for transform tests
async function makeRealPng(width: number, height: number): Promise<Uint8Array> {
	const buf = await sharp({
		create: { width, height, channels: 3, background: { r: 255, g: 0, b: 0 } },
	}).png().toBuffer()
	return new Uint8Array(buf)
}

// Create a real AVIF via Sharp for AVIF dimension tests
async function makeRealAvif(width: number, height: number): Promise<Uint8Array> {
	const buf = await sharp({
		create: { width, height, channels: 3, background: { r: 0, g: 128, b: 255 } },
	}).avif().toBuffer()
	return new Uint8Array(buf)
}

async function readStreamToBuffer(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
	const reader = stream.getReader()
	const chunks: Uint8Array[] = []
	let totalLength = 0
	while (true) {
		const { done, value } = await reader.read()
		if (done) break
		chunks.push(value)
		totalLength += value.byteLength
	}
	const result = new Uint8Array(totalLength)
	let offset = 0
	for (const chunk of chunks) {
		result.set(chunk, offset)
		offset += chunk.byteLength
	}
	return result
}

let images: ImagesBinding

describe('ImagesBinding', () => {
	images = new ImagesBinding()

	describe('info()', () => {
		test('PNG dimensions and format', async () => {
			const info = await images.info(toStream(PNG_1X1))
			expect(info.format).toBe('image/png')
			expect(info.width).toBe(1)
			expect(info.height).toBe(1)
			expect(info.fileSize).toBe(PNG_1X1.byteLength)
		})

		test('JPEG dimensions and format', async () => {
			const jpeg = makeJpeg(320, 240)
			const info = await images.info(toStream(jpeg))
			expect(info.format).toBe('image/jpeg')
			expect(info.width).toBe(320)
			expect(info.height).toBe(240)
			expect(info.fileSize).toBe(jpeg.byteLength)
		})

		test('GIF dimensions and format', async () => {
			const gif = makeGif(100, 50)
			const info = await images.info(toStream(gif))
			expect(info.format).toBe('image/gif')
			expect(info.width).toBe(100)
			expect(info.height).toBe(50)
		})

		test('SVG with width/height attributes', async () => {
			const svg = makeSvg(800, 600)
			const info = await images.info(toStream(svg))
			expect(info.format).toBe('image/svg+xml')
			expect(info.width).toBe(800)
			expect(info.height).toBe(600)
		})

		test('SVG with viewBox only', async () => {
			const svg = makeSvgViewBox(1024, 768)
			const info = await images.info(toStream(svg))
			expect(info.format).toBe('image/svg+xml')
			expect(info.width).toBe(1024)
			expect(info.height).toBe(768)
		})

		test('unknown format throws', async () => {
			const garbage = new Uint8Array([0x00, 0x01, 0x02, 0x03, 0x04])
			await expect(images.info(toStream(garbage))).rejects.toThrow('Unsupported or unrecognizable image format')
		})

		test('fileSize matches input length', async () => {
			const jpeg = makeJpeg(10, 10)
			const info = await images.info(toStream(jpeg))
			expect(info.fileSize).toBe(jpeg.byteLength)
		})

		test('AVIF dimensions parsed correctly', async () => {
			const avif = await makeRealAvif(64, 48)
			const info = await images.info(toStream(avif))
			expect(info.format).toBe('image/avif')
			expect(info.width).toBe(64)
			expect(info.height).toBe(48)
			expect(info.fileSize).toBe(avif.byteLength)
		})
	})

	describe('input() / transform / output', () => {
		test('passthrough returns valid image data', async () => {
			const data = await makeRealPng(10, 10)
			const result = await images.input(toStream(data)).output({ format: 'image/png' })
			expect(result.contentType()).toBe('image/png')
			const outputBuf = await readStreamToBuffer(result.image())
			expect(outputBuf.byteLength).toBeGreaterThan(0)
		})

		test('transform() is chainable', async () => {
			const data = await makeRealPng(100, 100)
			const transformer = images.input(toStream(data))
			const chained = transformer
				.transform({ width: 50, height: 50 })
				.transform({ rotate: 90 })
			const result = await chained.output({ format: 'image/jpeg' })
			expect(result.contentType()).toBe('image/jpeg')
		})

		test('output format determines contentType', async () => {
			const data = await makeRealPng(10, 10)
			const result = await images
				.input(toStream(data))
				.output({ format: 'image/webp' })
			expect(result.contentType()).toBe('image/webp')
		})

		test('draw() is chainable', async () => {
			const data = await makeRealPng(50, 50)
			const overlay = await makeRealPng(10, 10)
			const result = await images
				.input(toStream(data))
				.draw(toStream(overlay), { top: 0, left: 0, opacity: 0.5 })
				.output({ format: 'image/png' })
			expect(result.contentType()).toBe('image/png')
		})

		test('output().image() returns a readable stream', async () => {
			const data = await makeRealPng(10, 10)
			const result = await images.input(toStream(data)).output({ format: 'image/png' })
			const stream = result.image()
			expect(stream).toBeInstanceOf(ReadableStream)
			const buf = await readStreamToBuffer(stream)
			expect(buf.byteLength).toBeGreaterThan(0)
		})

		test('resize changes output dimensions', async () => {
			const data = await makeRealPng(100, 100)
			const result = await images
				.input(toStream(data))
				.transform({ width: 50, height: 25 })
				.output({ format: 'image/png' })
			const outputBuf = await readStreamToBuffer(result.image())
			const meta = await sharp(Buffer.from(outputBuf)).metadata()
			// With default fit "cover", dimensions should match requested
			expect(meta.width).toBe(50)
			expect(meta.height).toBe(25)
		})

		test('rotate 90 swaps dimensions', async () => {
			const data = await makeRealPng(80, 40)
			const result = await images
				.input(toStream(data))
				.transform({ rotate: 90 })
				.output({ format: 'image/png' })
			const outputBuf = await readStreamToBuffer(result.image())
			const meta = await sharp(Buffer.from(outputBuf)).metadata()
			expect(meta.width).toBe(40)
			expect(meta.height).toBe(80)
		})

		test('rotate 180 preserves dimensions', async () => {
			const data = await makeRealPng(60, 30)
			const result = await images
				.input(toStream(data))
				.transform({ rotate: 180 })
				.output({ format: 'image/png' })
			const outputBuf = await readStreamToBuffer(result.image())
			const meta = await sharp(Buffer.from(outputBuf)).metadata()
			expect(meta.width).toBe(60)
			expect(meta.height).toBe(30)
		})

		test('format conversion PNG to JPEG', async () => {
			const data = await makeRealPng(20, 20)
			const result = await images
				.input(toStream(data))
				.output({ format: 'image/jpeg' })
			const outputBuf = await readStreamToBuffer(result.image())
			// JPEG starts with ff d8
			expect(outputBuf[0]).toBe(0xff)
			expect(outputBuf[1]).toBe(0xd8)
		})

		test('format conversion PNG to WebP', async () => {
			const data = await makeRealPng(20, 20)
			const result = await images
				.input(toStream(data))
				.output({ format: 'image/webp' })
			const outputBuf = await readStreamToBuffer(result.image())
			// WebP starts with RIFF
			expect(outputBuf[0]).toBe(0x52) // R
			expect(outputBuf[1]).toBe(0x49) // I
			expect(outputBuf[2]).toBe(0x46) // F
			expect(outputBuf[3]).toBe(0x46) // F
		})

		test('format conversion PNG to AVIF', async () => {
			const data = await makeRealPng(20, 20)
			const result = await images
				.input(toStream(data))
				.output({ format: 'image/avif' })
			const outputBuf = await readStreamToBuffer(result.image())
			// AVIF has ftyp box
			expect(outputBuf[4]).toBe(0x66) // f
			expect(outputBuf[5]).toBe(0x74) // t
			expect(outputBuf[6]).toBe(0x79) // y
			expect(outputBuf[7]).toBe(0x70) // p
		})

		test('quality affects output size for JPEG', async () => {
			const data = await makeRealPng(100, 100)
			const highQ = await images
				.input(toStream(data))
				.output({ format: 'image/jpeg', quality: 95 })
			const lowQ = await images
				.input(toStream(data))
				.output({ format: 'image/jpeg', quality: 10 })
			const highBuf = await readStreamToBuffer(highQ.image())
			const lowBuf = await readStreamToBuffer(lowQ.image())
			expect(highBuf.byteLength).toBeGreaterThan(lowBuf.byteLength)
		})

		test('draw() composites overlay onto image', async () => {
			const base = await makeRealPng(50, 50)
			const overlay = await makeRealPng(10, 10)
			const result = await images
				.input(toStream(base))
				.draw(toStream(overlay), { top: 5, left: 5 })
				.output({ format: 'image/png' })
			const outputBuf = await readStreamToBuffer(result.image())
			// Verify it's a valid PNG and has the right dimensions
			const meta = await sharp(Buffer.from(outputBuf)).metadata()
			expect(meta.width).toBe(50)
			expect(meta.height).toBe(50)
		})

		test('draw() with repeat tiles the overlay', async () => {
			const base = await makeRealPng(50, 50)
			const overlay = await makeRealPng(10, 10)
			const result = await images
				.input(toStream(base))
				.draw(toStream(overlay), { repeat: 'repeat' })
				.output({ format: 'image/png' })
			const outputBuf = await readStreamToBuffer(result.image())
			const meta = await sharp(Buffer.from(outputBuf)).metadata()
			expect(meta.width).toBe(50)
			expect(meta.height).toBe(50)
		})

		test('combined resize + rotate + format', async () => {
			const data = await makeRealPng(200, 100)
			const result = await images
				.input(toStream(data))
				.transform({ width: 100, height: 50 })
				.transform({ rotate: 90 })
				.output({ format: 'image/webp' })
			const outputBuf = await readStreamToBuffer(result.image())
			const meta = await sharp(Buffer.from(outputBuf)).metadata()
			// Resize to 100x50, then rotate 90 → 50x100
			expect(meta.width).toBe(50)
			expect(meta.height).toBe(100)
			expect(meta.format).toBe('webp')
		})
	})
})
