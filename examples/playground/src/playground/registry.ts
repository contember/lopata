export interface Section {
	slug: string
	title: string
	html: string
	handle(request: Request, env: Env, ctx: ExecutionContext): Promise<Response | null> | Response | null
}

const sections: Section[] = []

export function registerSection(s: Section): void {
	sections.push(s)
}

export function getSections(): readonly Section[] {
	return sections
}
