// Returns a response carrying multiple Set-Cookie headers — the shape an auth
// library produces (e.g. a session token cookie + a cached session cookie).
// The runtime must deliver each Set-Cookie to the client separately; folding
// them into one comma-joined header corrupts/drops cookies.
export default {
	async fetch(): Promise<Response> {
		const headers = new Headers()
		headers.set('content-type', 'text/plain')
		headers.append('set-cookie', 'session_token=abc123; Path=/; HttpOnly; SameSite=Lax')
		headers.append('set-cookie', 'session_data=xyz789; Path=/; Max-Age=300; HttpOnly; SameSite=Lax')
		return new Response('ok', { headers })
	},
}
