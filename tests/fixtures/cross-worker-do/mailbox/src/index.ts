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
import sumModule from './add.wasm'
import blob from './blob.dat'
import notes from './notes.txt'
import prompt from './prompt.md'

interface Env {
	MAILBOX: Namespace<MailboxStub>
	LEDGER: Namespace<LedgerStub>
}

async function loadModules(): Promise<{ prompt: string; sum: number }> {
	const instance = await WebAssembly.instantiate(sumModule)
	const add = instance.exports.add
	if (typeof add !== 'function') throw new Error('add.wasm exports no add()')
	return { prompt, sum: add(2, 3) }
}

export class Mailbox extends DurableObject<Env> {
	record(entry: Entry): Promise<Receipt> {
		return recordEntry(this.ctx.storage, entry)
	}

	total(): Promise<number> {
		return readTotal(this.ctx.storage)
	}

	reject(): never {
		throw new TypeError('mailbox is full')
	}

	modules(): Promise<{ prompt: string; sum: number }> {
		return loadModules()
	}

	/** A Durable Object calling a class another worker hosts. */
	ledgerTotal(account: string): Promise<number> {
		return this.env.LEDGER.getByName(account).total()
	}

	async fetch(request: Request): Promise<Response> {
		return streamedResponse('mailbox', request, await request.text())
	}
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url)
		const [, , scope, action = ''] = url.pathname.split('/')
		if (scope === 'call-ledger') {
			const response = await callPeer(env.LEDGER, action)
			if (response) return response
		}
		if (scope === 'own') {
			if (action === 'total') return Response.json(await env.MAILBOX.getByName('shared').total())
			if (action === 'id') return Response.json(env.MAILBOX.idFromName('shared').toString())
		}
		if (scope === 'modules') return Response.json(await loadModules())
		if (scope === 'rules') {
			return Response.json({
				notes,
				data: [...new Uint8Array(blob)],
				// The Data rule for *.dat has no fallthrough, so the default *.bin Data rule is removed.
				removed: await caught(() => import('./blob.bin')).then(response => response.json()),
			})
		}
		return new Response('mailbox: not found', { status: 404 })
	},
}
