import type { Procedures } from './server'

type EmptyObject = Record<string, never>

export async function rpc<K extends keyof Procedures>(
	procedure: K,
	...args: Procedures[K]['input'] extends EmptyObject ? [] : [Procedures[K]['input']]
): Promise<Procedures[K]['output']> {
	const input = args[0] ?? {}
	const res = await fetch('/__dashboard/api/rpc', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ procedure, input }),
	})
	if (!res.ok) {
		const text = await res.text()
		throw new Error(text)
	}
	return res.json()
}
