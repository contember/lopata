# Cache API

Global `caches` object with `caches.default` and `caches.open(name)`.

## API to implement

### CacheStorage (`caches`)

- `caches.default: Cache` — the default cache
- `caches.open(cacheName: string): Promise<Cache>` — named cache

### Cache

- `match(request: Request | string, options?): Promise<Response | undefined>` — options: `{ ignoreMethod?: boolean }`
- `put(request: Request | string, response: Response): Promise<void>`
- `delete(request: Request | string, options?): Promise<boolean>` — options: `{ ignoreMethod?: boolean }`

## Persistence

Uses the `cache_entries` table in `data.sqlite` (see issue 00).

- Cache key is the request URL
- `put()` stores response status, headers (JSON), and body (BLOB) — response is consumed and fully read before storing
- `match()` reconstructs a `Response` from the stored data
- `delete()` removes the row
- Only GET requests are cacheable (unless `ignoreMethod: true`)
- Responses with `Set-Cookie` header should not be cached (Cloudflare behavior)
- Named caches use the `cache_name` column to separate entries
- `caches.default` uses cache_name `"default"`
- Register `caches` as a global in the plugin/preload
