import { useEffect, useState } from 'preact/hooks'

export function useRoute(): string {
	const [route, setRoute] = useState(location.hash.slice(1) || '/')

	useEffect(() => {
		const handler = () => setRoute(location.hash.slice(1) || '/')
		window.addEventListener('hashchange', handler)
		return () => window.removeEventListener('hashchange', handler)
	}, [])

	return route
}

export function navigate(path: string) {
	location.hash = path
}

export function replaceRoute(path: string) {
	history.replaceState(null, '', '#' + path)
}

export function parseHashRoute(hash: string): { segments: string[]; query: URLSearchParams } {
	const raw = hash.startsWith('#') ? hash.slice(1) : hash
	const qIdx = raw.indexOf('?')
	const pathname = qIdx >= 0 ? raw.slice(0, qIdx) : raw
	const queryStr = qIdx >= 0 ? raw.slice(qIdx + 1) : ''
	const segments = pathname.split('/').filter(Boolean)
	return { segments, query: new URLSearchParams(queryStr) }
}

export function parseBrowserRoute(segments: string[], baseLen: number): { tab: 'data' | 'schema' | 'sql'; table: string | null } {
	const rawTab = segments[baseLen]
	const tab = rawTab === 'schema' || rawTab === 'sql' ? rawTab : 'data' as const
	const table = segments[baseLen + 1] ? decodeURIComponent(segments[baseLen + 1]) : null
	return { tab, table }
}

export function formatBytes(bytes: number): string {
	if (bytes === 0) return '0 B'
	const units = ['B', 'KB', 'MB', 'GB']
	const i = Math.floor(Math.log(bytes) / Math.log(1024))
	return `${(bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`
}

export function formatTime(ts: number): string {
	return new Date(ts).toLocaleString()
}

export function classNames(...classes: (string | false | null | undefined)[]): string {
	return classes.filter(Boolean).join(' ')
}
