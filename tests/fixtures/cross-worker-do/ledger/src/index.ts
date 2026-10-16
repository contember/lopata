import { DurableObject } from 'cloudflare:workers'
import {
	callPeer,
	caught,
	type Entry,
	type LedgerStub,
	type MailboxStub,
	type Namespace,
	readTotal,
	type Receipt,
	recordEntry,
	streamedResponse,
} from '../../shared'

interface Env {
	LEDGER: Namespace<LedgerStub>
	MAILBOX: Namespace<MailboxStub>
	MISSING_WORKER: Namespace<LedgerStub>
	MISSING_CLASS: Namespace<LedgerStub>
}

export class Ledger extends DurableObject {
	record(entry: Entry): Promise<Receipt> {
		return recordEntry(this.ctx.storage, entry)
	}

	total(): Promise<number> {
		return readTotal(this.ctx.storage)
	}

	reject(): never {
		throw new RangeError('ledger is closed')
	}

	async fetch(request: Request): Promise<Response> {
		return streamedResponse('ledger', request, await request.text())
	}
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url)
		const [, scope, action = ''] = url.pathname.split('/')
		if (scope === 'call-mailbox') {
			if (action === 'modules') return Response.json(await env.MAILBOX.getByName('shared').modules())
			if (action === 'ledger-from-do') return Response.json(await env.MAILBOX.getByName('shared').ledgerTotal('shared'))
			const response = await callPeer(env.MAILBOX, action)
			if (response) return response
		}
		if (scope === 'own') {
			if (action === 'total') return Response.json(await env.LEDGER.getByName('shared').total())
			if (action === 'id') return Response.json(env.LEDGER.idFromName('shared').toString())
		}
		if (scope === 'missing-worker') return caught(() => env.MISSING_WORKER.getByName('x').total())
		if (scope === 'missing-class') return caught(() => env.MISSING_CLASS.getByName('x').total())
		return new Response('ledger: not found', { status: 404 })
	},
}
