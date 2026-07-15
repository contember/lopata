import { describe, expect, test } from 'bun:test'
import { buildNodeHeaders } from '../src/vite-plugin/dev-server-plugin'

describe('buildNodeHeaders', () => {
	test('passes regular headers through', () => {
		const response = new Response(null, {
			headers: { 'content-type': 'application/json', 'x-custom': 'yes' },
		})
		const record = buildNodeHeaders(response)
		expect(record['content-type']).toBe('application/json')
		expect(record['x-custom']).toBe('yes')
	})

	test('preserves ALL set-cookie headers as an array', () => {
		// Regression: better-auth sign-up sets session_token + session_data; a
		// keyed record built via headers.forEach kept only the last cookie, so
		// the session token was dropped and every subsequent request was
		// unauthenticated.
		const headers = new Headers()
		headers.append('set-cookie', 'session_token=abc; Path=/; HttpOnly')
		headers.append('set-cookie', 'session_data=xyz; Max-Age=300; Path=/')
		const response = new Response(null, { headers })

		const record = buildNodeHeaders(response)
		expect(record['set-cookie']).toEqual([
			'session_token=abc; Path=/; HttpOnly',
			'session_data=xyz; Max-Age=300; Path=/',
		])
	})

	test('omits set-cookie entirely when the response sets none', () => {
		const response = new Response(null, { headers: { 'content-type': 'text/html' } })
		const record = buildNodeHeaders(response)
		expect('set-cookie' in record).toBe(false)
	})

	test('single set-cookie still arrives as a one-element array', () => {
		const response = new Response(null, {
			headers: { 'set-cookie': 'a=1; Path=/' },
		})
		const record = buildNodeHeaders(response)
		expect(record['set-cookie']).toEqual(['a=1; Path=/'])
	})
})
