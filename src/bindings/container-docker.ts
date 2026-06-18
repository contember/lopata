import { $ } from 'bun'

export interface DockerRunOptions {
	image: string
	name: string
	ports: Map<number, number> // containerPort -> hostPort
	envVars?: Record<string, string>
	entrypoint?: string[]
	enableInternet?: boolean
}

export interface DockerContainerInfo {
	id: string
	name: string
	state: string // "running", "exited", "created", etc.
	exitCode: number | null
	ports: Record<string, string>
	/** Container labels (e.g. `lopata.pid`) — used to detect a container left by a
	 *  crashed/foreign lopata process before adopting it by name. */
	labels: Record<string, string>
}

// Image build cache: tag -> { mtime }
const imageCache = new Map<string, { mtime: number }>()

const DOCKER_JSON_FORMAT = '{{json .}}'

export interface DockerManagerOptions {
	/** Called after a container is successfully created via `run()`. */
	onRegister?: (name: string) => void
	/** Called after a container is removed via `remove()`. */
	onRemove?: (name: string) => void
	/**
	 * Labels passed to every `docker run` (`--label key=value`).
	 * Cleanup uses these to detect orphans from crashed processes.
	 */
	labels?: Record<string, string>
}

export class DockerManager {
	private _onRegister?: (name: string) => void
	private _onRemove?: (name: string) => void
	private _labels?: Record<string, string>

	constructor(options?: DockerManagerOptions) {
		this._onRegister = options?.onRegister
		this._onRemove = options?.onRemove
		this._labels = options?.labels
	}

	/**
	 * Build an image from a Dockerfile, with lazy mtime-based caching.
	 * Skips rebuild if the Dockerfile hasn't changed since last build.
	 */
	async buildImage(dockerfilePath: string, tag: string, context?: string): Promise<void> {
		const file = Bun.file(dockerfilePath)
		if (!(await file.exists())) {
			throw new Error(`Dockerfile not found: ${dockerfilePath}`)
		}
		const mtime = file.lastModified
		const cached = imageCache.get(tag)
		if (cached && cached.mtime === mtime) {
			return // Image already built and Dockerfile unchanged
		}

		const buildContext = context ?? (dockerfilePath.substring(0, dockerfilePath.lastIndexOf('/')) || '.')
		const result = await $`docker build -t ${tag} -f ${dockerfilePath} ${buildContext}`.quiet().nothrow()
		if (result.exitCode !== 0) {
			throw new Error(`Docker build failed (exit ${result.exitCode}): ${result.stderr.toString()}`)
		}
		imageCache.set(tag, { mtime })
	}

	/**
	 * Run a container and return its container ID.
	 */
	async run(options: DockerRunOptions): Promise<string> {
		const args: string[] = ['docker', 'run', '-d', '--name', options.name]

		// Labels (orphan reaping etc.)
		if (this._labels) {
			for (const [key, value] of Object.entries(this._labels)) {
				args.push('--label', `${key}=${value}`)
			}
		}

		// Port mappings
		for (const [containerPort, hostPort] of options.ports) {
			args.push('-p', `${hostPort}:${containerPort}`)
		}

		// Environment variables
		if (options.envVars) {
			for (const [key, value] of Object.entries(options.envVars)) {
				args.push('-e', `${key}=${value}`)
			}
		}

		// Network isolation
		if (options.enableInternet === false) {
			args.push('--network', 'none')
		}

		// Entrypoint override
		if (options.entrypoint && options.entrypoint.length > 0) {
			args.push('--entrypoint', options.entrypoint[0]!)
			// Additional entrypoint args go after the image
		}

		args.push(options.image)

		// Entrypoint additional args
		if (options.entrypoint && options.entrypoint.length > 1) {
			args.push(...options.entrypoint.slice(1))
		}

		const result = await $`${args}`.quiet().nothrow()
		if (result.exitCode !== 0) {
			throw new Error(`Docker run failed (exit ${result.exitCode}): ${result.stderr.toString()}`)
		}

		const containerId = result.stdout.toString().trim()
		this._onRegister?.(options.name)
		return containerId
	}

	/**
	 * Fire the `onRegister` callback for a container we didn't create via
	 * `run()` — e.g. one adopted at startup because it was already running.
	 * Lets cleanup hooks (process-exit handler) track it the same way.
	 */
	registerExisting(name: string): void {
		this._onRegister?.(name)
	}

	/**
	 * Stop a running container gracefully.
	 */
	async stop(name: string, timeoutSec?: number): Promise<void> {
		const args = ['docker', 'stop']
		if (timeoutSec !== undefined) {
			args.push('-t', String(timeoutSec))
		}
		args.push(name)
		await $`${args}`.quiet().nothrow()
	}

	/**
	 * Kill a container immediately.
	 */
	async kill(name: string): Promise<void> {
		await $`docker kill ${name}`.quiet().nothrow()
	}

	/**
	 * Send a signal to a container.
	 */
	async signal(name: string, sig: number): Promise<void> {
		await $`docker kill --signal ${sig} ${name}`.quiet().nothrow()
	}

	/**
	 * Inspect a container and return its info, or null if not found.
	 */
	async inspect(name: string): Promise<DockerContainerInfo | null> {
		const result = await $`docker inspect ${name} --format=${DOCKER_JSON_FORMAT}`.quiet().nothrow()
		if (result.exitCode !== 0) return null

		try {
			const data = JSON.parse(result.stdout.toString())

			// Flatten NetworkSettings.Ports from { "80/tcp": [{"HostIp":"0.0.0.0","HostPort":"32768"}] }
			// into { "80/tcp": "0.0.0.0:32768" }
			const rawPorts = data.NetworkSettings?.Ports ?? {}
			const ports: Record<string, string> = {}
			for (const [containerPort, bindings] of Object.entries(rawPorts)) {
				if (Array.isArray(bindings) && bindings.length > 0) {
					const b = bindings[0] as { HostIp?: string; HostPort?: string }
					ports[containerPort] = `${b.HostIp || '0.0.0.0'}:${b.HostPort || '?'}`
				}
			}

			const state = data.State?.Status ?? 'unknown'
			const rawLabels = data.Config?.Labels ?? {}
			const labels: Record<string, string> = {}
			for (const [k, v] of Object.entries(rawLabels)) {
				if (typeof v === 'string') labels[k] = v
			}
			return {
				id: data.Id ?? '',
				name: (data.Name ?? '').replace(/^\//, ''),
				state,
				exitCode: state === 'running' ? null : (data.State?.ExitCode ?? null),
				ports,
				labels,
			}
		} catch {
			return null
		}
	}

	/**
	 * Get logs from a container.
	 */
	async logs(name: string, tail?: number): Promise<string> {
		const args = ['docker', 'logs']
		if (tail) args.push('--tail', String(tail))
		args.push(name)
		const result = await $`${args}`.quiet().nothrow()
		if (result.exitCode !== 0) return ''
		// docker logs outputs to both stdout and stderr
		return result.stdout.toString() + result.stderr.toString()
	}

	/**
	 * Remove a container (force).
	 */
	async remove(name: string): Promise<void> {
		await $`docker rm -f ${name}`.quiet().nothrow()
		this._onRemove?.(name)
	}

	/**
	 * Allocate a random available port by binding to port 0.
	 */
	static async allocatePort(): Promise<number> {
		const server = Bun.serve({
			port: 0,
			fetch() {
				return new Response()
			},
		})
		const port = server.port
		server.stop(true)
		if (!port || port <= 0) {
			throw new Error('Failed to allocate port')
		}
		return port
	}
}
