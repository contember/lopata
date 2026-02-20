const corsHeaders: Record<string, string> = {
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
	'Access-Control-Allow-Headers': 'Content-Type',
}

export function withCors(response: Response): Response {
	for (const [key, value] of Object.entries(corsHeaders)) {
		response.headers.set(key, value)
	}
	return response
}

export function handlePreflight(): Response {
	return new Response(null, { status: 204, headers: corsHeaders })
}
