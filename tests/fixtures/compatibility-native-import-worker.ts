const topLevel = typeof crypto.subtle.encapsulateBits === 'function'

export default {
	fetch() {
		return Response.json({ topLevel, dispatch: typeof crypto.subtle.encapsulateBits === 'function' })
	},
}
