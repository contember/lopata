import { getActiveCompatibility } from '../../src/compatibility-context'

function limited(): boolean {
	return getActiveCompatibility().websocketCloseReasonByteLimit === 'enabled'
}

const topLevel = limited()

export default {
	fetch() {
		return Response.json({ topLevel, dispatch: limited() })
	},
}
