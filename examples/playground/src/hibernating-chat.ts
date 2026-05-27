import { DurableObject } from 'cloudflare:workers'

interface BacklogRow {
	from: string
	text: string
	ts: number
}

export class HibernatingChat extends DurableObject<Env> {
	private _initialized = false

	private _ensureTable(): void {
		if (this._initialized) return
		this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sender TEXT NOT NULL,
        text TEXT NOT NULL,
        ts INTEGER NOT NULL
      )
    `)
		this._initialized = true
	}

	override async fetch(request: Request): Promise<Response> {
		if (request.headers.get('Upgrade') !== 'websocket') {
			return new Response('Expected websocket', { status: 426 })
		}
		const url = new URL(request.url)
		const match = url.pathname.match(/\/hibernating-chat\/([^/]+)/)
		const name = match ? decodeURIComponent(match[1]!) : url.searchParams.get('name') ?? 'anon'

		const pair = new WebSocketPair()
		const [client, server] = Object.values(pair) as [WebSocket, WebSocket]

		this.ctx.acceptWebSocket(server, [name])

		this._ensureTable()
		server.send(JSON.stringify({ type: 'hello', you: name, backlog: this._readBacklog() }))

		return new Response(null, { status: 101, webSocket: client } as any)
	}

	override async webSocketMessage(ws: WebSocket, msg: string | ArrayBuffer): Promise<void> {
		const text = typeof msg === 'string' ? msg : new TextDecoder().decode(msg)
		let parsed: { type?: string; text?: unknown; name?: unknown }
		try {
			parsed = JSON.parse(text)
		} catch {
			return
		}

		if (parsed.type === 'set-name' && typeof parsed.name === 'string') {
			this.ctx.acceptWebSocket(ws, [parsed.name])
			return
		}

		if (parsed.type === 'msg' && typeof parsed.text === 'string') {
			const tags = this.ctx.getTags(ws)
			const from = tags[tags.length - 1] ?? 'anon'
			const ts = Date.now()
			this._ensureTable()
			this.ctx.storage.sql.exec(
				'INSERT INTO messages (sender, text, ts) VALUES (?, ?, ?)',
				from,
				parsed.text,
				ts,
			)
			this._trimBacklog()
			const payload = JSON.stringify({ type: 'msg', from, text: parsed.text, ts })
			for (const peer of this.ctx.getWebSockets()) {
				try {
					peer.send(payload)
				} catch {
					// peer may be closing — ignore
				}
			}
		}
	}

	override async webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean): Promise<void> {
		const tags = this.ctx.getTags(ws)
		console.log(`[HibernatingChat] close (${code}) tags=${JSON.stringify(tags)} clean=${wasClean} reason=${reason}`)
	}

	override async webSocketError(ws: WebSocket, err: unknown): Promise<void> {
		const tags = this.ctx.getTags(ws)
		console.error(`[HibernatingChat] error tags=${JSON.stringify(tags)}`, err)
	}

	async getBacklog(): Promise<BacklogRow[]> {
		this._ensureTable()
		return this._readBacklog()
	}

	private _readBacklog(): BacklogRow[] {
		const rows = this.ctx.storage.sql
			.exec('SELECT sender, text, ts FROM messages ORDER BY id DESC LIMIT 10')
			.toArray() as Array<{ sender: string; text: string; ts: number }>
		return rows.reverse().map(r => ({ from: r.sender, text: r.text, ts: r.ts }))
	}

	private _trimBacklog(): void {
		this.ctx.storage.sql.exec(`
      DELETE FROM messages
      WHERE id NOT IN (SELECT id FROM messages ORDER BY id DESC LIMIT 10)
    `)
	}
}
