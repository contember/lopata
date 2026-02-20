const DEFAULT_CF: Record<string, unknown> = {
	country: 'US',
	city: 'San Francisco',
	continent: 'NA',
	latitude: '37.7749',
	longitude: '-122.4194',
	timezone: 'America/Los_Angeles',
	region: 'California',
	regionCode: 'CA',
	postalCode: '94102',
	metroCode: '807',
	asn: 13335,
	asOrganization: 'Cloudflare',
	colo: 'SFO',
	httpProtocol: 'HTTP/2',
	tlsVersion: 'TLSv1.3',
	tlsCipher: 'AEAD-AES128-GCM-SHA256',
}

export function addCfProperty(request: Request): Request {
	Object.defineProperty(request, 'cf', {
		value: Object.freeze({ ...DEFAULT_CF }),
		writable: false,
		enumerable: false,
		configurable: true,
	})
	return request
}
