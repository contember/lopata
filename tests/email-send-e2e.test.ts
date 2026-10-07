import type { Subprocess } from 'bun'
import { Database } from 'bun:sqlite'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

interface StoredEmail {
	id: string
	from_addr: string
	to_addr: string
	raw: Uint8Array
	raw_size: number
	status: string
}

describe('email send through the worker thread', () => {
	let process: Subprocess
	let dir: string
	let base: string
	let db: Database

	beforeAll(async () => {
		dir = mkdtempSync(join(tmpdir(), 'email-send-'))
		process = Bun.spawn([Bun.which('bun') ?? 'bun', resolve(import.meta.dir, 'fixtures/email-send-runner.ts')], {
			cwd: dir,
			stdout: 'pipe',
			stderr: 'inherit',
		})
		if (!process.stdout || typeof process.stdout === 'number') throw new Error('Missing subprocess stdout')
		const reader = process.stdout.getReader()
		let output = ''
		try {
			while (true) {
				const result = await reader.read()
				if (result.done) throw new Error(`Runtime exited before ready: ${output}`)
				output += new TextDecoder().decode(result.value)
				const match = /READY (\d+)/.exec(output)
				if (match) {
					base = `http://localhost:${match[1]}`
					break
				}
			}
		} finally {
			reader.releaseLock()
		}
		db = new Database(join(dir, '.lopata/data.sqlite'), { readonly: true })
	}, 20_000)

	afterAll(async () => {
		process?.kill()
		if (process) await process.exited
		db?.close()
		if (dir) rmSync(dir, { recursive: true, force: true })
	})

	async function send(path: string): Promise<StoredEmail> {
		const response = await fetch(base + path)
		expect(response.status).toBe(200)
		const result: unknown = await response.json()
		if (!result || typeof result !== 'object' || !('messageId' in result) || typeof result.messageId !== 'string') {
			throw new Error('Send did not return a messageId')
		}
		const row = db.query<StoredEmail, [string]>('SELECT id, from_addr, to_addr, raw, raw_size, status FROM email_messages WHERE id = ?')
			.get(result.messageId)
		if (!row) throw new Error(`No persisted email for returned ID ${result.messageId}`)
		expect(result).toEqual({ messageId: row.id })
		expect(row.status).toBe('sent')
		expect(row.raw_size).toBe(row.raw.byteLength)
		return row
	}

	test('raw stream returns capture ID and preserves MIME and binary bytes', async () => {
		const row = await send('/raw')
		const prefix = new TextEncoder().encode('Message-ID: <worker@example.com>\r\nBcc: raw@example.com\r\n\r\n')
		expect(row.raw).toEqual(new Uint8Array([...prefix, 0, 255, 128, 13, 10, 42]))
		expect(row.id).not.toBe('<worker@example.com>')
		expect(row.from_addr).toBe('sender@example.com')
		expect(row.to_addr).toBe('allowed@example.com')
	})

	test('builder preserves binary attachment views and named recipients across structured clone', async () => {
		const row = await send('/structured')
		const raw = new TextDecoder().decode(row.raw)
		expect(raw).toContain('From: "Worker \\"Sender\\" \\\\ Test" <sender@example.com>\r\n')
		expect(raw).toContain('To: allowed@example.com, "Named" <allowed@example.com>\r\n')
		expect(raw).toContain('Cc: allowed@example.com\r\n')
		expect(raw).not.toMatch(/bcc:|hidden@example.com|Hidden/i)
		expect(raw).not.toContain(`Message-ID: <${row.id}@`)
		const bodies = [...raw.matchAll(/Content-Disposition: attachment; filename="\d.bin"\r\n\r\n([\s\S]*?)\r\n--/g)]
		expect(bodies).toHaveLength(6)
		for (const body of bodies) {
			if (body[1] === undefined) throw new Error('Missing attachment body')
			expect(new Uint8Array(Buffer.from(body[1], 'base64'))).toEqual(new Uint8Array([0, 255, 128, 13, 10, 42]))
		}
	})

	test('named BCC restriction errors cross the boundary without persisting a message', async () => {
		const before = db.query('SELECT id FROM email_messages').all()
		const response = await fetch(base + '/denied')
		expect(response.status).toBe(400)
		expect(await response.json()).toEqual({ error: 'Destination address "denied@example.com" not in allowed list for binding "MAIL".' })
		expect(db.query('SELECT id FROM email_messages').all()).toEqual(before)
	})
})
