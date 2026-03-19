// Media Transformations binding — ffmpeg-based implementation for local dev
// Cloudflare's Media binding provides video/audio processing (resize, crop, frame extraction, etc.)
// Requires ffmpeg installed on the system. Falls back to passthrough if unavailable.
//
// Note: MP4 files often have the moov atom at the end, making them non-streamable.
// ffmpeg needs to seek backwards to read the moov atom, which doesn't work with stdin pipes.
// We use temp files for input/output to handle all container formats correctly.

import { randomUUID } from 'node:crypto'
import { unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export interface MediaTransformOptions {
	width?: number
	height?: number
	fit?: 'contain' | 'cover' | 'crop' | 'scale-down'
	trim?: { start?: string; end?: string }
}

export interface MediaOutputOptions {
	mode: 'video' | 'frame' | 'spritesheet' | 'audio'
	duration?: string
	offset?: string
	format?: string
	fps?: number
	columns?: number
	rows?: number
}

export interface MediaOutputResult {
	response(): Promise<Response>
}

// --- Lazy ffmpeg detection ---

let _ffmpegResolved = false
let _ffmpegAvailable = false
let _ffmpegWarned = false

async function hasFfmpeg(): Promise<boolean> {
	if (!_ffmpegResolved) {
		try {
			const proc = Bun.spawn(['ffmpeg', '-version'], { stdout: 'ignore', stderr: 'ignore' })
			const code = await proc.exited
			_ffmpegAvailable = code === 0
		} catch {
			_ffmpegAvailable = false
		}
		_ffmpegResolved = true
	}
	return _ffmpegAvailable
}

function warnFfmpegMissing() {
	if (!_ffmpegWarned) {
		console.warn('[lopata] ffmpeg is not installed — media transformations will pass through unchanged. Install it: https://ffmpeg.org')
		_ffmpegWarned = true
	}
}

// --- Content type helpers ---

const MODE_CONTENT_TYPES: Record<string, Record<string, string>> = {
	video: { mp4: 'video/mp4', webm: 'video/webm' },
	frame: { png: 'image/png', jpeg: 'image/jpeg', jpg: 'image/jpeg', webp: 'image/webp' },
	spritesheet: { png: 'image/png', jpeg: 'image/jpeg', jpg: 'image/jpeg', webp: 'image/webp' },
	audio: { m4a: 'audio/mp4', mp3: 'audio/mpeg', ogg: 'audio/ogg' },
}

const MODE_DEFAULTS: Record<string, { format: string; contentType: string }> = {
	video: { format: 'mp4', contentType: 'video/mp4' },
	frame: { format: 'png', contentType: 'image/png' },
	spritesheet: { format: 'png', contentType: 'image/png' },
	audio: { format: 'm4a', contentType: 'audio/mp4' },
}

function resolveContentType(mode: string, format?: string): { ffFormat: string; contentType: string } {
	const defaults = MODE_DEFAULTS[mode] ?? MODE_DEFAULTS.video!
	if (!format) return { ffFormat: defaults.format, contentType: defaults.contentType }
	const ct = MODE_CONTENT_TYPES[mode]?.[format]
	return { ffFormat: format, contentType: ct ?? defaults.contentType }
}

// --- ffmpeg argument builders ---

function buildScaleFilter(transforms: MediaTransformOptions[]): string | null {
	// Use the last transform that specifies dimensions
	for (let i = transforms.length - 1; i >= 0; i--) {
		const t = transforms[i]!
		if (t.width || t.height) {
			const w = t.width ?? -2
			const h = t.height ?? -2
			const fit = t.fit ?? 'contain'

			if (fit === 'contain' || fit === 'scale-down') {
				// Scale to fit within dimensions, preserving aspect ratio
				return `scale=${w}:${h}:force_original_aspect_ratio=decrease`
			} else if (fit === 'cover' || fit === 'crop') {
				// Scale to cover, then crop to exact dimensions
				if (t.width && t.height) {
					return `scale=${t.width}:${t.height}:force_original_aspect_ratio=increase,crop=${t.width}:${t.height}`
				}
				return `scale=${w}:${h}:force_original_aspect_ratio=increase`
			}
			return `scale=${w}:${h}`
		}
	}
	return null
}

function buildTrimArgs(transforms: MediaTransformOptions[], outputOpts: MediaOutputOptions): string[] {
	const args: string[] = []

	// Seek from transform trim or output offset
	for (const t of transforms) {
		if (t.trim?.start) {
			args.push('-ss', t.trim.start)
			break
		}
	}
	if (args.length === 0 && outputOpts.offset) {
		args.push('-ss', outputOpts.offset)
	}

	// End time from transform trim
	for (const t of transforms) {
		if (t.trim?.end) {
			args.push('-to', t.trim.end)
			break
		}
	}

	// Duration from output options
	if (outputOpts.duration) {
		args.push('-t', outputOpts.duration)
	}

	return args
}

function buildVideoArgs(transforms: MediaTransformOptions[], opts: MediaOutputOptions): string[] {
	const args: string[] = []

	args.push(...buildTrimArgs(transforms, opts))

	const scale = buildScaleFilter(transforms)
	if (scale) args.push('-vf', scale)

	args.push('-movflags', '+faststart')

	return args
}

function buildFrameArgs(transforms: MediaTransformOptions[], opts: MediaOutputOptions): string[] {
	const args: string[] = []

	if (opts.offset) args.push('-ss', opts.offset)

	args.push('-frames:v', '1')

	const scale = buildScaleFilter(transforms)
	if (scale) args.push('-vf', scale)

	return args
}

function buildSpritesheetArgs(transforms: MediaTransformOptions[], opts: MediaOutputOptions): string[] {
	const args: string[] = []

	args.push(...buildTrimArgs(transforms, opts))

	const fps = opts.fps ?? 1
	const columns = opts.columns ?? 5
	const rows = opts.rows ?? 4

	const filters: string[] = []
	filters.push(`fps=${fps}`)

	const scale = buildScaleFilter(transforms)
	if (scale) filters.push(scale)

	filters.push(`tile=${columns}x${rows}`)

	args.push('-vf', filters.join(','))
	args.push('-frames:v', '1')

	return args
}

function buildAudioArgs(transforms: MediaTransformOptions[], opts: MediaOutputOptions): string[] {
	const args: string[] = []
	const { ffFormat } = resolveContentType('audio', opts.format)

	args.push(...buildTrimArgs(transforms, opts))

	args.push('-vn') // no video

	// m4a extension is recognized by ffmpeg, no explicit format needed
	const codecMap: Record<string, string[]> = {
		ogg: ['-c:a', 'libvorbis'],
	}
	if (codecMap[ffFormat]) args.push(...codecMap[ffFormat]!)

	return args
}

// --- Passthrough (no ffmpeg) ---

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

// --- MediaTransformer ---

class MediaTransformer {
	private streamPromise: Promise<Uint8Array>
	private transforms: MediaTransformOptions[] = []

	constructor(stream: ReadableStream<Uint8Array>) {
		this.streamPromise = readStream(stream)
	}

	transform(options: MediaTransformOptions): MediaTransformer {
		this.transforms.push(options)
		return this
	}

	output(opts: MediaOutputOptions): MediaOutputResult {
		const transforms = this.transforms
		const streamPromise = this.streamPromise

		return {
			async response(): Promise<Response> {
				if (!(await hasFfmpeg())) {
					warnFfmpegMissing()
					const buf = await streamPromise
					return new Response(buf, {
						headers: { 'content-type': 'application/octet-stream' },
					})
				}

				const { contentType } = resolveContentType(opts.mode, opts.format)

				let modeArgs: string[]
				switch (opts.mode) {
					case 'video':
						modeArgs = buildVideoArgs(transforms, opts)
						break
					case 'frame':
						modeArgs = buildFrameArgs(transforms, opts)
						break
					case 'spritesheet':
						modeArgs = buildSpritesheetArgs(transforms, opts)
						break
					case 'audio':
						modeArgs = buildAudioArgs(transforms, opts)
						break
				}

				const inputBuf = await streamPromise

				// Use temp files — MP4 moov atom is often at EOF, requiring seek (stdin pipes can't seek)
				const { ffFormat } = resolveContentType(opts.mode, opts.format)
				const id = randomUUID()
				const inputPath = join(tmpdir(), `lopata-media-in-${id}`)
				const outputPath = join(tmpdir(), `lopata-media-out-${id}.${ffFormat}`)

				try {
					await Bun.write(inputPath, inputBuf)

					const proc = Bun.spawn(
						['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', '-i', inputPath, ...modeArgs, outputPath],
						{ stdout: 'pipe', stderr: 'pipe' },
					)

					const [stderrBuf, exitCode] = await Promise.all([
						new Response(proc.stderr).text(),
						proc.exited,
					])

					if (exitCode !== 0) {
						throw new Error(`[lopata] ffmpeg failed (exit ${exitCode}): ${stderrBuf.trim()}`)
					}

					const output = await Bun.file(outputPath).arrayBuffer()
					return new Response(output, {
						headers: { 'content-type': contentType },
					})
				} finally {
					unlink(inputPath).catch(() => {})
					unlink(outputPath).catch(() => {})
				}
			},
		}
	}
}

// --- MediaBinding ---

export class MediaBinding {
	input(stream: ReadableStream<Uint8Array>): MediaTransformer {
		return new MediaTransformer(stream)
	}
}
