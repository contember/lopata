import { readFileSync } from 'node:fs'

export interface StackFrame {
	file: string
	line: number
	column: number
	function: string
	source?: string[]
	sourceLine?: number
}

const STACK_LINE_RE = /at\s+(?:(.+?)\s+\()?(.+):(\d+):(\d+)\)?/

export function parseStackFrames(stack: string): StackFrame[] {
	const frames: StackFrame[] = []
	for (const line of stack.split('\n')) {
		const match = line.match(STACK_LINE_RE)
		if (!match) continue
		frames.push({
			file: match[2]!,
			line: parseInt(match[3]!, 10),
			column: parseInt(match[4]!, 10),
			function: match[1] ?? '(anonymous)',
		})
	}
	return frames
}

/** Async version — reads source files asynchronously. */
export async function enrichFrameWithSourceAsync(frame: StackFrame): Promise<void> {
	try {
		const file = Bun.file(frame.file)
		if (!await file.exists()) return
		const text = await file.text()
		addSourceContext(frame, text)
	} catch {
		// File unreadable — skip source preview
	}
}

/** Sync version — reads source files synchronously. Safe for use in catch blocks. */
export function enrichFrameWithSource(frame: StackFrame): void {
	try {
		const text = readFileSync(frame.file, 'utf-8')
		addSourceContext(frame, text)
	} catch {
		// File unreadable — skip source preview
	}
}

function addSourceContext(frame: StackFrame, text: string): void {
	const lines = text.split('\n')
	const contextRadius = 7
	const start = Math.max(0, frame.line - 1 - contextRadius)
	const end = Math.min(lines.length, frame.line + contextRadius)
	frame.source = lines.slice(start, end)
	frame.sourceLine = frame.line - 1 - start
}

/** Parse, filter, enrich, and strip cwd from frames. Synchronous. */
export function buildErrorFrames(stack: string): StackFrame[] {
	const frames = parseStackFrames(stack)
		.filter(f => !f.file.startsWith('native:') && !f.file.startsWith('node:'))

	const framesToEnrich = frames.slice(0, 20)
	for (const frame of framesToEnrich) {
		enrichFrameWithSource(frame)
	}

	const cwdPrefix = process.cwd() + '/'
	return framesToEnrich.filter(f => f.source).map(f => ({
		...f,
		file: f.file.startsWith(cwdPrefix) ? f.file.slice(cwdPrefix.length) : f.file,
	}))
}
