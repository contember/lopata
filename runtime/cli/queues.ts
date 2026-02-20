import type { CliContext } from './context'
import { parseFlag } from './context'

export async function run(ctx: CliContext, args: string[]) {
	const action = args[0]

	switch (action) {
		case 'list': {
			const config = await ctx.config()
			const producers = config.queues?.producers ?? []
			const consumers = config.queues?.consumers ?? []
			if (producers.length === 0 && consumers.length === 0) {
				console.log('No queues configured.')
				return
			}
			const queues = new Map<string, { producer?: string; consumer: boolean }>()
			for (const p of producers) {
				queues.set(p.queue, { producer: p.binding, consumer: false })
			}
			for (const c of consumers) {
				const existing = queues.get(c.queue)
				if (existing) {
					existing.consumer = true
				} else {
					queues.set(c.queue, { consumer: true })
				}
			}
			for (const [name, info] of queues) {
				const parts = [name]
				if (info.producer) parts.push(`binding=${info.producer}`)
				if (info.consumer) parts.push('(consumer)')
				console.log(parts.join('  '))
			}
			break
		}
		case 'message': {
			const sub = args[1]
			const queueName = args[2]

			switch (sub) {
				case 'list': {
					if (!queueName) {
						console.error('Usage: bunflare queues message list <queue>')
						process.exit(1)
					}
					const db = ctx.db()
					const rows = db.query<
						{ id: string; status: string; attempts: number; created_at: number; content_type: string; body: Buffer },
						[string]
					>(
						'SELECT id, status, attempts, created_at, content_type, body FROM queue_messages WHERE queue = ? ORDER BY created_at DESC LIMIT 100',
					).all(queueName)
					if (rows.length === 0) {
						console.log('(no messages)')
						return
					}
					for (const row of rows) {
						const date = new Date(row.created_at).toISOString().slice(0, 19).replace('T', ' ')
						let preview = ''
						if (row.content_type === 'json' || row.content_type === 'text') {
							preview = Buffer.from(row.body).toString().slice(0, 80)
						} else {
							preview = `(${row.content_type}, ${row.body.length} bytes)`
						}
						console.log(`${row.id}  ${row.status.padEnd(8)}  attempts=${row.attempts}  ${date}  ${preview}`)
					}
					break
				}
				case 'send': {
					const body = args[3]
					if (!queueName || body === undefined) {
						console.error('Usage: bunflare queues message send <queue> <body>')
						process.exit(1)
					}
					const { SqliteQueueProducer } = await import('../bindings/queue')
					const producer = new SqliteQueueProducer(ctx.db(), queueName)
					// Try parsing as JSON, fall back to text
					let parsed: unknown
					try {
						parsed = JSON.parse(body)
					} catch {
						parsed = body
					}
					await producer.send(parsed, { contentType: typeof parsed === 'string' ? 'text' : 'json' })
					console.log(`Sent message to queue "${queueName}"`)
					break
				}
				case 'purge': {
					if (!queueName) {
						console.error('Usage: bunflare queues message purge <queue>')
						process.exit(1)
					}
					const db = ctx.db()
					const result = db.run('DELETE FROM queue_messages WHERE queue = ?', [queueName])
					db.run('DELETE FROM queue_leases WHERE queue = ?', [queueName])
					console.log(`Purged ${result.changes} message(s) from queue "${queueName}"`)
					break
				}
				default:
					console.error('Usage: bunflare queues message <list|send|purge> <queue>')
					process.exit(1)
			}
			break
		}
		default:
			console.error('Usage: bunflare queues <list|message> [options]')
			process.exit(1)
	}
}
