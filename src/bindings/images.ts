// Images binding — Sharp-based implementation for local dev
// Supports resize, rotate, format conversion, quality, draw overlays, and AVIF dimensions.

import type SharpNs from 'sharp'

type ImageFormat = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp' | 'image/avif' | 'image/svg+xml'

export interface ImageInfo {
	width: number
	height: number
	format: ImageFormat
	fileSize: number
}

export interface ImageTransformOptions {
	width?: number
	height?: number
	fit?: 'contain' | 'cover' | 'crop' | 'scale-down' | 'pad'
	gravity?: 'auto' | 'left' | 'right' | 'top' | 'bottom' | 'center' | { x: number; y: number }
	rotate?: 0 | 90 | 180 | 270
	blur?: number
	brightness?: number
	contrast?: number
	gamma?: number
	saturation?: number
	sharpen?: number
	trim?: number | boolean
	flip?: boolean
	flop?: boolean
	background?: string
	dpr?: number
	border?: { color?: string; width?: number; top?: number; right?: number; bottom?: number; left?: number }
	format?: 'avif' | 'webp' | 'jpeg' | 'png' | 'gif' | 'auto'
	quality?: number | 'high' | 'medium-high' | 'medium-low' | 'low'
}

export interface DrawOptions {
	top?: number
	left?: number
	bottom?: number
	right?: number
	opacity?: number
	repeat?: 'repeat' | 'no-repeat'
}

export interface OutputOptions {
	format: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/avif' | 'image/gif'
	quality?: number | 'high' | 'medium-high' | 'medium-low' | 'low'
	compression?: 'fast'
	metadata?: 'keep' | 'copyright' | 'none'
}

export interface ImageOutputResult {
	image(): ReadableStream<Uint8Array>
	contentType(): string
}

// --- Lazy sharp loading ---

let _sharpResolved = false
let _sharp: typeof SharpNs | null = null
let _sharpWarned = false

async function getSharp(): Promise<typeof SharpNs | null> {
	if (!_sharpResolved) {
		try {
			_sharp = (await import('sharp')).default
		} catch {
			_sharp = null
		}
		_sharpResolved = true
	}
	return _sharp
}

function warnSharpMissing() {
	if (!_sharpWarned) {
		console.warn('[lopata] sharp is not installed — image transformations will pass through unchanged. Install it: bun add sharp')
		_sharpWarned = true
	}
}

function passthroughResult(buf: Uint8Array, format: string): ImageOutputResult {
	return {
		image(): ReadableStream<Uint8Array> {
			return new ReadableStream({
				start(controller) {
					controller.enqueue(buf)
					controller.close()
				},
			})
		},
		contentType(): string {
			return format
		},
	}
}

// --- PNG header parsing ---

function parsePngSize(buf: Uint8Array): { width: number; height: number } | null {
	if (buf.length < 24) return null
	if (buf[0] !== 0x89 || buf[1] !== 0x50 || buf[2] !== 0x4e || buf[3] !== 0x47) return null
	const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
	return { width: view.getUint32(16), height: view.getUint32(20) }
}

// --- JPEG header parsing ---

function parseJpegSize(buf: Uint8Array): { width: number; height: number } | null {
	if (buf.length < 2 || buf[0] !== 0xff || buf[1] !== 0xd8) return null
	const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
	let offset = 2
	while (offset + 4 < buf.length) {
		if (buf[offset] !== 0xff) break
		const marker = buf[offset + 1]!
		if (
			(marker >= 0xc0 && marker <= 0xc3)
			|| (marker >= 0xc5 && marker <= 0xc7)
			|| (marker >= 0xc9 && marker <= 0xcb)
			|| (marker >= 0xcd && marker <= 0xcf)
		) {
			if (offset + 9 > buf.length) return null
			const height = view.getUint16(offset + 5)
			const width = view.getUint16(offset + 7)
			return { width, height }
		}
		const segLen = view.getUint16(offset + 2)
		offset += 2 + segLen
	}
	return null
}

// --- GIF header parsing ---

function parseGifSize(buf: Uint8Array): { width: number; height: number } | null {
	if (buf.length < 10) return null
	if (buf[0] !== 0x47 || buf[1] !== 0x49 || buf[2] !== 0x46) return null
	const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
	return { width: view.getUint16(6, true), height: view.getUint16(8, true) }
}

