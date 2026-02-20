import { SqliteKVNamespace } from '../bindings/kv'
import type { CliContext } from './context'
import { parseFlag, resolveBinding } from './context'

export async function run(ctx: CliContext, args: string[]) {
	const sub = args[0]
	if (sub !== 'key') {
		console.error(`Usage: bunflare kv key <list|get|put|delete> [options]`)
		process.exit(1)
	}

	const action = args[1]
	const config = await ctx.config()
	const bindingFlag = parseFlag(ctx.args, '--binding')
	const binding = resolveBinding(config.kv_namespaces, bindingFlag, 'KV namespace')
	const kv = new SqliteKVNamespace(ctx.db(), binding.binding)

	switch (action) {
		case 'list': {
			const prefix = parseFlag(ctx.args, '--prefix') ?? ''
			let cursor = ''
			let total = 0
			do {
				const result = await kv.list({ prefix, cursor: cursor || undefined })
				for (const key of result.keys) {
					let line = key.name
					if (key.expiration) {
						const exp = new Date(key.expiration * 1000).toISOString().slice(0, 19).replace('T', ' ')
						line += `  (expires: ${exp})`
					}
					console.log(line)
				}
				total += result.keys.length
				cursor = result.cursor
			} while (cursor)
			if (total === 0) console.log('(no keys)')
			break
		}
		case 'get': {
			const key = args[2]
			if (!key) {
				console.error('Usage: bunflare kv key get <key> [--binding NAME]')
				process.exit(1)
			}
			const value = await kv.get(key)
			if (value === null) {
				console.error(`Key not found: ${key}`)
				process.exit(1)
			}
			if (typeof value === 'string') {
				process.stdout.write(value)
				// Add newline if stdout is a terminal
				if (process.stdout.isTTY) process.stdout.write('\n')
			} else {
				process.stdout.write(String(value))
			}
			break
		}
		case 'put': {
			const key = args[2]
			const value = args[3]
			if (!key || value === undefined) {
				console.error('Usage: bunflare kv key put <key> <value> [--binding NAME]')
				process.exit(1)
			}
			await kv.put(key, value)
			console.log(`Put ${key}`)
			break
		}
		case 'delete': {
			const key = args[2]
			if (!key) {
				console.error('Usage: bunflare kv key delete <key> [--binding NAME]')
				process.exit(1)
			}
			await kv.delete(key)
			console.log(`Deleted ${key}`)
			break
		}
		default:
			console.error(`Usage: bunflare kv key <list|get|put|delete> [options]`)
			process.exit(1)
	}
}
