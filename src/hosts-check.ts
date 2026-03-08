import { readFileSync } from 'node:fs'
import type { LopataConfig } from './lopata-config'

export interface HostsEntry {
	address: string
	hostnames: string[]
}

export interface HostCheckResult {
	hostname: string
	workerName: string
	status: 'ok' | 'missing' | 'wrong_address' | 'wildcard'
	address?: string
}

const LOCALHOST_ADDRESSES = new Set(['127.0.0.1', '::1', 'localhost'])

export function getHostsFilePath(): string {
	if (process.platform === 'win32') {
		return 'C:\\Windows\\System32\\drivers\\etc\\hosts'
	}
	return '/etc/hosts'
}

export function parseHostsFile(content: string): HostsEntry[] {
	const entries: HostsEntry[] = []
	for (const line of content.split('\n')) {
		const trimmed = line.trim()
		if (trimmed === '' || trimmed.startsWith('#')) continue
		const parts = trimmed.split(/\s+/)
		if (parts.length < 2) continue
		entries.push({ address: parts[0]!, hostnames: parts.slice(1) })
	}
	return entries
}

export function readSystemHostsFile(): { path: string; entries: HostsEntry[] } | { path: string; error: string } {
	const path = getHostsFilePath()
	try {
		const content = readFileSync(path, 'utf-8')
		return { path, entries: parseHostsFile(content) }
	} catch {
		return { path, error: `Could not read hosts file at ${path}` }
	}
}

export function checkHostPatterns(
	hostsEntries: HostsEntry[],
	lopataConfig: LopataConfig | null,
): HostCheckResult[] {
	const results: HostCheckResult[] = []

	if (!lopataConfig?.workers) return results

	for (const worker of lopataConfig.workers) {
		if (!worker.hosts) continue
		for (const host of worker.hosts) {
			if (host.startsWith('*.')) {
				results.push({ hostname: host, workerName: worker.name, status: 'wildcard' })
				continue
			}

			const entry = hostsEntries.find(e => e.hostnames.includes(host))
			if (!entry) {
				results.push({ hostname: host, workerName: worker.name, status: 'missing' })
			} else if (!LOCALHOST_ADDRESSES.has(entry.address)) {
				results.push({ hostname: host, workerName: worker.name, status: 'wrong_address', address: entry.address })
			} else {
				results.push({ hostname: host, workerName: worker.name, status: 'ok', address: entry.address })
			}
		}
	}

	return results
}
