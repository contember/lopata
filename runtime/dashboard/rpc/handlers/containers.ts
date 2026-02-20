import { $ } from 'bun'
import type { ContainerBase } from '../../../bindings/container'
import { DockerManager } from '../../../bindings/container-docker'
import { getDatabase } from '../../../db'
import type { ContainerDetail, ContainerInstance, ContainerSummary, HandlerContext, OkResponse } from '../types'
import { getAllConfigs, getDoNamespace } from '../types'

interface DockerPsEntry {
	Names: string
	State: string
	Status: string
	Ports: string
}

const DOCKER_JSON_FORMAT = '{{json .}}'

async function listDockerContainers(filterPrefix: string): Promise<DockerPsEntry[]> {
	const result = await $`docker ps -a --filter name=${filterPrefix} --format=${DOCKER_JSON_FORMAT}`.quiet().nothrow()
	if (result.exitCode !== 0) return []
	const lines = result.stdout.toString().trim().split('\n').filter(Boolean)
	return lines.map(line => JSON.parse(line) as DockerPsEntry)
}

function parsePorts(portsStr: string): Record<string, string> {
	const ports: Record<string, string> = {}
	if (!portsStr) return ports
	for (const part of portsStr.split(', ')) {
		const match = part.match(/(.+)->(\d+\/\w+)/)
		if (match) {
			ports[match[2]!] = match[1]!
		}
	}
	return ports
}

export const handlers = {
	async 'containers.list'(_input: {}, ctx: HandlerContext): Promise<ContainerSummary[]> {
		const seen = new Map<string, ContainerSummary>()
		const db = getDatabase()

		for (const config of getAllConfigs(ctx)) {
			for (const c of config.containers ?? []) {
				if (seen.has(c.class_name)) continue

				const row = db.query<{ count: number }, [string]>(
					'SELECT COUNT(*) as count FROM do_instances WHERE namespace = ?',
				).get(c.class_name)

				seen.set(c.class_name, {
					className: c.class_name,
					image: c.image,
					maxInstances: c.max_instances ?? null,
					bindingName: c.name ?? c.class_name,
					instanceCount: row?.count ?? 0,
					runningCount: 0,
				})
			}
		}

		// Count running Docker containers per class
		for (const [className, summary] of seen) {
			const entries = await listDockerContainers(`bunflare-${className}-`)
			summary.runningCount = entries.filter(e => e.State === 'running').length
		}

		return Array.from(seen.values())
	},

	async 'containers.listInstances'({ className }: { className: string }, _ctx: HandlerContext): Promise<ContainerInstance[]> {
		const db = getDatabase()

		// Primary source: DO instances from SQLite
		const doInstances = db.query<{ id: string; name: string | null }, [string]>(
			'SELECT id, name FROM do_instances WHERE namespace = ? ORDER BY id',
		).all(className)

		// Secondary source: Docker containers for state info
		const dockerEntries = await listDockerContainers(`bunflare-${className}-`)
		const dockerByPrefix = new Map<string, DockerPsEntry>()
		for (const e of dockerEntries) {
			// Container name format: bunflare-{className}-{idHex.slice(0,12)}
			const prefix = e.Names.replace(`bunflare-${className}-`, '')
			if (prefix) dockerByPrefix.set(prefix, e)
		}

		// Map DO instances with Docker state
		const seenPrefixes = new Set<string>()
		const results: ContainerInstance[] = doInstances.map(inst => {
			const idPrefix = inst.id.slice(0, 12)
			seenPrefixes.add(idPrefix)
			const docker = dockerByPrefix.get(idPrefix)

			return {
				id: inst.id,
				doName: inst.name,
				containerName: docker?.Names ?? `bunflare-${className}-${idPrefix}`,
				state: docker?.State ?? 'stopped',
				ports: docker ? parsePorts(docker.Ports) : {},
			}
		})

		// Include any Docker containers without a matching DO instance
		for (const [prefix, docker] of dockerByPrefix) {
			if (seenPrefixes.has(prefix)) continue
			results.push({
				id: prefix,
				doName: null,
				containerName: docker.Names,
				state: docker.State,
				ports: parsePorts(docker.Ports),
			})
		}

		return results
	},

	async 'containers.getDetail'({ className, id }: { className: string; id: string }, ctx: HandlerContext): Promise<ContainerDetail> {
		const db = getDatabase()
		const docker = new DockerManager()

		// Get DO instance info
		const inst = db.query<{ id: string; name: string | null }, [string, string]>(
			'SELECT id, name FROM do_instances WHERE namespace = ? AND id = ?',
		).get(className, id)

		const containerName = `bunflare-${className}-${id.slice(0, 12)}`

		// Get Docker state
		const dockerInfo = await docker.inspect(containerName)

		// Get container config from live instance if available
		const config = {
			defaultPort: 8080,
			sleepAfter: null as string | number | null,
			enableInternet: true,
			pingEndpoint: '/',
		}

		// Try to find config from wrangler config
		let image = ''
		for (const cfg of getAllConfigs(ctx)) {
			const containerCfg = cfg.containers?.find(c => c.class_name === className)
			if (containerCfg) {
				image = containerCfg.image
				break
			}
		}

		// Try to get config from live DO instance
		const namespace = getDoNamespace(ctx, className)
		if (namespace) {
			const instance = (namespace as any)._getInstance(id) as ContainerBase | null
			if (instance) {
				config.defaultPort = instance.defaultPort ?? 8080
				config.sleepAfter = instance.sleepAfter ?? null
				config.enableInternet = instance.enableInternet
				config.pingEndpoint = instance.pingEndpoint
			}
		}

		return {
			id,
			doName: inst?.name ?? null,
			containerName,
			image,
			state: dockerInfo?.state ?? 'stopped',
			exitCode: dockerInfo?.exitCode ?? null,
			ports: dockerInfo?.ports ?? {},
			created: null, // docker inspect State.StartedAt could be used but not in DockerContainerInfo
			config,
		}
	},

	async 'containers.getLogs'({ className, id, tail }: { className: string; id: string; tail?: number }): Promise<{ logs: string }> {
		const docker = new DockerManager()
		const containerName = `bunflare-${className}-${id.slice(0, 12)}`
		const logs = await docker.logs(containerName, tail)
		return { logs }
	},

	async 'containers.stop'({ className, id }: { className: string; id: string }, ctx: HandlerContext): Promise<OkResponse> {
		const docker = new DockerManager()
		const containerName = `bunflare-${className}-${id.slice(0, 12)}`
		await docker.stop(containerName, 10)
		return { ok: true }
	},

	async 'containers.destroy'({ className, id }: { className: string; id: string }, ctx: HandlerContext): Promise<OkResponse> {
		const docker = new DockerManager()
		const containerName = `bunflare-${className}-${id.slice(0, 12)}`
		await docker.remove(containerName)
		return { ok: true }
	},
}
