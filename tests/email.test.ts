import { Database } from 'bun:sqlite'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { EmailMessage, ForwardableEmailMessage, SendEmailBinding } from '../src/bindings/email'
import { runMigrations } from '../src/db'

let db: Database
let binding: SendEmailBinding

beforeEach(() => {
	db = new Database(':memory:')
	runMigrations(db)
	binding = new SendEmailBinding(db, 'MAIL')
})

afterEach(() => db.close())

interface StoredRow {
	id: string
	binding: string
	from_addr: string
	to_addr: string
	raw: Uint8Array
	raw_size: number
	status: string
}

function lastRow(): StoredRow {
	const row = db.query<StoredRow, []>(
		'SELECT id, binding, from_addr, to_addr, raw, raw_size, status FROM email_messages ORDER BY created_at DESC LIMIT 1',
	)
		.get()
	if (!row) throw new Error('no email row')
	return row
}

function decodeRaw(bytes: Uint8Array): string {
	return new TextDecoder().decode(bytes)
}

describe('EmailMessage (raw) overload', () => {
	test('accepts string raw', async () => {
		const result = await binding.send(new EmailMessage('a@x.com', 'b@y.com', 'Subject: Hi\r\nMessage-ID: <original@example.com>\r\n\r\nBody'))
		const row = lastRow()
		expect(result).toEqual({ messageId: row.id })
		expect(result.messageId).not.toBe('<original@example.com>')
		expect(row.binding).toBe('MAIL')
		expect(row.from_addr).toBe('a@x.com')
		expect(row.to_addr).toBe('b@y.com')
		expect(decodeRaw(row.raw)).toBe('Subject: Hi\r\nMessage-ID: <original@example.com>\r\n\r\nBody')
		expect(row.status).toBe('sent')
	})

	test('accepts ReadableStream raw', async () => {
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new TextEncoder().encode('Subject: Stream\r\n\r\nstreamed body'))
				controller.close()
			},
		})
		await binding.send(new EmailMessage('a@x.com', 'b@y.com', stream))
		expect(decodeRaw(lastRow().raw)).toBe('Subject: Stream\r\n\r\nstreamed body')
	})

	test('accepts Uint8Array raw', async () => {
		await binding.send(new EmailMessage('a@x.com', 'b@y.com', new TextEncoder().encode('Subject: U8\r\n\r\nu8 body')))
		expect(decodeRaw(lastRow().raw)).toBe('Subject: U8\r\n\r\nu8 body')
	})
})

describe('builder overload', () => {
	test('html-only single recipient renders RFC 822', async () => {
		const result = await binding.send({
			from: 'noreply@example.com',
			to: 'user@example.com',
			subject: 'Reset your password',
			html: '<p>Click <a href="https://example.com/reset?t=abc">here</a></p>',
		})
		const row = lastRow()
		expect(result).toEqual({ messageId: row.id })
		expect(decodeRaw(row.raw)).not.toContain(`Message-ID: <${result.messageId}@`)
		expect(row.from_addr).toBe('noreply@example.com')
		expect(row.to_addr).toBe('user@example.com')
		const raw = decodeRaw(row.raw)
		expect(raw).toInclude('From: noreply@example.com')
		expect(raw).toInclude('To: user@example.com')
		expect(raw).toInclude('Subject: Reset your password')
		expect(raw).toInclude('Content-Type: text/html; charset=UTF-8')
		expect(raw).toInclude('<p>Click <a href="https://example.com/reset?t=abc">here</a></p>')
	})

	test('formats EmailAddress objects with display name', async () => {
		await binding.send({
			from: { name: 'Example', email: 'noreply@example.com' },
			to: 'user@example.com',
			subject: 'Hi',
			text: 'Hello',
		})
		const row = lastRow()
		expect(row.from_addr).toBe('"Example" <noreply@example.com>')
		const raw = decodeRaw(row.raw)
		expect(raw).toInclude('From: "Example" <noreply@example.com>')
	})

	test('multiple recipients join with commas', async () => {
		await binding.send({
			from: 'noreply@example.com',
			to: ['a@example.com', 'b@example.com'],
			subject: 'Multi',
			text: 'Body',
		})
		const row = lastRow()
		expect(row.to_addr).toBe('a@example.com, b@example.com')
	})

	test('text + html renders multipart/alternative', async () => {
		await binding.send({
			from: 'noreply@example.com',
			to: 'user@example.com',
			subject: 'Both',
			text: 'plain version',
			html: '<p>html version</p>',
		})
		const raw = decodeRaw(lastRow().raw)
		expect(raw).toMatch(/Content-Type: multipart\/alternative; boundary="lopata-alt-[^"]+"/)
		expect(raw).toInclude('plain version')
		expect(raw).toInclude('<p>html version</p>')
	})

	test('cc and bcc are validated against allow list', async () => {
		binding = new SendEmailBinding(db, 'MAIL', undefined, ['allowed@example.com'])
		await expect(binding.send({
			from: 'noreply@example.com',
			to: 'allowed@example.com',
			cc: 'other@example.com',
			subject: 'x',
			text: 'x',
		})).rejects.toThrow(/not in allowed list/)
	})

	test('custom headers + replyTo land in MIME', async () => {
		await binding.send({
			from: 'noreply@example.com',
			to: 'user@example.com',
			replyTo: { name: 'Support', email: 'support@example.com' },
			subject: 'Hi',
			text: 'Hello',
			headers: { 'X-Custom': 'yes' },
		})
		const raw = decodeRaw(lastRow().raw)
		expect(raw).toInclude('Reply-To: "Support" <support@example.com>')
		expect(raw).toInclude('X-Custom: yes')
	})
})

