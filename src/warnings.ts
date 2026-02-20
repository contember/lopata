export interface Warning {
	id: string
	message: string
	install: string
}

const warnings: Warning[] = []

export function addWarning(warning: Warning) {
	if (!warnings.some(w => w.id === warning.id)) {
		warnings.push(warning)
	}
}

export function getWarnings(): Warning[] {
	return warnings
}
