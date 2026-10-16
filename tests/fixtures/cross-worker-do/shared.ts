/** Shapes both workers of the fixture exchange over cross-worker Durable Object RPC. */

export interface Entry {
	amount: number
	at: Date
	tags: Set<string>
}

export interface Receipt {
	total: number
	atIsDate: boolean
	tagsIsSet: boolean
	tags: string[]
}

export interface DurableObjectId {
	toString(): string
}

export interface Namespace<Stub> {
	idFromName(name: string): DurableObjectId
	get(id: DurableObjectId): Stub
	getByName(name: string): Stub
}

export interface CommonStub {
	record(entry: Entry): Promise<Receipt>
	total(): Promise<number>
	reject(): Promise<never>
	fetch(input: Request | string, init?: RequestInit): Promise<Response>
}

export interface LedgerStub extends CommonStub {}

export interface MailboxStub extends CommonStub {
	modules(): Promise<{ prompt: string; sum: number }>
	ledgerTotal(account: string): Promise<number>
}

export const sampleEntry = (amount: number): Entry => ({ amount, at: new Date(0), tags: new Set(['a', 'b']) })

export async function recordEntry(
	storage: { get(key: string): Promise<unknown>; put(key: string, value: number): Promise<void> },
	entry: Entry,
): Promise<Receipt> {
	const previous = await storage.get('total')
	const total = (typeof previous === 'number' ? previous : 0) + entry.amount
	await storage.put('total', total)
	return { total, atIsDate: entry.at instanceof Date, tagsIsSet: entry.tags instanceof Set, tags: [...entry.tags] }
}

export async function readTotal(storage: { get(key: string): Promise<unknown> }): Promise<number> {
	const total = await storage.get('total')
	return typeof total === 'number' ? total : 0
}

/** A response whose body arrives as several chunks, so it has to stream across the threads. */
export function streamedResponse(host: string, request: Request, body: string): Response {
	const encoder = new TextEncoder()
	const parts = [`${host}:`, `${request.method}:`, body]
	const stream = new ReadableStream<Uint8Array>({
		async pull(controller) {
			const part = parts.shift()
			if (part === undefined) {
				controller.close()
				return
			}
			await new Promise(resolve => setTimeout(resolve, 10))
			controller.enqueue(encoder.encode(part))
		},
	})
	return new Response(stream, { headers: { 'x-host': host } })
}

/** The error a cross-worker call surfaced, as the caller sees it. */
export async function caught(call: () => Promise<unknown>): Promise<Response> {
	try {
		await call()
		return Response.json({ threw: false })
	} catch (error) {
		return Response.json({
			threw: true,
			name: error instanceof Error ? error.name : null,
			message: error instanceof Error ? error.message : String(error),
		})
	}
}

/** Calls the peer worker's class: RPC, fetch() and a thrown error. */
export async function callPeer(peer: Namespace<CommonStub>, action: string): Promise<Response | null> {
	const stub = peer.getByName('shared')
	if (action === 'rpc') return Response.json(await stub.record(sampleEntry(5)))
	if (action === 'total') return Response.json(await stub.total())
	if (action === 'error') return caught(() => stub.reject())
	if (action === 'id') return Response.json(peer.idFromName('shared').toString())
	if (action === 'fetch') {
		const response = await stub.fetch(new Request('https://peer.do/echo', { method: 'POST', body: 'payload' }))
		return Response.json({ status: response.status, host: response.headers.get('x-host'), text: await response.text() })
	}
	if (action === 'stream') return stub.fetch('https://peer.do/echo')
	return null
}
