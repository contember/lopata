import { describe, expect, test } from 'bun:test'
import { ReadableStream as WebReadableStream } from 'node:stream/web'
import type { ReadableStreamReadResult } from 'node:stream/web'
import { IdentityTransformStream, NativeReadableStream } from '../src/bindings/cf-streams'

const decode = (view: ArrayBufferView | undefined) => (view ? Buffer.from(view.buffer, view.byteOffset, view.byteLength).toString() : '')

function jsStream(...parts: string[]): ReadableStream<Uint8Array> {
	const chunks = parts.map(part => new TextEncoder().encode(part))
	return new ReadableStream({
		pull(controller) {
			const chunk = chunks.shift()
			if (chunk) controller.enqueue(chunk)
			else controller.close()
		},
	})
}

/** The readable side of an IdentityTransformStream (a native stream) delivering `parts` as separate chunks. */
function chunked(...parts: string[]): ReadableStream<Uint8Array> {
	const { readable, writable } = new IdentityTransformStream()
	void jsStream(...parts).pipeTo(writable)
	return readable
}

// workerd's ReadableStreamBYOBReader.readAtLeast(); Bun's typings do not declare it.
function readAtLeast(reader: ReadableStreamBYOBReader, min: number, view: ArrayBufferView): Promise<ReadableStreamReadResult<ArrayBufferView>> {
	const fn: unknown = Reflect.get(reader, 'readAtLeast')
	if (typeof fn !== 'function') throw new Error('readAtLeast is missing')
	return Reflect.apply(fn, reader, [min, view])
}

describe('BYOB readers on native streams without a byte source', () => {
	test('a Response body gives a BYOB reader that fills the caller view', async () => {
		const reader = new Response('foo bar').body!.getReader({ mode: 'byob' })
		const { value, done } = await reader.read(new Uint8Array(32))
		expect(done).toBe(false)
		expect(decode(value)).toBe('foo bar')
		expect((await reader.read(new Uint8Array(32))).done).toBe(true)
	})

	test('a chunk larger than the view is delivered over several reads', async () => {
		const reader = chunked('hello world').getReader({ mode: 'byob' })
		expect(decode((await reader.read(new Uint8Array(5))).value)).toBe('hello')
		expect(decode((await reader.read(new Uint8Array(20))).value)).toBe(' world')
	})

	test('the readable side of an IdentityTransformStream gives a BYOB reader', async () => {
		const { readable, writable } = new IdentityTransformStream()
		const writer = writable.getWriter()
		void writer.write(new TextEncoder().encode('abc'))
		const reader = readable.getReader({ mode: 'byob' })
		expect(decode((await reader.read(new Uint8Array(8))).value)).toBe('abc')
	})

	test('tee branches of a body give BYOB readers', async () => {
		const [left, right] = chunked('tee').tee()
		expect(decode((await left.getReader({ mode: 'byob' }).read(new Uint8Array(8))).value)).toBe('tee')
		expect(decode((await right.getReader({ mode: 'byob' }).read(new Uint8Array(8))).value)).toBe('tee')
	})

	test('a stream constructed in JavaScript without a byte source refuses a BYOB reader, as do its tee branches', () => {
		expect(() => jsStream('x').getReader({ mode: 'byob' })).toThrow(TypeError)
		class Subclass extends ReadableStream {}
		expect(() => new Subclass().getReader({ mode: 'byob' })).toThrow(TypeError)
		const [branch] = jsStream('x').tee()
		expect(() => branch.getReader({ mode: 'byob' })).toThrow(TypeError)
		expect(jsStream('x').constructor).toBe(ReadableStream)
	})

	test('a stream the runtime builds with the native constructor gives a BYOB reader', async () => {
		const stream = new NativeReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new TextEncoder().encode('kv value'))
				controller.close()
			},
		})
		expect(decode((await stream.getReader({ mode: 'byob' }).read(new Uint8Array(16))).value)).toBe('kv value')
	})

	test('empty chunks from the source are skipped', async () => {
		const { readable, writable } = new IdentityTransformStream()
		const writer = writable.getWriter()
		void writer.write(new Uint8Array(0))
		void writer.write(new TextEncoder().encode('after'))
		void writer.close()
		const reader = readable.getReader({ mode: 'byob' })
		expect(decode((await reader.read(new Uint8Array(8))).value)).toBe('after')
		expect((await reader.read(new Uint8Array(8))).done).toBe(true)
	})

	test('a locked stream still refuses a second reader', () => {
		const stream = chunked('x')
		stream.getReader()
		expect(() => stream.getReader({ mode: 'byob' })).toThrow(TypeError)
	})

	test('a source error reaches the BYOB reader', async () => {
		const source = new ReadableStream({
			pull(controller) {
				controller.error(new Error('boom'))
			},
		})
		const { readable, writable } = new IdentityTransformStream()
		void source.pipeTo(writable).catch(() => {})
		await expect(readable.getReader({ mode: 'byob' }).read(new Uint8Array(4))).rejects.toThrow('boom')
	})
})

describe('ReadableStreamBYOBReader.readAtLeast', () => {
	test('reads until at least min bytes, then returns what is left and finally done with an empty view', async () => {
		const reader = chunked('foo', 'bar', 'b', 'a', 'z').getReader({ mode: 'byob' })
		const first = await readAtLeast(reader, 4, new Uint8Array(20))
		expect([decode(first.value), first.done]).toEqual(['foobar', false])
		expect(decode((await reader.read(new Uint8Array(20))).value)).toBe('b')
		const rest = await readAtLeast(reader, 4, new Uint8Array(20))
		expect([decode(rest.value), rest.done]).toEqual(['az', false])
		const end = await readAtLeast(reader, 4, new Uint8Array(20))
		expect(end.done).toBe(true)
		expect(end.value).toBeInstanceOf(Uint8Array)
		expect(end.value?.byteLength).toBe(0)
	})

	test('works on a native byte stream and keeps the view type', async () => {
		const bytes = new Uint8Array([1, 0, 2, 0, 3, 0])
		const stream = new WebReadableStream({
			type: 'bytes',
			start(controller) {
				controller.enqueue(bytes)
				controller.close()
			},
		})
		const result = await readAtLeast(stream.getReader({ mode: 'byob' }), 2, new Uint16Array(3))
		expect(result.value).toBeInstanceOf(Uint16Array)
		expect([...new Uint8Array(result.value!.buffer, result.value!.byteOffset, result.value!.byteLength)]).toEqual([1, 0, 2, 0, 3, 0])
	})

	test('reads on until the bytes fill whole elements of the view', async () => {
		const result = await readAtLeast(chunked('abc', 'd').getReader({ mode: 'byob' }), 3, new Uint16Array(4))
		expect(result.value).toBeInstanceOf(Uint16Array)
		expect(decode(result.value)).toBe('abcd')
	})

	test('a stream that ends inside an element rejects', async () => {
		await expect(readAtLeast(chunked('abc').getReader({ mode: 'byob' }), 2, new Uint16Array(4))).rejects.toThrow(TypeError)
	})

	test('rejects a min outside 1..view.byteLength', async () => {
		const reader = chunked('x').getReader({ mode: 'byob' })
		await expect(readAtLeast(reader, 0, new Uint8Array(4))).rejects.toThrow(TypeError)
		await expect(readAtLeast(reader, 5, new Uint8Array(4))).rejects.toThrow(RangeError)
	})
})
