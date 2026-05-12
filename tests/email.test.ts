import { Database } from 'bun:sqlite'
import { beforeEach, describe, expect, test } from 'bun:test'
import { EmailMessage, SendEmailBinding } from '../src/bindings/email'
import { runMigrations } from '../src/db'

let db: Database
let binding: SendEmailBinding

beforeEach(() => {
	db = new Database(':memory:')
	runMigrations(db)
	binding = new SendEmailBinding(db, 'MAIL')
})

interface StoredRow {
	binding: string
	from_addr: string
	to_addr: string
	raw: Uint8Array
	raw_size: number
	status: string
}

function lastRow(): StoredRow {
	const row = db.query<StoredRow, []>('SELECT binding, from_addr, to_addr, raw, raw_size, status FROM email_messages ORDER BY created_at DESC LIMIT 1')
		.get()
	if (!row) throw new Error('no email row')
	return row
}

function decodeRaw(bytes: Uint8Array): string {
	return new TextDecoder().decode(bytes)
}

describe('EmailMessage (raw) overload', () => {
	test('accepts string raw', async () => {
		await binding.send(new EmailMessage('a@x.com', 'b@y.com', 'Subject: Hi\r\n\r\nBody'))
		const row = lastRow()
		expect(row.binding).toBe('MAIL')
		expect(row.from_addr).toBe('a@x.com')
		expect(row.to_addr).toBe('b@y.com')
		expect(decodeRaw(row.raw)).toBe('Subject: Hi\r\n\r\nBody')
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
		await binding.send({
			from: 'noreply@example.com',
			to: 'user@example.com',
			subject: 'Reset your password',
			html: '<p>Click <a href="https://example.com/reset?t=abc">here</a></p>',
		})
		const row = lastRow()
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
			from: { name: 'Chutoo', email: 'noreply@example.com' },
			to: 'user@example.com',
			subject: 'Hi',
			text: 'Hello',
		})
		const row = lastRow()
		expect(row.from_addr).toBe('"Chutoo" <noreply@example.com>')
		const raw = decodeRaw(row.raw)
		expect(raw).toInclude('From: "Chutoo" <noreply@example.com>')
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
