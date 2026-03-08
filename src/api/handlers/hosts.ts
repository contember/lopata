import { checkHostPatterns, readSystemHostsFile } from '../../hosts-check'
import type { HandlerContext, HostsCheckResponse } from '../types'

export const handlers = {
	'hosts.check'(_input: {}, ctx: HandlerContext): HostsCheckResponse {
		const hostsFile = readSystemHostsFile()

		if ('error' in hostsFile) {
			return { results: [], hostsFilePath: hostsFile.path, error: hostsFile.error }
		}

		const results = checkHostPatterns(hostsFile.entries, ctx.lopataConfig)
		return { results, hostsFilePath: hostsFile.path }
	},
}
