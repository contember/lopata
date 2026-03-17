import { checkHostPatterns, readSystemHostsFile } from '../hosts-check'
import { loadLopataConfig } from '../lopata-config'
import type { CliContext } from './context'
import { parseArgs } from './context'

export async function run(_ctx: CliContext, args: string[]) {
	const action = args[0]

	if (action !== 'check') {
		console.error('Usage: lopata hosts check')
		process.exit(1)
	}

	parseArgs(args.slice(1), {})

	const baseDir = process.cwd()
	const lopataConfig = await loadLopataConfig(baseDir)

	if (!lopataConfig?.workers?.some(w => w.hosts?.length)) {
		console.log('No host routing configured. Nothing to check.')
		console.log('Host routing is configured via the "hosts" field in lopata.config.ts workers.')
		return
	}

	const hostsFile = readSystemHostsFile()
	if ('error' in hostsFile) {
		console.error(hostsFile.error)
		console.error('Make sure you have read permissions.')
		process.exit(1)
	}

	const results = checkHostPatterns(hostsFile.entries, lopataConfig)
	const hostsPath = hostsFile.path

	console.log(`Hosts file: ${hostsPath}`)
	console.log('')

	for (const r of results) {
		switch (r.status) {
			case 'ok':
				console.log(`  ✓ ${r.hostname} (worker: ${r.workerName}) → ${r.address}`)
				break
			case 'missing':
				console.log(`  ✗ ${r.hostname} (worker: ${r.workerName}) — not found in hosts file`)
				break
			case 'wrong_address':
				console.log(`  ✗ ${r.hostname} (worker: ${r.workerName}) — points to ${r.address}, expected 127.0.0.1`)
				break
			case 'wildcard':
				console.log(`  ⚠ ${r.hostname} (worker: ${r.workerName}) — wildcard pattern, cannot be checked in hosts file`)
				console.log(`    You need to add specific subdomains to your hosts file manually.`)
				if (process.platform === 'darwin') {
					console.log(`    Alternatively, use dnsmasq or a local DNS resolver to handle wildcard domains.`)
				}
				break
		}
	}

	console.log('')

	const failing = results.filter(r => r.status === 'missing' || r.status === 'wrong_address')
	if (failing.length > 0) {
		console.log('Some hostnames are missing or misconfigured.')
		console.log('')
		console.log('Add the missing entries to your hosts file:')
		console.log('')

		const uniqueHostnames = [...new Set(failing.map(m => m.hostname))]
		console.log(`  ${hostsPath}:`)
		console.log(`  127.0.0.1  ${uniqueHostnames.join(' ')}`)
		console.log('')

		if (process.platform !== 'win32') {
			console.log(`Run: sudo sh -c 'echo "127.0.0.1  ${uniqueHostnames.join(' ')}" >> ${hostsPath}'`)
		} else {
			console.log('Open Notepad as Administrator and add the line above to the hosts file.')
		}
	} else if (!results.some(r => r.status === 'wildcard')) {
		console.log('All host routes are correctly configured.')
	}
}
