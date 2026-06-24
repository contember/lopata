/**
 * Local implementation of the Cloudflare VPC Networks binding (`vpc_networks`).
 *
 * On Cloudflare, this binding exposes a Fetcher-like `fetch()` method that
 * routes the request through the bound tunnel or Cloudflare Mesh. The URL
 * passed to `fetch()` determines the destination host/port.
 *
 * In local dev there is no tunnel overlay network, so we pass the request
 * straight to the host system's stack — the caller is expected to arrange
 * for the destination to be reachable locally (e.g. a dev service on a
 * known port, or a VPN/WireGuard tunnel on the host).
 */

export interface VpcNetworkConfig {
	networkId: string
	bindingName: string
}

export class VpcNetworkBinding {
	private config: VpcNetworkConfig

	constructor(config: VpcNetworkConfig) {
		this.config = config
	}

	get networkId(): string {
		return this.config.networkId
	}

	async fetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
		const request = input instanceof Request ? new Request(input, init) : new Request(input.toString(), init)
		const url = new URL(request.url)
		if (!url.host) {
			throw new Error(
				`VPC Network binding "${this.config.bindingName}" requires an absolute URL (with host), got: ${request.url}`,
			)
		}
		return fetch(request)
	}
}