describe('destination validation', () => {
	test('destinationAddress rejects mismatched to', async () => {
		binding = new SendEmailBinding(db, 'MAIL', 'allowed@example.com')
		await expect(binding.send(new EmailMessage('a@x.com', 'other@example.com', 'body'))).rejects.toThrow(/not allowed/)
	})

	test('builder respects destinationAddress', async () => {
		binding = new SendEmailBinding(db, 'MAIL', 'allowed@example.com')
		await expect(binding.send({
			from: 'a@x.com',
			to: 'other@example.com',
			subject: 's',
			text: 't',
		})).rejects.toThrow(/not allowed/)
		await binding.send({
			from: 'a@x.com',
			to: 'allowed@example.com',
			subject: 's',
			text: 't',
		})
		expect(lastRow().to_addr).toBe('allowed@example.com')
	})
})

describe('structured MIME and envelope', () => {
	test('mixed addresses escape display names and keep BCC out of MIME', async () => {
		const named = { email: 'named@example.com', name: 'A "quoted" \\ name' }
		await binding.send({
			from: named,
			to: ['plain@example.com', named, { email: 'unnamed@example.com' }],
			cc: [named, 'copy@example.com'],
			bcc: ['hidden@example.com', { email: 'secret@example.com', name: 'Secret Name' }],
			replyTo: { email: 'reply@example.com' },
			subject: 'Names',
			text: 'Body',
		})
		const raw = decodeRaw(lastRow().raw)
		const formatted = '"A \\"quoted\\" \\\\ name" <named@example.com>'
		expect(raw).toContain(`From: ${formatted}\r\n`)
		expect(raw).toContain(`To: plain@example.com, ${formatted}, unnamed@example.com\r\n`)
		expect(raw).toContain(`Cc: ${formatted}, copy@example.com\r\n`)
		expect(raw).toContain('Reply-To: reply@example.com\r\n')
		expect(raw).not.toMatch(/bcc:|hidden@example.com|secret@example.com|Secret Name/i)
	})

	test('unnamed and empty-name objects render bare addresses in every header', async () => {
		await binding.send({
			from: { email: 'from@example.com' },
			to: { email: 'to@example.com' },
			cc: { email: 'cc@example.com', name: '' },
			replyTo: { email: 'reply@example.com', name: '' },
			subject: 'Bare',
		})
		const raw = decodeRaw(lastRow().raw)
		for (const header of ['From: from@example.com', 'To: to@example.com', 'Cc: cc@example.com', 'Reply-To: reply@example.com']) {
			expect(raw).toContain(`${header}\r\n`)
		}
	})

	for (const field of ['to', 'cc', 'bcc']) {
		for (const restriction of ['destination', 'allow-list']) {
			test(`${restriction} checks extracted ${field} addresses and rejects before persistence`, async () => {
				binding = restriction === 'destination'
					? new SendEmailBinding(db, 'MAIL', 'allowed@example.com')
					: new SendEmailBinding(db, 'MAIL', undefined, ['allowed@example.com'])
				const message = {
					from: { email: 'sender@example.com', name: 'Sender' },
					to: { email: 'allowed@example.com', name: 'Allowed' },
					cc: ['Allowed <allowed@example.com>'],
					bcc: { email: 'allowed@example.com' },
					subject: 'Restricted',
				}
				await expect(binding.send({ ...message, [field]: { email: 'denied@example.com', name: 'Allowed' } })).rejects.toThrow(
					restriction === 'destination'
						? /Destination address "denied@example.com" not allowed/
						: /Destination address "denied@example.com" not in allowed list/,
				)
				expect(db.query('SELECT id FROM email_messages').all()).toHaveLength(0)
				const result = await binding.send(message)
				expect(result.messageId).toBe(lastRow().id)
			})
		}
	}
})

