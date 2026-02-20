import { randomUUIDv7 } from 'bun'
import type { Database } from 'bun:sqlite'
import { setSpanAttribute, startSpan } from '../tracing/span'

/**
 * EmailMessage — exported from `cloudflare:email`.
 * Used to construct an email for sending via a send_email binding.
 */
export class EmailMessage {
	readonly from: string
	readonly to: string
	readonly raw: ReadableStream<Uint8Array> | Uint8Array | ArrayBuffer | string

	constructor(from: string, to: string, raw: ReadableStream<Uint8Array> | Uint8Array | ArrayBuffer | string) {
		this.from = from
		this.to = to
		this.raw = raw
	}
}

/**
 * SendEmailBinding — the `send_email` binding.
 * Persists sent emails to SQLite.
 */
export class SendEmailBinding {
	private db: Database
	private bindingName: string
	private destinationAddress: string | undefined
	private allowedDestinationAddresses: string[] | undefined

	constructor(db: Database, bindingName: string, destinationAddress?: string, allowedDestinationAddresses?: string[]) {
		this.db = db
		this.bindingName = bindingName
		this.destinationAddress = destinationAddress
		this.allowedDestinationAddresses = allowedDestinationAddresses
	}

	async send(message: EmailMessage): Promise<void> {
		// Validate destination
		if (this.destinationAddress && message.to !== this.destinationAddress) {
			throw new Error(
				`Destination address "${message.to}" not allowed. Binding "${this.bindingName}" only allows sending to "${this.destinationAddress}".`,
			)
		}
		if (this.allowedDestinationAddresses && this.allowedDestinationAddresses.length > 0) {
			if (!this.allowedDestinationAddresses.includes(message.to)) {
				throw new Error(`Destination address "${message.to}" not in allowed list for binding "${this.bindingName}".`)
			}
		}

		const rawBytes = await resolveRaw(message.raw)
		const id = randomUUIDv7()
		this.db.run(
			"INSERT INTO email_messages (id, binding, from_addr, to_addr, raw, raw_size, status, created_at) VALUES (?, ?, ?, ?, ?, ?, 'sent', ?)",
			[id, this.bindingName, message.from, message.to, rawBytes, rawBytes.byteLength, Date.now()],
		)
	}
}

/**
 * ForwardableEmailMessage — the object passed to the worker's `email()` handler.
 * Provides from, to, headers, raw, rawSize, setReject(), forward(), reply().
 */
export class ForwardableEmailMessage {
	readonly from: string
	readonly to: string
	readonly headers: Headers
	readonly raw: ReadableStream<Uint8Array>
	readonly rawSize: number

	private db: Database
	private rawBytes: Uint8Array
	private messageId: string
	private rejected = false

	constructor(db: Database, messageId: string, from: string, to: string, rawBytes: Uint8Array) {
		this.db = db
		this.messageId = messageId
		this.from = from
		this.to = to
		this.rawBytes = rawBytes
		this.rawSize = rawBytes.byteLength
		this.headers = parseEmailHeaders(rawBytes)
		this.raw = new ReadableStream({
			start(controller) {
				controller.enqueue(rawBytes)
				controller.close()
			},
		})
	}

	setReject(reason: string): void {
		startSpan({ name: 'email.setReject', kind: 'client', attributes: { 'email.reject_reason': reason } }, () => {
			this.rejected = true
			this.db.run(
				"UPDATE email_messages SET status = 'rejected', reject_reason = ? WHERE id = ?",
				[reason, this.messageId],
			)
		})
	}

	async forward(rcptTo: string, headers?: Headers): Promise<void> {
		return startSpan({ name: 'email.forward', kind: 'client', attributes: { 'email.forward_to': rcptTo } }, async () => {
			const id = randomUUIDv7()
			this.db.run(
				"INSERT INTO email_messages (id, binding, from_addr, to_addr, raw, raw_size, status, created_at) VALUES (?, ?, ?, ?, ?, ?, 'forwarded', ?)",
				[id, '_forward', this.from, rcptTo, this.rawBytes, this.rawBytes.byteLength, Date.now()],
			)
		})
	}

	async reply(message: EmailMessage): Promise<void> {
		return startSpan({ name: 'email.reply', kind: 'client', attributes: { 'email.reply_to': message.to } }, async () => {
			const rawBytes = await resolveRaw(message.raw)
			const id = randomUUIDv7()
			this.db.run(
				"INSERT INTO email_messages (id, binding, from_addr, to_addr, raw, raw_size, status, created_at) VALUES (?, ?, ?, ?, ?, ?, 'sent', ?)",
				[id, '_reply', message.from, message.to, rawBytes, rawBytes.byteLength, Date.now()],
			)
		})
	}
}

// ─── Helpers ──────────────────────────────────────────────────────────

async function resolveRaw(raw: ReadableStream<Uint8Array> | Uint8Array | ArrayBuffer | string): Promise<Uint8Array> {
	if (typeof raw === 'string') return new TextEncoder().encode(raw)
	if (raw instanceof Uint8Array) return raw
	if (raw instanceof ArrayBuffer) return new Uint8Array(raw)
	// ReadableStream
	const reader = raw.getReader()
	const chunks: Uint8Array[] = []
	while (true) {
		const { done, value } = await reader.read()
		if (done) break
		chunks.push(value)
	}
	const totalLen = chunks.reduce((s, c) => s + c.byteLength, 0)
	const result = new Uint8Array(totalLen)
	let offset = 0
	for (const chunk of chunks) {
		result.set(chunk, offset)
		offset += chunk.byteLength
	}
	return result
}

function parseEmailHeaders(rawBytes: Uint8Array): Headers {
	const headers = new Headers()
	const text = new TextDecoder().decode(rawBytes)
	// Headers end at the first blank line
	const headerEnd = text.indexOf('\r\n\r\n')
	const headerSection = headerEnd !== -1 ? text.slice(0, headerEnd) : text.indexOf('\n\n') !== -1 ? text.slice(0, text.indexOf('\n\n')) : text

	const lines = headerSection.split(/\r?\n/)
	let currentKey = ''
	let currentValue = ''

	for (const line of lines) {
		if (/^\s/.test(line) && currentKey) {
			// Continuation line
			currentValue += ' ' + line.trim()
		} else {
			if (currentKey) {
				headers.append(currentKey, currentValue)
			}
			const colonIdx = line.indexOf(':')
			if (colonIdx !== -1) {
				currentKey = line.slice(0, colonIdx).trim()
				currentValue = line.slice(colonIdx + 1).trim()
			} else {
				currentKey = ''
				currentValue = ''
			}
		}
	}
	if (currentKey) {
		headers.append(currentKey, currentValue)
	}

	return headers
}