// --- WebP header parsing ---

function parseWebpSize(buf: Uint8Array): { width: number; height: number } | null {
	if (buf.length < 30) return null
	if (buf[0] !== 0x52 || buf[1] !== 0x49 || buf[2] !== 0x46 || buf[3] !== 0x46) return null
	if (buf[8] !== 0x57 || buf[9] !== 0x45 || buf[10] !== 0x42 || buf[11] !== 0x50) return null
	const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
	if (buf[12] === 0x56 && buf[13] === 0x50 && buf[14] === 0x38 && buf[15] === 0x20) {
		if (buf.length < 30) return null
		const width = view.getUint16(26, true) & 0x3fff
		const height = view.getUint16(28, true) & 0x3fff
		return { width, height }
	}
	if (buf[12] === 0x56 && buf[13] === 0x50 && buf[14] === 0x38 && buf[15] === 0x4c) {
		if (buf.length < 25) return null
		const b0 = buf[21]!
		const b1 = buf[22]!
		const b2 = buf[23]!
		const b3 = buf[24]!
		const width = 1 + (((b1 & 0x3f) << 8) | b0)
		const height = 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 >> 6) & 0x03))
		return { width, height }
	}
	if (buf[12] === 0x56 && buf[13] === 0x50 && buf[14] === 0x38 && buf[15] === 0x58) {
		if (buf.length < 30) return null
		const width = 1 + (buf[24]! | (buf[25]! << 8) | (buf[26]! << 16))
		const height = 1 + (buf[27]! | (buf[28]! << 8) | (buf[29]! << 16))
		return { width, height }
	}
	return null
}

// --- SVG parsing ---

function parseSvgSize(text: string): { width: number; height: number } | null {
	const svgMatch = text.match(/<svg[^>]*>/i)
	if (!svgMatch) return null
	const tag = svgMatch[0]
	const wMatch = tag.match(/\bwidth\s*=\s*"(\d+)(?:px)?"/)
	const hMatch = tag.match(/\bheight\s*=\s*"(\d+)(?:px)?"/)
	if (wMatch?.[1] && hMatch?.[1]) {
		return { width: parseInt(wMatch[1], 10), height: parseInt(hMatch[1], 10) }
	}
	const vbMatch = tag.match(/\bviewBox\s*=\s*"([^"]+)"/)
	if (vbMatch?.[1]) {
		const parts = vbMatch[1].trim().split(/[\s,]+/)
		if (parts.length >= 4) {
			return { width: Math.round(parseFloat(parts[2]!)), height: Math.round(parseFloat(parts[3]!)) }
		}
	}
	return null
}

// --- AVIF/HEIF container dimension parsing ---

function parseAvifSize(buf: Uint8Array): { width: number; height: number } | null {
	// AVIF uses the ISOBMFF (ISO Base Media File Format) container.
	// We look for the 'ispe' (ImageSpatialExtentsProperty) box which contains width/height.
	// Format: 4-byte size, 4-byte type, then for 'ispe': 4-byte version/flags, 4-byte width, 4-byte height
	if (buf.length < 12) return null
	const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)

	// Scan for 'ispe' box type (0x69 0x73 0x70 0x65)
	for (let i = 0; i <= buf.length - 20; i++) {
		if (buf[i + 4] === 0x69 && buf[i + 5] === 0x73 && buf[i + 6] === 0x70 && buf[i + 7] === 0x65) {
			// Found 'ispe' box. offset i: size(4) type(4) version+flags(4) width(4) height(4)
			if (i + 20 > buf.length) return null
			const width = view.getUint32(i + 12)
			const height = view.getUint32(i + 16)
			if (width > 0 && height > 0 && width < 65536 && height < 65536) {
				return { width, height }
			}
		}
	}
	return null
}

// --- Detect format from bytes ---

