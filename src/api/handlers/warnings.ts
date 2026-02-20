import type { Warning } from '../../warnings'
import { getWarnings } from '../../warnings'

export const handlers = {
	'warnings.get'(_input: {}): Warning[] {
		return getWarnings()
	},
}
