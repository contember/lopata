import { DurableObject } from 'cloudflare:workers'

/** Counts in both storage backends, so each worker's do_storage rows and do-sql file are exercised. */
export class Counter extends DurableObject {
	increment(): number {
		this.ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS hits (at INTEGER)')
		this.ctx.storage.sql.exec('INSERT INTO hits (at) VALUES (?)', Date.now())
		const count = this.ctx.storage.kv.get<number>('count') ?? 0
		this.ctx.storage.kv.put('count', count + 1)
		return count + 1
	}
}

interface CounterStub {
	increment(): Promise<number>
}

export interface Env {
	COUNTER: { getByName(name: string): CounterStub }
}

export async function handleIncrement(env: Env): Promise<Response> {
	return Response.json(await env.COUNTER.getByName('shared').increment())
}