function detectFormat(buf: Uint8Array): ImageFormat | null {
	if (buf.length < 4) return null
	if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png'
	if (buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg'
	if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return 'image/gif'
	if (
		buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 && buf.length >= 12 && buf[8] === 0x57 && buf[9] === 0x45
		&& buf[10] === 0x42 && buf[11] === 0x50
	) return 'image/webp'
	if (buf.length >= 12 && buf[4] === 0x66 && buf[5] === 0x74 && buf[6] === 0x79 && buf[7] === 0x70) {
		const brand = String.fromCharCode(buf[8]!, buf[9]!, buf[10]!, buf[11]!)
		if (brand === 'avif' || brand === 'avis') return 'image/avif'
	}
	const start = new TextDecoder().decode(buf.subarray(0, Math.min(buf.length, 256)))
	if (start.includes('<svg') || start.includes('<?xml')) return 'image/svg+xml'
	return null
}

// --- Parse dimensions ---

function parseDimensions(buf: Uint8Array, format: ImageFormat): { width: number; height: number } | null {
	switch (format) {
		case 'image/png':
			return parsePngSize(buf)
		case 'image/jpeg':
			return parseJpegSize(buf)
		case 'image/gif':
			return parseGifSize(buf)
		case 'image/webp':
			return parseWebpSize(buf)
		case 'image/svg+xml':
			return parseSvgSize(new TextDecoder().decode(buf))
		case 'image/avif':
			return parseAvifSize(buf)
		default:
			return null
	}
}

async function readStream(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
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

// --- Sharp format mapping ---

const MIME_TO_SHARP: Record<string, 'png' | 'jpeg' | 'webp' | 'avif' | 'gif'> = {
	'image/png': 'png',
	'image/jpeg': 'jpeg',
	'image/webp': 'webp',
	'image/avif': 'avif',
	'image/gif': 'gif',
}

const CF_FIT_TO_SHARP: Record<string, 'contain' | 'cover' | 'fill' | 'inside' | 'outside'> = {
	contain: 'contain',
	cover: 'cover',
	crop: 'cover',
	'scale-down': 'inside',
	pad: 'contain',
}

const QUALITY_PRESETS: Record<string, number> = {
	high: 85,
	'medium-high': 72,
	'medium-low': 50,
	low: 30,
}

function resolveQuality(q: number | string | undefined): number | undefined {
	if (q === undefined) return undefined
	if (typeof q === 'number') return q
	return QUALITY_PRESETS[q]
}

const CF_GRAVITY_TO_SHARP: Record<string, string> = {
	auto: 'attention',
	center: 'centre',
	left: 'west',
	right: 'east',
	top: 'north',
	bottom: 'south',
}

// --- LazyImageTransformer: Sharp-based ---

class LazyImageTransformer {
	private streamPromise: Promise<Uint8Array>
	private transforms: ImageTransformOptions[] = []
	private overlays: { streamPromise: Promise<Uint8Array>; options?: DrawOptions }[] = []

	constructor(stream: ReadableStream<Uint8Array>) {
		this.streamPromise = readStream(stream)
	}

	transform(options: ImageTransformOptions): LazyImageTransformer {
		this.transforms.push(options)
		return this
	}

	draw(image: ReadableStream<Uint8Array>, options?: DrawOptions): LazyImageTransformer {
		this.overlays.push({ streamPromise: readStream(image), options })
		return this
	}

	async output(options: OutputOptions): Promise<ImageOutputResult> {
		const sharp = await getSharp()
		if (!sharp) {
			warnSharpMissing()
			return passthroughResult(await this.streamPromise, options.format)
		}

		let currentBuf = Buffer.from(await this.streamPromise)
		let transformFormat: string | undefined

		// Apply each transform as a separate Sharp pipeline to ensure correct ordering
		// (Sharp internally reorders operations within a single pipeline)
		for (const t of this.transforms) {
			if (t.format) transformFormat = t.format
			let pipeline = sharp(currentBuf)

			// DPR: multiply dimensions before resize
			let effectiveWidth = t.width
			let effectiveHeight = t.height
			if (t.dpr && t.dpr !== 1) {
				if (effectiveWidth) effectiveWidth = Math.round(effectiveWidth * t.dpr)
				if (effectiveHeight) effectiveHeight = Math.round(effectiveHeight * t.dpr)
			}

			if (t.rotate !== undefined && t.rotate !== 0) {
				pipeline = pipeline.rotate(t.rotate)
			}
			if (t.flip) {
				pipeline = pipeline.flip()
			}
			if (t.flop) {
				pipeline = pipeline.flop()
			}
			if (effectiveWidth !== undefined || effectiveHeight !== undefined) {
				const fitVal = t.fit ? CF_FIT_TO_SHARP[t.fit] ?? 'cover' : 'cover'
				const resizeOpts: SharpNs.ResizeOptions = { fit: fitVal }
				if (t.background) resizeOpts.background = t.background
				// Map gravity for resize positioning
				if (t.gravity) {
					if (typeof t.gravity === 'string') {
						const mapped = CF_GRAVITY_TO_SHARP[t.gravity]
						if (mapped) resizeOpts.position = mapped as any
					} else {
						// { x, y } — Sharp doesn't directly support arbitrary x,y so use percentage-based
						resizeOpts.position = `${Math.round(t.gravity.x * 100)}% ${Math.round(t.gravity.y * 100)}%` as any
					}
				}
				pipeline = pipeline.resize(effectiveWidth ?? null, effectiveHeight ?? null, resizeOpts)
			}
			if (t.blur !== undefined && t.blur > 0) {
				pipeline = pipeline.blur(Math.max(t.blur, 0.3))
			}
			if (t.sharpen !== undefined && t.sharpen > 0) {
				pipeline = pipeline.sharpen(t.sharpen)
			}
			// Brightness and saturation via modulate
			if ((t.brightness !== undefined && t.brightness !== 1) || (t.saturation !== undefined && t.saturation !== 1)) {
				const modulateOpts: { brightness?: number; saturation?: number } = {}
				if (t.brightness !== undefined) modulateOpts.brightness = t.brightness
				if (t.saturation !== undefined) modulateOpts.saturation = t.saturation
				pipeline = pipeline.modulate(modulateOpts)
			}
			// Contrast via linear transform: output = contrast * input + (128 * (1 - contrast))
			if (t.contrast !== undefined && t.contrast !== 1) {
				pipeline = pipeline.linear(t.contrast, 128 * (1 - t.contrast))
			}
			// Gamma
			if (t.gamma !== undefined && t.gamma !== 1) {
				pipeline = pipeline.gamma(t.gamma)
			}
			// Trim — CF's trim is a threshold value
			if (t.trim !== undefined && t.trim !== false) {
				const threshold = typeof t.trim === 'number' ? t.trim : 10
				pipeline = pipeline.trim({ threshold })
			}
			// Border — extend image edges
			if (t.border) {
				const borderWidth = t.border.width ?? 0
				pipeline = pipeline.extend({
					top: t.border.top ?? borderWidth,
					right: t.border.right ?? borderWidth,
					bottom: t.border.bottom ?? borderWidth,
					left: t.border.left ?? borderWidth,
					background: t.border.color ?? '#000000',
				})
			}

			currentBuf = Buffer.from(await pipeline.toBuffer())
		}

		// Apply draw overlays
		if (this.overlays.length > 0) {
			const baseMeta = await sharp(currentBuf).metadata()
			const composites: SharpNs.OverlayOptions[] = []
			for (const overlay of this.overlays) {
				let overlayBuf = Buffer.from(await overlay.streamPromise)

				// Apply opacity to overlay by compositing with a semi-transparent blank
				if (overlay.options?.opacity !== undefined && overlay.options.opacity < 1) {
					const overlayMeta = await sharp(overlayBuf).metadata()
					const w = overlayMeta.width ?? 1
					const h = overlayMeta.height ?? 1
					const alpha = Math.round(overlay.options.opacity * 255)
					// Create a semi-transparent overlay: ensure alpha, then composite with a mask
					overlayBuf = await sharp(overlayBuf)
						.ensureAlpha()
						.composite([{
							input: Buffer.from(new Uint8Array(w * h * 4).fill(0).map((_, i) => i % 4 === 3 ? alpha : 255)),
							raw: { width: w, height: h, channels: 4 },
							blend: 'dest-in' as any,
						}])
						.toBuffer() as Buffer<ArrayBuffer>
				}

				const opts: SharpNs.OverlayOptions = { input: overlayBuf }

				// Compute position — handle bottom/right by converting to top/left
				const hasTop = overlay.options?.top !== undefined
				const hasLeft = overlay.options?.left !== undefined
				const hasBottom = overlay.options?.bottom !== undefined
				const hasRight = overlay.options?.right !== undefined

				if (hasBottom || hasRight) {
					const overlayMeta = await sharp(overlayBuf).metadata()
					const baseW = baseMeta.width ?? 0
					const baseH = baseMeta.height ?? 0
					const overlayW = overlayMeta.width ?? 0
					const overlayH = overlayMeta.height ?? 0

					if (hasTop) {
						opts.top = overlay.options!.top
					} else if (hasBottom) {
						opts.top = Math.max(0, baseH - overlayH - overlay.options!.bottom!)
					}
					if (hasLeft) {
						opts.left = overlay.options!.left
					} else if (hasRight) {
						opts.left = Math.max(0, baseW - overlayW - overlay.options!.right!)
					}
				} else {
					if (hasTop) opts.top = overlay.options!.top
					if (hasLeft) opts.left = overlay.options!.left
				}

				if (overlay.options?.repeat === 'repeat') {
					opts.tile = true
				}
				composites.push(opts)
			}
			currentBuf = Buffer.from(await sharp(currentBuf).composite(composites).toBuffer())
		}

		// Resolve output format — transform format overrides output if set
		// "auto" → detect best format from source (default to webp)
		let resolvedMime = options.format
		if (transformFormat) {
			if (transformFormat === 'auto') {
				// Detect source format from buffer, default to webp
				const sourceFormat = detectFormat(currentBuf)
				resolvedMime = sourceFormat && sourceFormat !== 'image/svg+xml' ? sourceFormat : 'image/webp'
			} else {
				const shortToMime: Record<string, OutputOptions['format']> = {
					avif: 'image/avif',
					webp: 'image/webp',
					jpeg: 'image/jpeg',
					png: 'image/png',
					gif: 'image/gif',
				}
				resolvedMime = shortToMime[transformFormat] ?? resolvedMime
			}
		}
		const sharpFmt = MIME_TO_SHARP[resolvedMime] ?? 'png'
		const formatOpts: Record<string, unknown> = {}
		const resolvedQuality = resolveQuality(options.quality)
		if (resolvedQuality !== undefined) {
			formatOpts.quality = resolvedQuality
		}
		// Compression: "fast" → lower effort for supported formats
		if (options.compression === 'fast') {
			if (sharpFmt === 'png') formatOpts.compressionLevel = 1
			if (sharpFmt === 'webp') formatOpts.effort = 0
			if (sharpFmt === 'avif') formatOpts.effort = 0
		}

		let outputPipeline = sharp(currentBuf)

		// Metadata handling
		if (options.metadata === 'keep') {
			outputPipeline = outputPipeline.keepMetadata()
		} else if (options.metadata === 'copyright') {
			outputPipeline = outputPipeline.withMetadata()
		}
		// 'none' is the default — Sharp strips metadata by default

		const outputBuf = await outputPipeline.toFormat(sharpFmt, formatOpts).toBuffer()
		const contentType = resolvedMime

		return {
			image(): ReadableStream<Uint8Array> {
				return new ReadableStream({
					start(controller) {
						controller.enqueue(new Uint8Array(outputBuf))
						controller.close()
					},
				})
			},
			contentType(): string {
				return contentType
			},
		}
	}
}

// --- ImagesBinding ---

export class ImagesBinding {
	async info(stream: ReadableStream<Uint8Array>): Promise<ImageInfo> {
		const buf = await readStream(stream)
		const format = detectFormat(buf)
		if (!format) {
			throw new Error('Unsupported or unrecognizable image format')
		}
		// Try our fast header parsers first, fall back to Sharp for AVIF
		let dims = parseDimensions(buf, format)
		if (!dims && format === 'image/avif') {
			const sharp = await getSharp()
			if (sharp) {
				try {
					const meta = await sharp(Buffer.from(buf)).metadata()
					if (meta.width && meta.height) {
						dims = { width: meta.width, height: meta.height }
					}
				} catch {
					// ignore — return 0,0
				}
			}
		}
		return {
			width: dims?.width ?? 0,
			height: dims?.height ?? 0,
			format,
			fileSize: buf.byteLength,
		}
	}

	input(stream: ReadableStream<Uint8Array>): LazyImageTransformer {
		return new LazyImageTransformer(stream)
	}
}
