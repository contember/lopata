export { MyContainer } from './container'
export { Counter } from './counter'
export { ErrorBridge } from './error-bridge'
export { SqlNotes } from './notes'
export { Sandbox } from './sandbox'
export { MyWorkflow } from './workflow'

import { renderShell } from './playground/layout'
import { getSections } from './playground/registry'

// Register sections in display order.
import './playground/sections/kv'
import './playground/sections/r2'
import './playground/sections/d1'
import './playground/sections/counter'
import './playground/sections/notes'
import './playground/sections/queue'
import './playground/sections/echo'
import './playground/sections/container'
import './playground/sections/sandbox'
import './playground/sections/analytics'
import './playground/sections/media'
import './playground/sections/error-bridge'
import './playground/sections/workflow'
import './playground/sections/websocket'

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const url = new URL(request.url)

		if (url.pathname === '/' && request.method === 'GET') {
			return renderShell(getSections())
		}

		for (const section of getSections()) {
			const res = await section.handle(request, env, ctx)
			if (res) return res
		}

		return new Response('Not found', { status: 404 })
	},

	async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
		console.log(`[scheduled] Cron fired: ${controller.cron} at ${new Date(controller.scheduledTime).toISOString()}`)
	},

	async email(message: ForwardableEmailMessage, env: Env, ctx: ExecutionContext): Promise<void> {
		console.log(`[email] Received from: ${message.from}, to: ${message.to}, size: ${message.rawSize}`)
		const subject = message.headers.get('subject') ?? '(no subject)'
		console.log(`[email] Subject: ${subject}`)

		if (message.to.startsWith('forward@')) {
			await message.forward('admin@example.com')
			console.log('[email] Forwarded to admin@example.com')
			return
		}

		if (message.to.startsWith('reject@')) {
			message.setReject('Address not accepted')
			console.log('[email] Rejected')
			return
		}

		const { EmailMessage } = await import('cloudflare:email')
		const replyRaw = `From: ${message.to}\r\nTo: ${message.from}\r\nSubject: Re: ${subject}\r\n\r\nThanks for your email!`
		const reply = new EmailMessage(message.to, message.from, replyRaw)
		await env.MAILER.send(reply)
		console.log('[email] Auto-reply sent')
	},

	async queue(batch: MessageBatch, env: Env): Promise<void> {
		for (const msg of batch.messages) {
			console.log(
				`[queue:${batch.queue}] Processing message ${msg.id}:`,
				msg.body,
			)
			msg.ack()
		}
	},
} satisfies ExportedHandler<Env>
