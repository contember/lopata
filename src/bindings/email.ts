import { randomUUIDv7 } from 'bun'
import type { Database } from 'bun:sqlite'
import { startSpan } from '../tracing/span'

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

export interface EmailAddress {
	name: string
	email: string
}

export type EmailAttachment =
	| {
		disposition?: 'inline'
		contentId: string
		filename: string
		type: string
		content: string | ArrayBuffer | ArrayBufferView
	}
	| {
		disposition: 'attachment'
		contentId?: undefined
		filename: string
		type: string
		content: string | ArrayBuffer | ArrayBufferView
	}

export interface SendEmailBuilder {
	from: string | EmailAddress
	to: string | string[]
	subject: string
	replyTo?: string | EmailAddress
	cc?: string | string[]
	bcc?: string | string[]
	headers?: Record<string, string>
	text?: string
	html?: string
	attachments?: EmailAttachment[]
}

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

	async send(message: EmailMessage | SendEmailBuilder): Promise<void> {
		const normalized = await normalizeMessage(message)
		for (const recipient of normalized.recipients) {
			if (this.destinationAddress && recipient !== this.destinationAddress) {
				throw new Error(
					`Destination address "${recipient}" not allowed. Binding "${this.bindingName}" only allows sending to "${this.destinationAddress}".`,
				)
			}
			if (this.allowedDestinationAddresses && this.allowedDestinationAddresses.length > 0) {
				if (!this.allowedDestinationAddresses.includes(recipient)) {
					throw new Error(`Destination address "${recipient}" not in allowed list for binding "${this.bindingName}".`)
				}
			}
		}
		const id = randomUUIDv7()
		this.db.run(
			"INSERT INTO email_messages (id, binding, from_addr, to_addr, raw, raw_size, status, created_at) VALUES (?, ?, ?, ?, ?, ?, 'sent', ?)",
			[
				id,
				this.bindingName,
				normalized.from,
				normalized.to,
				normalized.raw,
				normalized.raw.byteLength,
				Date.now(),
			],
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

	async reply(message: EmailMessage | SendEmailBuilder): Promise<void> {
		return startSpan({ name: 'email.reply', kind: 'client', attributes: {} }, async () => {
			const normalized = await normalizeMessage(message)
			const id = randomUUIDv7()
			this.db.run(
				"INSERT INTO email_messages (id, binding, from_addr, to_addr, raw, raw_size, status, created_at) VALUES (?, ?, ?, ?, ?, ?, 'sent', ?)",
				[
					id,
					'_reply',
					normalized.from,
					normalized.to,
					normalized.raw,
					normalized.raw.byteLength,
					Date.now(),
				],
			)
		})
	}
}

// ─── Helpers ──────────────────────────────────────────────────────────

interface NormalizedMessage {
	from: string
	to: string
	recipients: string[]
	raw: Uint8Array
}

function isEmailMessage(m: EmailMessage | SendEmailBuilder): m is EmailMessage {
	return m instanceof EmailMessage
		|| (typeof (m as { raw?: unknown }).raw !== 'undefined' && typeof (m as { subject?: unknown }).subject === 'undefined')
}

async function normalizeMessage(m: EmailMessage | SendEmailBuilder): Promise<NormalizedMessage> {
	if (isEmailMessage(m)) {
		const raw = await resolveRaw(m.raw)
		return { from: m.from, to: m.to, recipients: [extractEmail(m.to)], raw }
	}
	return renderBuilder(m)
}

async function resolveRaw(raw: ReadableStream<Uint8Array> | Uint8Array | ArrayBuffer | string): Promise<Uint8Array> {
	if (typeof raw === 'string') return new TextEncoder().encode(raw)
	if (raw instanceof Uint8Array) return raw
	if (raw instanceof ArrayBuffer) return new Uint8Array(raw)
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

function formatAddress(addr: string | EmailAddress): string {
	if (typeof addr === 'string') return addr
	const escapedName = addr.name.replace(/"/g, '\\"')
	return `"${escapedName}" <${addr.email}>`
}

function extractEmail(addr: string | EmailAddress): string {
	if (typeof addr === 'string') {
		const match = /<([^>]+)>/.exec(addr)
		return (match?.[1] ?? addr).trim()
	}
	return addr.email
}

function toList(v: string | string[]): string[] {
	return Array.isArray(v) ? v : [v]
}

function renderBuilder(b: SendEmailBuilder): NormalizedMessage {
	const toAddrs = toList(b.to)
	const ccAddrs = b.cc ? toList(b.cc) : []
	const bccAddrs = b.bcc ? toList(b.bcc) : []

	const headers: Record<string, string> = {
		From: formatAddress(b.from),
		To: toAddrs.join(', '),
		Subject: b.subject,
		'MIME-Version': '1.0',
		Date: new Date().toUTCString(),
		'Message-ID': `<${randomUUIDv7()}@lopata.local>`,
	}
	if (ccAddrs.length > 0) headers.Cc = ccAddrs.join(', ')
	if (b.replyTo) headers['Reply-To'] = formatAddress(b.replyTo)
	if (b.headers) Object.assign(headers, b.headers)

	const hasHtml = typeof b.html === 'string'
	const hasText = typeof b.text === 'string'
	const hasAttachments = Array.isArray(b.attachments) && b.attachments.length > 0

	let body: string

	if (hasAttachments) {
		const mixedBoundary = `lopata-mixed-${randomUUIDv7()}`
		headers['Content-Type'] = `multipart/mixed; boundary="${mixedBoundary}"`
		const parts: Part[] = [buildAltPart(b.text, b.html), ...b.attachments!.map(buildAttachmentPart)]
		body = renderMultipart(mixedBoundary, parts)
	} else if (hasHtml && hasText) {
		const altBoundary = `lopata-alt-${randomUUIDv7()}`
		headers['Content-Type'] = `multipart/alternative; boundary="${altBoundary}"`
		body = renderMultipart(altBoundary, [
			{ headers: { 'Content-Type': 'text/plain; charset=UTF-8', 'Content-Transfer-Encoding': '7bit' }, body: b.text! },
			{ headers: { 'Content-Type': 'text/html; charset=UTF-8', 'Content-Transfer-Encoding': '7bit' }, body: b.html! },
		])
	} else if (hasHtml) {
		headers['Content-Type'] = 'text/html; charset=UTF-8'
		headers['Content-Transfer-Encoding'] = '7bit'
		body = b.html!
	} else if (hasText) {
		headers['Content-Type'] = 'text/plain; charset=UTF-8'
		headers['Content-Transfer-Encoding'] = '7bit'
		body = b.text!
	} else {
		headers['Content-Type'] = 'text/plain; charset=UTF-8'
		body = ''
	}

	const headerLines = Object.entries(headers).map(([k, v]) => `${k}: ${v}`).join('\r\n')
	const mime = `${headerLines}\r\n\r\n${body}`
	const raw = new TextEncoder().encode(mime)

	const recipients = [...toAddrs, ...ccAddrs, ...bccAddrs].map(a => extractEmail(a))

	return {
		from: formatAddress(b.from),
		to: toAddrs.join(', '),
		recipients,
		raw,
	}
}

interface Part {
	headers: Record<string, string>
	body: string
}

function renderMultipart(boundary: string, parts: Part[]): string {
	const sections = parts.map(p => {
		const h = Object.entries(p.headers).map(([k, v]) => `${k}: ${v}`).join('\r\n')
		return `--${boundary}\r\n${h}\r\n\r\n${p.body}`
	})
	return `${sections.join('\r\n')}\r\n--${boundary}--\r\n`
}

function buildAltPart(text: string | undefined, html: string | undefined): Part {
	if (text && html) {
		const altBoundary = `lopata-alt-${randomUUIDv7()}`
		return {
			headers: { 'Content-Type': `multipart/alternative; boundary="${altBoundary}"` },
			body: renderMultipart(altBoundary, [
				{ headers: { 'Content-Type': 'text/plain; charset=UTF-8', 'Content-Transfer-Encoding': '7bit' }, body: text },
				{ headers: { 'Content-Type': 'text/html; charset=UTF-8', 'Content-Transfer-Encoding': '7bit' }, body: html },
			]),
		}
	}
	if (html) {
		return {
			headers: { 'Content-Type': 'text/html; charset=UTF-8', 'Content-Transfer-Encoding': '7bit' },
			body: html,
		}
	}
	return {
		headers: { 'Content-Type': 'text/plain; charset=UTF-8', 'Content-Transfer-Encoding': '7bit' },
		body: text ?? '',
	}
}

function buildAttachmentPart(att: EmailAttachment): Part {
	const content = att.content
	let bytes: Uint8Array
	if (typeof content === 'string') {
		bytes = new TextEncoder().encode(content)
	} else if (content instanceof ArrayBuffer) {
		bytes = new Uint8Array(content)
	} else {
		bytes = new Uint8Array(content.buffer, content.byteOffset, content.byteLength)
	}
	const base64 = Buffer.from(bytes).toString('base64')
	const chunked = base64.match(/.{1,76}/g)?.join('\r\n') ?? ''
	const isAttachment = att.disposition === 'attachment'
	const dispositionHeader = isAttachment
		? `attachment; filename="${att.filename}"`
		: `inline; filename="${att.filename}"`
	const headers: Record<string, string> = {
		'Content-Type': `${att.type}; name="${att.filename}"`,
		'Content-Transfer-Encoding': 'base64',
		'Content-Disposition': dispositionHeader,
	}
	if (!isAttachment && att.contentId) {
		headers['Content-ID'] = `<${att.contentId}>`
	}
	return { headers, body: chunked }
}

function parseEmailHeaders(rawBytes: Uint8Array): Headers {
	const headers = new Headers()
	const text = new TextDecoder().decode(rawBytes)
	const headerEnd = text.indexOf('\r\n\r\n')
	const headerSection = headerEnd !== -1 ? text.slice(0, headerEnd) : text.indexOf('\n\n') !== -1 ? text.slice(0, text.indexOf('\n\n')) : text

	const lines = headerSection.split(/\r?\n/)
	let currentKey = ''
	let currentValue = ''

	for (const line of lines) {
		if (/^\s/.test(line) && currentKey) {
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
