import { EmailMessage } from 'cloudflare:email'
import type { EmailAttachment, EmailSendResult, SendEmailBuilder } from '../../src/bindings/email'

interface Env {
	MAIL: { send(message: EmailMessage | SendEmailBuilder): Promise<EmailSendResult> }
}

export default {
	async fetch(request: Request, env: Env) {
		const path = new URL(request.url).pathname
		if (path === '/raw') {
			const raw = new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(new TextEncoder().encode('Message-ID: <worker@example.com>\r\nBcc: raw@example.com\r\n\r\n'))
					controller.enqueue(new Uint8Array([0, 255, 128, 13, 10, 42]))
					controller.close()
				},
			})
			return Response.json(await env.MAIL.send(new EmailMessage('sender@example.com', 'allowed@example.com', raw)))
		}
		const bytes = new Uint8Array([0, 255, 128, 13, 10, 42])
		const padded = new Uint8Array([99, 98, ...bytes, 97])
		const contents = [
			'AP+ADQoq',
			bytes.buffer,
			bytes,
			padded.subarray(2, 8),
			new DataView(padded.buffer, 2, 6),
			new Uint16Array(padded.buffer, 2, 3),
		]
		const attachments: EmailAttachment[] = contents.map((content, index) => ({
			disposition: 'attachment',
			filename: `${index}.bin`,
			type: 'application/octet-stream',
			content,
		}))
		try {
			return Response.json(
				await env.MAIL.send({
					from: { email: 'sender@example.com', name: 'Worker "Sender" \\ Test' },
					to: ['allowed@example.com', { email: 'allowed@example.com', name: 'Named' }],
					cc: { email: 'allowed@example.com' },
					bcc: ['allowed@example.com', { email: path === '/denied' ? 'denied@example.com' : 'hidden@example.com', name: 'Hidden' }],
					subject: 'Structured worker send',
					text: 'Binary attachments',
					attachments,
				}),
			)
		} catch (error) {
			if (!(error instanceof Error)) throw error
			return Response.json({ error: error.message }, { status: 400 })
		}
	},
}