describe('attachment content', () => {
	const bytes = new Uint8Array([0, 255, 128, 13, 10, 42])
	const padded = new Uint8Array([99, 98, ...bytes, 97])
	const cases = [
		{ name: 'base64 string', content: Buffer.from(bytes).toString('base64') },
		{ name: 'ArrayBuffer', content: bytes.buffer },
		{ name: 'Uint8Array', content: bytes },
		{ name: 'subview', content: padded.subarray(2, 8) },
		{ name: 'DataView', content: new DataView(padded.buffer, 2, 6) },
		{ name: 'Uint16Array view', content: new Uint16Array(padded.buffer, 2, 3) },
	]
	for (const { name, content } of cases) {
		test(`${name} decodes to the exact original bytes`, async () => {
			await binding.send({
				from: 'sender@example.com',
				to: 'recipient@example.com',
				subject: name,
				attachments: [{ disposition: 'attachment', filename: 'data.bin', type: 'application/octet-stream', content }],
			})
			const raw = decodeRaw(lastRow().raw)
			const encoded = /Content-Disposition: attachment; filename="data.bin"\r\n\r\n([\s\S]*?)\r\n--/.exec(raw)?.[1]
			if (encoded === undefined) throw new Error('Missing attachment body')
			expect(new Uint8Array(Buffer.from(encoded, 'base64'))).toEqual(bytes)
		})
	}
})

test('raw streams preserve binary chunks and MIME headers without rewriting', async () => {
	const prefix = new TextEncoder().encode('Bcc: original@example.com\r\nMessage-ID: <raw@example.com>\r\n\r\n')
	const binary = new Uint8Array([0, 255, 128, 13, 10])
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(prefix)
			controller.enqueue(binary)
			controller.close()
		},
	})
	const result = await binding.send(new EmailMessage('sender@example.com', 'recipient@example.com', stream))
	expect(lastRow().raw).toEqual(new Uint8Array([...prefix, ...binary]))
	expect(lastRow().raw_size).toBe(prefix.length + binary.length)
	expect(result.messageId).toBe(lastRow().id)
})

test('reply shares MIME normalization while retaining its existing return contract', async () => {
	const incoming = new ForwardableEmailMessage(db, 'incoming', 'sender@example.com', 'recipient@example.com', new Uint8Array())
	expect(
		await incoming.reply({
			from: { email: 'recipient@example.com' },
			to: { email: 'sender@example.com', name: 'Sender' },
			subject: 'Reply',
			attachments: [{ disposition: 'attachment', filename: 'reply.bin', type: 'application/octet-stream', content: 'AP+A' }],
		}),
	).toBeUndefined()
	const row = lastRow()
	expect(row.binding).toBe('_reply')
	expect(decodeRaw(row.raw)).toContain('To: "Sender" <sender@example.com>')
	expect(decodeRaw(row.raw)).toContain('\r\n\r\nAP+A\r\n--')
})
