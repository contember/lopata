# Cloudflare Workers Compatibility Matrix — Feature List

> Comprehensive list of Cloudflare Workers features and APIs for Bunflare compatibility tracking.
> Each item is a short description of a feature / flag / config option / class / method.
>
> **Legend:** ✅ implemented — ⚠️ partial / stub — ❌ not implemented — 🟰 native (provided by Bun runtime)

---

## Summary

| Area | Coverage | Notes |
|------|----------|-------|
| **Workers Core API** | ~75% | Native Web APIs via Bun; missing HTMLRewriter, WebSocketPair, tail/email handlers |
| **KV** | 100% | All methods, bulk ops, limits, validation |
| **D1** | ~90% | Missing named params, some meta fields, session is stub |
| **R2** | ~95% | Missing SSE-C, storageClass only "Standard" |
| **Durable Objects** | ~90% | Missing sync KV API, transactionSync, state.abort |
| **Queues** | ~90% | Missing pull-based consumers, max_concurrency |
| **Workflows** | 100% | Full lifecycle, checkpointing, concurrency |
| **Cache API** | 100% | put/match/delete, TTL, expiration, validation |
| **Static Assets** | ~90% | Missing _redirects file |
| **Service Bindings** | ~85% | Missing RpcTarget semantics, stub lifecycle |
| **Scheduled (Cron)** | 100% | Full cron parser, aliases, manual trigger |
| **Images** | ~80% | Sharp-based transforms; missing segment, border, some color opts |
| **Environment Variables** | 100% | [vars], .dev.vars, .env, cloudflare:workers env import |
| **Overall** | **~90-95%** | All major bindings fully implemented |

### Top Missing Features

| Priority | Feature | Notes |
|----------|---------|-------|
| Medium | HTMLRewriter | Popular API, needs external lib (lol-html WASM) |
| Medium | WebSocketPair (regular Workers) | Only DO WebSocket hibernation exists |
| Low | IdentityTransformStream / FixedLengthStream | CF-specific stream classes |
| Low | DO sync KV API (`storage.kv.*`) | Newer API |
| Low | `_redirects` file | Static asset redirects |
| Low | Pull-based queue consumers | HTTP pull mode |
| Very low | Tail / Email handlers | Hard to simulate locally |
| Very low | crypto.DigestStream, timingSafeEqual | Supplementary crypto APIs |
| Very low | navigator.userAgent mock | Trivial |

---

## 1. Workers Core API

### 1.1 Request

- 🟰 `new Request(input, init?)` — constructor
- 🟰 `request.method` — HTTP method string
- 🟰 `request.url` — request URL string
- 🟰 `request.headers` — Headers object
- 🟰 `request.body` — ReadableStream | null
- 🟰 `request.bodyUsed` — boolean
- 🟰 `request.redirect` — "follow" | "error" | "manual"
- 🟰 `request.signal` — AbortSignal
- 🟰 `request.clone()` — copy the Request
- 🟰 `request.arrayBuffer()` — read body as ArrayBuffer
- 🟰 `request.formData()` — read body as FormData
- 🟰 `request.json()` — read body as JSON
- 🟰 `request.text()` — read body as string
- 🟰 `request.blob()` — read body as Blob

### 1.2 Request `cf` Object (IncomingRequestCfProperties)

- ✅ `cf.asn` — autonomous system number
- ✅ `cf.asOrganization` — AS organization name
- ✅ `cf.colo` — IATA data center code
- ✅ `cf.httpProtocol` — e.g. "HTTP/2"
- ✅ `cf.tlsCipher` — TLS cipher suite
- ✅ `cf.tlsVersion` — e.g. "TLSv1.3"
- ❌ `cf.tlsClientCiphersSha1` — Base64-encoded
- ❌ `cf.tlsClientExtensionsSha1` — Base64-encoded
- ❌ `cf.tlsClientHelloLength` — ClientHello length
- ❌ `cf.tlsClientRandom` — Base64 random bytes
- ❌ `cf.tlsExportedAuthenticator` — exported authenticator data
- ✅ `cf.country` — ISO 3166-1 alpha-2
- ❌ `cf.isEUCountry` — "1" if in EU
- ✅ `cf.city` — city name
- ✅ `cf.continent` — continent code
- ✅ `cf.latitude` — latitude string
- ✅ `cf.longitude` — longitude string
- ✅ `cf.postalCode` — postal code
- ✅ `cf.metroCode` — metro code
- ✅ `cf.region` — ISO 3166-2 name
- ✅ `cf.regionCode` — ISO 3166-2 code
- ✅ `cf.timezone` — IANA timezone
- ❌ `cf.clientAcceptEncoding` — original Accept-Encoding
- ❌ `cf.botManagement.score` — bot score 1-99 (enterprise)
- ❌ `cf.botManagement.verifiedBot` — known good bot
- ❌ `cf.botManagement.staticResource` — static resource request
- ❌ `cf.botManagement.ja3Hash` — JA3 fingerprint
- ❌ `cf.botManagement.ja4` — JA4 fingerprint
- ❌ `cf.botManagement.detectionIds` — detection IDs
- ❌ `cf.tlsClientAuth.*` — mTLS client certificate properties (certIssuerDN, certSubjectDN, certFingerprintSHA1, certFingerprintSHA256, certNotBefore, certNotAfter, certSerial, certPresented, certVerified, certRevoked, etc.)

> **Note:** cf object uses mock values (San Francisco / SFO). Advanced properties like botManagement and tlsClientAuth require real Cloudflare infrastructure.

### 1.3 RequestInit `cf` Options (outbound subrequests)

- ❌ `cf.cacheEverything` — force cache all content types
- ❌ `cf.cacheKey` — custom cache key (Enterprise)
- ❌ `cf.cacheTags` — cache tags for purge
- ❌ `cf.cacheTtl` — override edge cache TTL
- ❌ `cf.cacheTtlByStatus` — per-status TTL overrides
- ❌ `cf.image` — Image Resizing options
- ❌ `cf.polish` — "lossy" | "lossless" | "off"
- ❌ `cf.resolveOverride` — override DNS resolution
- ❌ `cf.scrapeShield` — enable Scrape Shield
- ❌ `cf.webp` — convert images to WebP
- ❌ `cf.minify` — { javascript, css, html } Auto Minify
- ❌ `cf.mirage` — Mirage image optimization
- ❌ `cf.apps` — run Cloudflare Apps

> **Note:** Outbound cf options are Cloudflare edge features that cannot be simulated locally. Passed through as no-ops.

### 1.4 Response

- 🟰 `new Response(body?, init?)` — constructor
- 🟰 `response.status` — HTTP status code
- 🟰 `response.statusText` — status message
- 🟰 `response.headers` — Headers object
- 🟰 `response.ok` — true if 200-299
- 🟰 `response.redirected` — boolean
- 🟰 `response.url` — response URL
- 🟰 `response.body` — ReadableStream | null
- 🟰 `response.bodyUsed` — boolean
- ❌ `response.webSocket` — WebSocket | null
- 🟰 `response.clone()` — copy the Response
- 🟰 `response.arrayBuffer()` — read body
- 🟰 `response.formData()` — read body
- 🟰 `response.json()` — read body
- 🟰 `response.text()` — read body
- 🟰 `response.blob()` — read body
- 🟰 `Response.json(data, init?)` — static, create JSON response
- 🟰 `Response.redirect(url, status?)` — static, create redirect
- ❌ `encodeBody` option — "manual" | "automatic" for Content-Encoding

### 1.5 ExecutionContext

- ✅ `ctx.waitUntil(promise)` — extend Worker lifetime past response
- ✅ `ctx.passThroughOnException()` — fail open to origin on error (no-op in dev)
- ❌ `ctx.props` — arbitrary JSON from Service Bindings
- ❌ `ctx.exports` — loopback bindings for exports (enable_ctx_exports flag)
- ❌ `waitUntil()` standalone import from `cloudflare:workers`

### 1.6 Fetch Handler

- ✅ `export default { fetch }` — module worker handler
- ✅ Class-based `WorkerEntrypoint` with `fetch()` method
- ❌ `addEventListener("fetch", ...)` — legacy service worker syntax
- ✅ Handler receives `(request, env, ctx)`

### 1.7 Headers

- 🟰 `headers.get(name)` — get header value
- 🟰 `headers.set(name, value)` — set header
- 🟰 `headers.append(name, value)` — append value
- 🟰 `headers.delete(name)` — remove header
- 🟰 `headers.has(name)` — check existence
- 🟰 `headers.entries()` / `keys()` / `values()` — iterators
- 🟰 `headers.forEach(callback)` — iterate
- 🟰 `headers.getAll(name)` — non-standard, only for Set-Cookie
- 🟰 `headers.getSetCookie()` — standard Set-Cookie accessor

### 1.8 URL / URLSearchParams / URLPattern

- 🟰 Standard WHATWG URL API (url_standard flag)
- 🟰 URLSearchParams standard methods (append, delete, get, getAll, has, set, sort, etc.)
- 🟰 `urlsearchparams_delete_has_value_arg` flag — delete/has with value argument
- 🟰 URLPattern — route matching with named groups, wildcards, regex
- 🟰 `fetch_standard_url` flag — WHATWG URL parsing in fetch()

### 1.9 Streams API

- 🟰 `new ReadableStream(underlyingSource?, strategy?)` — constructor (streams_enable_constructors flag)
- 🟰 `ReadableStream.pipeTo(destination, options?)` — pipe to WritableStream
- 🟰 `ReadableStream.pipeThrough(transformStream)` — pipe through TransformStream
- 🟰 `ReadableStream.getReader(options?)` — default or BYOB reader
- 🟰 `ReadableStream.tee()` — split into two streams
- 🟰 `ReadableStream.cancel(reason?)` — cancel
- 🟰 `ReadableStream.values()` — async iterator
- 🟰 `ReadableStreamDefaultReader` — read(), cancel(), releaseLock()
- 🟰 `ReadableStreamBYOBReader` — read(view), cancel(), releaseLock()
- 🟰 `WritableStream` — accessed via TransformStream.writable
- 🟰 `WritableStreamDefaultWriter` — write(), close(), abort(), releaseLock()
- 🟰 `new TransformStream()` — identity transform (CF default)
- 🟰 `transformstream_enable_standard_constructor` flag — spec-compliant constructor
- ❌ `new IdentityTransformStream()` — forwards bytes, supports BYOB
- ❌ `new FixedLengthStream(length)` — limits total bytes, sets Content-Length
- 🟰 PipeToOptions: preventClose, preventAbort, preventCancel, signal

### 1.10 Encoding

- 🟰 `TextEncoder` — encode(), encodeInto()
- 🟰 `TextDecoder` — decode(), supports all WHATWG encodings
- 🟰 `TextEncoderStream` / `TextDecoderStream` — streaming encode/decode

### 1.11 Web Crypto

- 🟰 `crypto.getRandomValues(buffer)` — fill with random bytes
- 🟰 `crypto.randomUUID()` — RFC 4122 v4 UUID
- 🟰 `crypto.subtle.encrypt()` — encrypt data
- 🟰 `crypto.subtle.decrypt()` — decrypt data
- 🟰 `crypto.subtle.sign()` — sign data
- 🟰 `crypto.subtle.verify()` — verify signature
- 🟰 `crypto.subtle.digest()` — compute hash
- 🟰 `crypto.subtle.generateKey()` — generate key/pair
- 🟰 `crypto.subtle.deriveKey()` — derive key
- 🟰 `crypto.subtle.deriveBits()` — derive bits
- 🟰 `crypto.subtle.importKey()` — import key
- 🟰 `crypto.subtle.exportKey()` — export key
- 🟰 `crypto.subtle.wrapKey()` — wrap key
- 🟰 `crypto.subtle.unwrapKey()` — unwrap key
- ❌ `crypto.subtle.timingSafeEqual(a, b)` — non-standard, timing-safe compare
- ❌ `crypto.DigestStream` — WritableStream that computes hash digest
- 🟰 Algorithms: RSASSA-PKCS1-v1_5, RSA-PSS, RSA-OAEP, ECDSA, ECDH, Ed25519, X25519, AES-CTR/CBC/GCM/KW, SHA-1/256/384/512, MD5, HKDF, PBKDF2, HMAC

### 1.12 HTMLRewriter

- ❌ `new HTMLRewriter()` — constructor
- ❌ `.on(selector, handler)` — element handler
- ❌ `.onDocument(handler)` — document handler
- ❌ `.transform(response)` — transform response
- ❌ CSS selectors: *, E, E:nth-child(n), E:first-child, E:nth-of-type(n), E:first-of-type, E:not(s), E.class, E#id, E[attr], E[attr="val"], E[attr~="val"], E[attr^="val"], E[attr$="val"], E[attr*="val"], E[attr|="val"], E F, E > F
- ❌ Element: tagName, attributes, removed, namespaceURI, getAttribute, hasAttribute, setAttribute, removeAttribute, before, after, prepend, append, replace, setInnerContent, remove, removeAndKeepContent, onEndTag
- ❌ EndTag: name, before, after, remove
- ❌ Text: text, lastInTextNode, removed, before, after, replace, remove
- ❌ Comment: text, removed, before, after, replace, remove
- ❌ Document: doctype, comments, text, end

> **Note:** HTMLRewriter requires lol-html (Cloudflare's Rust-based HTML parser). Could be implemented via lol-html WASM build.

### 1.13 WebSocket

- ❌ `new WebSocketPair()` — create client/server pair
- ❌ `ws.accept()` — begin handling (CF-specific)
- 🟰 `ws.send(message)` — send data
- 🟰 `ws.close(code?, reason?)` — close connection
- 🟰 `ws.addEventListener(type, listener)` — register handler
- 🟰 `ws.readyState` — 0/1/2/3
- 🟰 Events: open, message, close, error
- 🟰 Max message size: 1 MiB
- ❌ WebSocket upgrade: `new Response(null, { status: 101, webSocket: client })`
- ❌ `web_socket_compression` flag — RFC 7692 per-message deflate

> **Note:** WebSocket hibernation API in Durable Objects IS fully implemented. Only regular Worker WebSocketPair is missing.

### 1.14 Global fetch()

- 🟰 `fetch(input, init?)` — make HTTP subrequest
- 🟰 Automatic gzip/brotli decompression
- 🟰 `brotli_content_encoding` flag — Brotli support
- 🟰 `cache: "no-store"` — bypass CF cache
- 🟰 `cache: "no-cache"` — force revalidation
- 🟰 `allow_custom_ports` flag — non-standard ports
- ❌ Subrequest limits: 50 (free), 10,000 (paid) — not enforced
- ❌ Simultaneous connections: 6 — not enforced
- ❌ Loop limit: 16 Worker invocations in chain — not enforced

### 1.15 Scheduled Handler

- ✅ `export default { scheduled }` — cron handler
- ✅ `controller.scheduledTime` — epoch ms
- ✅ `controller.cron` — cron expression string
- ✅ `controller.noRetry()` — prevent retries
- ✅ Automatic retries on failure (~3 attempts)
- ✅ Max 5 cron triggers per Worker (free), 250 (paid) — not enforced but parsed
- ✅ `controller.type` — "scheduled"
- ✅ Special cron aliases: @daily, @hourly, @weekly, @monthly, @yearly
- ✅ Day/month names: MON-SUN, JAN-DEC
- ✅ Manual trigger: `GET /cdn-cgi/handler/scheduled?cron=<expr>`

### 1.16 Tail Handler

- ❌ `export default { tail }` — tail worker handler
- ❌ `TailItem`: scriptName, event, eventTimestamp, logs, exceptions, outcome
- ❌ `TailLog`: timestamp, level, message
- ❌ `TailException`: timestamp, name, message
- ❌ `TailRequest`: cf, headers, method, url, getUnredacted()

### 1.17 Email Handler

- ❌ `export default { email }` — email handler
- ❌ `message.from` — envelope From
- ❌ `message.to` — envelope To
- ❌ `message.headers` — Headers
- ❌ `message.raw` — ReadableStream
- ❌ `message.rawSize` — size in bytes
- ❌ `message.setReject(reason)` — reject message
- ❌ `message.forward(rcptTo, headers?)` — forward
- ❌ `message.reply(message)` — reply

### 1.18 Navigator & Performance

- ❌ `navigator.userAgent` — "Cloudflare-Workers" (global_navigator flag)
- ❌ `navigator.language` — locale (enable_navigator_language flag)
- 🟰 `performance.now()` — ms since timeOrigin (Bun native, not CF semantics)
- 🟰 `performance.timeOrigin` — Bun native (not always 0 like CF)

### 1.19 Timers & Standard APIs

- 🟰 `setTimeout(fn, delay)` / `clearTimeout(id)`
- 🟰 `setInterval(fn, delay)` / `clearInterval(id)`
- ❌ `scheduler.wait(ms)` — await-able setTimeout alternative
- 🟰 `atob()` / `btoa()` — Base64 encode/decode
- 🟰 `AbortController` / `AbortSignal` — standard
- 🟰 `AbortSignal.timeout(delay)`, `AbortSignal.abort()`, `AbortSignal.any(signals)`
- 🟰 `CompressionStream` / `DecompressionStream` — gzip, deflate, deflate-raw
- 🟰 `structuredClone(value)` — deep copy
- 🟰 `queueMicrotask(fn)`
- 🟰 `console.log/debug/info/warn/error/trace/dir/table`
- 🟰 `EventTarget`, `Event`, `CustomEvent`
- 🟰 `Blob`, `File`, `FormData`
- 🟰 `MessageChannel`, `MessagePort` (expose_global_message_channel flag)
- 🟰 `AsyncLocalStorage` (nodejs_als / nodejs_compat flag)
- 🟰 `WeakRef`, `FinalizationRegistry` (enable_weak_ref flag)
- 🟰 Full `Intl` API

### 1.20 Worker Limits

- ❌ CPU time: 10ms (free), 30s default / 5 min max (paid) — not enforced
- ❌ Memory: 128 MB per isolate — not enforced
- ❌ Worker size: 3 MB compressed (free), 10 MB (paid) — not enforced
- ❌ Env variables: 64 (free), 128 (paid), 5 KB each — not enforced
- ❌ Number of Workers: 100 (free), 500 (paid) — not enforced
- ❌ Requests/day: 100,000 (free), unlimited (paid) — not enforced
- ❌ URL length: 16 KB — not enforced
- ❌ Request/response headers: 128 KB — not enforced
- ❌ Request body: 100 MB (free/pro), 500 MB (enterprise) — not enforced
- ❌ Console output: 256 KB per request — not enforced
- ❌ Routes per zone: 1,000 — not enforced
- 🟰 WebSocket message: 1 MiB

> **Note:** Worker limits are production deployment constraints. Not enforced in local dev (matching wrangler dev behavior).

---

## 2. KV (Key-Value Storage)

### 2.1 KVNamespace Methods

- ✅ `kv.get(key, options?)` — read single value (text/json/arrayBuffer/stream)
- ✅ `kv.get(keys, options?)` — bulk read up to 100 keys (returns Map)
- ✅ `kv.getWithMetadata(key, options?)` — read value + metadata
- ✅ `kv.getWithMetadata(keys, options?)` — bulk read with metadata
- ✅ `kv.put(key, value, options?)` — write key-value pair
- ✅ `kv.delete(key)` — delete single key
- ✅ `kv.list(options?)` — list keys with pagination

### 2.2 get() Options

- ✅ `type: "text"` — return string (default)
- ✅ `type: "json"` — return parsed JSON
- ✅ `type: "arrayBuffer"` — return ArrayBuffer
- ✅ `type: "stream"` — return ReadableStream
- ✅ `cacheTtl` — edge cache TTL in seconds (accepted, no-op in dev)

### 2.3 put() Options

- ✅ `expiration` — absolute UNIX epoch timestamp (seconds)
- ✅ `expirationTtl` — seconds from now (minimum 60)
- ✅ `metadata` — JSON-serializable object (max 1024 bytes)

### 2.4 list() Options & Result

- ✅ `limit` — max keys (default/max 1000)
- ✅ `prefix` — filter by prefix
- ✅ `cursor` — pagination cursor
- ✅ Result: `{ keys: [{ name, expiration?, metadata? }], list_complete, cursor? }`
- ✅ Keys returned in lexicographic order (UTF-8 bytes)

### 2.5 getWithMetadata() Result

- ✅ `{ value, metadata, cacheStatus }` — cacheStatus always null in dev

### 2.6 Consistency & Limits

- ✅ Key max size: 512 bytes — validated
- ✅ Value max size: 25 MiB — validated
- ✅ Metadata max size: 1024 bytes — validated
- ✅ Key cannot be empty, ".", or ".." — validated
- ✅ Bulk get: max 100 keys — validated
- ✅ All limits configurable via KVLimits
- ⚠️ Eventually consistent — N/A locally (immediate consistency)
- ❌ Max 1 write/second to same key — not enforced
- ❌ Namespaces per account: 1,000 — not enforced
- ❌ Operations per Worker invocation: 1,000 — not enforced

---

## 3. D1 (SQL Database)

### 3.1 D1Database Methods

- ✅ `db.prepare(query)` — prepare SQL statement with ? placeholders
- ✅ `db.batch(statements)` — execute multiple statements as transaction
- ✅ `db.exec(query)` — execute raw SQL (proper statement splitter, handles strings/comments)
- ✅ `db.dump()` — export database as ArrayBuffer
- ⚠️ `db.withSession(option?)` — returns session object (stub, no real replication)

### 3.2 D1PreparedStatement Methods

- ✅ `stmt.bind(...values)` — bind values to ? placeholders (immutable, returns new statement)
- ✅ `stmt.first(column?)` — first row or column value, null if none
- ✅ `stmt.all()` — all rows as D1Result { success, results, meta }
- ✅ `stmt.run()` — execute (results empty for writes)
- ✅ `stmt.raw(options?)` — results as arrays; { columnNames: true } for header row

### 3.3 D1Meta Fields

- ✅ `duration` — query execution ms
- ✅ `rows_read` — rows scanned
- ✅ `rows_written` — rows modified
- ✅ `last_row_id` — last inserted rowid
- ✅ `changed_db` — whether DB was modified
- ✅ `changes` — number of rows changed
- ✅ `size_after` — DB size in bytes after query
- ✅ `served_by` — "bunflare-d1"
- ❌ `served_by_region` — execution region
- ❌ `served_by_primary` — whether primary handled query
- ❌ `timings.sql_duration_ms` — pure SQL time
- ❌ `total_attempts` — query attempts including retries

### 3.4 Parameter Binding

- ✅ Anonymous `?` placeholders
- ✅ Ordered `?NNN` placeholders (via bun:sqlite)
- ❌ Named parameters (`:name`, `@name`, `$name`) — NOT yet supported
- ❌ Max 100 bound parameters per query — not enforced

### 3.5 Type Mapping

- ✅ null → NULL → null
- ✅ Number (int) → INTEGER → Number
- ✅ Number (float) → REAL → Number
- ✅ String → TEXT → String
- ✅ Boolean → INTEGER (0/1) → Number
- ✅ ArrayBuffer/ArrayBufferView → BLOB → Array (of bytes)
- ✅ undefined → throws D1_TYPE_ERROR

### 3.6 Session API (Read Replication)

- ⚠️ `db.withSession()` — returns session (no real replication)
- ⚠️ `db.withSession("first-primary")` — accepted, same behavior
- ⚠️ `db.withSession(bookmark)` — accepted, bookmark ignored
- ⚠️ `session.getBookmark()` — always returns null
- ⚠️ Sequential consistency within session — N/A (single local DB)

### 3.7 Time Travel

- ❌ Always on, 30 days (paid) / 7 days (free) retention
- ❌ Bookmark-based restore
- ❌ Max 10 restores per 10 minutes

### 3.8 Location Hints & Jurisdictions

- ❌ Location hints: wnam, enam, weur, eeur, apac, oc — N/A locally
- ❌ Jurisdictions: eu, fedramp (immutable) — N/A locally

### 3.9 D1 Limits

- ❌ Max DB size: 500 MB (free), 10 GB (paid) — not enforced
- ❌ Queries per invocation: 50 (free), 1,000 (paid) — not enforced
- ❌ SQL statement length: 100 KB — not enforced
- ❌ Max bound parameters: 100 — not enforced
- ❌ Max columns per table: 100 — not enforced
- ❌ Max string/BLOB/row size: 2 MB — not enforced
- ❌ Max query duration: 30 seconds — not enforced

---

## 4. R2 (Object Storage)

### 4.1 R2Bucket Methods

- ✅ `bucket.head(key)` — metadata only, returns R2Object | null
- ✅ `bucket.get(key, options?)` — returns R2ObjectBody | null
- ✅ `bucket.get(key, { onlyIf })` — conditional get, may return R2Object without body
- ✅ `bucket.put(key, value, options?)` — store value
- ✅ `bucket.put(key, value, { onlyIf })` — conditional put, returns null on failure
- ✅ `bucket.delete(keys)` — delete one or multiple keys (up to 1,000)
- ✅ `bucket.list(options?)` — list objects
- ✅ `bucket.createMultipartUpload(key, options?)` — initiate multipart
- ✅ `bucket.resumeMultipartUpload(key, uploadId)` — resume multipart (synchronous)

### 4.2 R2Object Properties

- ✅ `key` — object key
- ✅ `version` — unique version string (UUID)
- ✅ `size` — size in bytes
- ✅ `etag` — ETag without quotes (MD5)
- ✅ `httpEtag` — ETag with quotes
- ✅ `checksums` — R2Checksums (md5 auto-generated)
- ✅ `uploaded` — Date timestamp
- ✅ `httpMetadata` — R2HTTPMetadata | undefined
- ✅ `customMetadata` — Record<string, string> | undefined
- ✅ `range` — R2Range | undefined
- ⚠️ `storageClass` — always "Standard" (no InfrequentAccess)
- ✅ `writeHttpMetadata(headers)` — copy metadata to Headers

### 4.3 R2ObjectBody (extends R2Object)

- ✅ `body` — ReadableStream
- ✅ `bodyUsed` — boolean
- ✅ `arrayBuffer()` / `text()` / `json()` / `blob()` / `bytes()`

### 4.4 R2GetOptions

- ✅ `onlyIf` — R2Conditional | Headers (conditional headers)
- ✅ `range` — R2Range | Headers (byte range)
- ❌ `ssecKey` — SSE-C encryption key

### 4.5 R2PutOptions

- ✅ `onlyIf` — conditional write
- ✅ `httpMetadata` — contentType, contentLanguage, contentDisposition, contentEncoding, cacheControl, cacheExpiry
- ✅ `customMetadata` — arbitrary key-value pairs
- ✅ `md5` / `sha1` / `sha256` / `sha384` / `sha512` — integrity checksums
- ⚠️ `storageClass` — accepted, always stored as "Standard"
- ❌ `ssecKey` — SSE-C encryption key

### 4.6 R2ListOptions

- ✅ `limit` — max 1000 (default 1000)
- ✅ `prefix` — filter by prefix
- ✅ `cursor` — pagination token
- ✅ `delimiter` — grouping character (e.g. "/")
- ✅ `startAfter` — lexicographic start (exclusive)
- ✅ `include` — ["httpMetadata", "customMetadata"]

### 4.7 R2 List Result

- ✅ `objects` — R2Object[]
- ✅ `delimitedPrefixes` — string[]
- ✅ `truncated` — boolean
- ✅ `cursor` — present when truncated

### 4.8 R2Conditional

- ✅ `etagMatches` — If-Match (supports string or string[], wildcards)
- ✅ `etagDoesNotMatch` — If-None-Match
- ✅ `uploadedBefore` — If-Unmodified-Since
- ✅ `uploadedAfter` — If-Modified-Since
- ❌ `secondsGranularity` — use seconds for date comparison

### 4.9 R2Range

- ✅ `{ offset, length? }` — from offset
- ✅ `{ offset?, length }` — for length bytes
- ✅ `{ suffix }` — last N bytes

### 4.10 Multipart Upload

- ✅ `createMultipartUpload(key, options?)` — returns R2MultipartUpload
- ✅ `resumeMultipartUpload(key, uploadId)` — returns handle (synchronous)
- ✅ `upload.uploadPart(partNumber, value)` — upload part (temp files)
- ✅ `upload.abort()` — abort upload
- ✅ `upload.complete(uploadedParts)` — finalize (concatenates parts)
- ✅ Part number starts at 1, min 5 MiB (except last), max 5 GiB, max 10,000 parts
- ❌ Uncompleted uploads auto-abort after 7 days — not enforced

### 4.11 R2 Limits

- ✅ Max key length: 1,024 bytes — validated
- ✅ Max metadata size: 2,048 bytes (custom) — validated
- ✅ Max keys per delete(): 1,000 — validated
- ✅ All limits configurable via R2Limits
- ❌ Max object size: 5 GiB (single put), 5 TiB (multipart) — not enforced
- ❌ Max buckets per account: 1,000,000 — not enforced
- ❌ Jurisdictions: eu, fedramp — N/A locally

---

## 5. Durable Objects

### 5.1 DurableObject Base Class

- ✅ `constructor(ctx: DurableObjectState, env: Env)` — receives state and bindings
- ✅ `fetch(request)` — HTTP request handler (legacy)
- ✅ `alarm(alarmInfo?)` — alarm handler; AlarmInvocationInfo: { retryCount, isRetry }
- ✅ `webSocketMessage(ws, message)` — WebSocket Hibernation handler
- ✅ `webSocketClose(ws, code, reason, wasClean)` — WebSocket close handler
- ✅ `webSocketError(ws, error)` — WebSocket error handler
- ✅ Public methods exposed as RPC

### 5.2 DurableObjectState

- ✅ `state.id` — DurableObjectId (readonly)
- ✅ `state.storage` — DurableObjectStorage (readonly)
- ✅ `state.blockConcurrencyWhile(callback)` — block events during async init
- ✅ `state.waitUntil(promise)` — no-op in DOs (API compat)
- ✅ `state.acceptWebSocket(ws, tags?)` — accept WebSocket for hibernation (max 32,768)
- ✅ `state.getWebSockets(tag?)` — get attached WebSockets
- ✅ `state.setWebSocketAutoResponse(pair?)` — auto-respond without waking DO
- ✅ `state.getWebSocketAutoResponse()` — get current auto-response
- ✅ `state.getWebSocketAutoResponseTimestamp(ws)` — last auto-response time
- ✅ `state.setHibernatableWebSocketEventTimeout(ms?)` — max WS event handler runtime
- ✅ `state.getHibernatableWebSocketEventTimeout()` — get timeout
- ✅ `state.getTags(ws)` — get WebSocket tags
- ❌ `state.abort(message?)` — force reset DO

### 5.3 DurableObjectStorage — SQL API

- ✅ `storage.sql.exec(query, ...bindings)` — execute SQL, returns SqlStorageCursor (synchronous)
- ✅ `storage.sql.databaseSize` — current DB size in bytes
- ✅ SqlStorageCursor: columnNames, rowsRead, rowsWritten, [Symbol.iterator], next(), toArray(), one(), raw()

> **Note:** Each DO instance gets its own SQLite file at `.bunflare/do-sql/<namespace>/<id>.sqlite`

### 5.4 DurableObjectStorage — Synchronous KV API

- ❌ `storage.kv.get(key)` — synchronous get
- ❌ `storage.kv.put(key, value)` — synchronous put
- ❌ `storage.kv.delete(key)` — synchronous delete, returns boolean
- ❌ `storage.kv.list(options?)` — returns Iterable<[string, any]>
- ❌ List options: start, startAfter, end, prefix, reverse, limit

### 5.5 DurableObjectStorage — Async KV API

- ✅ `storage.get(key, options?)` — single key get
- ✅ `storage.get(keys, options?)` — batch get (max 128 keys)
- ✅ `storage.put(key, value, options?)` — single key put
- ✅ `storage.put(entries, options?)` — batch put (max 128 pairs)
- ✅ `storage.delete(key, options?)` — single delete
- ✅ `storage.delete(keys, options?)` — batch delete (max 128 keys)
- ✅ `storage.deleteAll(options?)` — delete all storage
- ✅ `storage.list(options?)` — list all pairs
- ✅ List options: start, startAfter, end, prefix, reverse, limit

### 5.6 Storage Options

- ⚠️ `allowConcurrency` — accepted, no-op in dev
- ⚠️ `allowUnconfirmed` — accepted, no-op in dev
- ⚠️ `noCache` — accepted, no-op in dev

### 5.7 Alarms

- ✅ `storage.getAlarm(options?)` — get alarm time (ms epoch) or null
- ✅ `storage.setAlarm(time, options?)` — set alarm (Date or number); overrides previous
- ✅ `storage.deleteAlarm(options?)` — delete pending alarm
- ✅ One alarm per DO; times in past trigger immediately
- ✅ At-least-once delivery; exponential backoff retry (2s initial, max 6 retries)
- ✅ Alarms persisted to SQLite and restored on startup

### 5.8 Transactions

- ❌ `storage.transactionSync(callback)` — synchronous transaction (SQLite-backed)
- ✅ `storage.transaction(callback)` — async transaction with BEGIN/COMMIT/ROLLBACK
- ⚠️ Transaction object: get, put, delete, deleteAll, list, rollback — simplified (uses same storage)
- ✅ Implicit transactions: multiple writes without await are auto-coalesced

### 5.9 storage.sync()

- ✅ `storage.sync()` — no-op, returns resolved promise (writes are synchronous in SQLite)

### 5.10 DurableObjectId

- ✅ `id.toString()` — 64-digit hex string
- ✅ `id.equals(other)` — compare two IDs
- ✅ `id.name` — name if created via idFromName(), undefined otherwise

### 5.11 DurableObjectNamespace

- ✅ `namespace.idFromName(name)` — deterministic ID from SHA256
- ✅ `namespace.newUniqueId(options?)` — random UUID-based ID; jurisdiction option ignored
- ✅ `namespace.idFromString(hexId)` — reconstruct from hex string
- ✅ `namespace.get(id, options?)` — get stub; locationHint ignored
- ✅ `namespace.getByName(name)` — convenience: idFromName + get
- ❌ `namespace.jurisdiction(jurisdiction)` — sub-namespace scoped to jurisdiction

### 5.12 DurableObjectStub

- ✅ `stub.id` — DurableObjectId
- ✅ `stub.name` — name if applicable
- ✅ `stub.fetch(request)` — send HTTP request (legacy)
- ❌ `stub.connect(options?)` — WebSocket connection
- ✅ `stub.<rpcMethod>(...args)` — RPC calls (all async, E-order guarantee via request queue)

### 5.13 WebSocket Hibernation

- ✅ Max 32,768 connections per DO — configurable, validated
- ✅ Tags: up to 10 per socket, max 256 chars each — configurable, validated
- ✅ Auto-response: max 2,048 chars for request/response — configurable, validated
- ✅ Event handlers: webSocketMessage, webSocketClose, webSocketError
- ✅ `WebSocketRequestResponsePair` class exported from cloudflare:workers
- ❌ Max message size: 32 MiB — not enforced
- ❌ Hibernation after ~10 seconds idle — not simulated (in-process)

### 5.14 Input/Output Gates

- ✅ Input gate: request queue serializes all requests (E-order)
- ✅ blockConcurrencyWhile defers all requests until complete
- ⚠️ allowConcurrency — accepted but not enforced (all requests serialized)
- ⚠️ Output gate — N/A (writes are synchronous in SQLite)
- ✅ Write coalescing: multiple writes without await → single atomic transaction

### 5.15 Jurisdictions & Location Hints

- ⚠️ Jurisdictions: eu, fedramp — accepted, ignored (N/A locally)
- ⚠️ Location hints: wnam, enam, sam, weur, eeur, apac, oc, afr, me — accepted, ignored

### 5.16 Eviction Behavior

- ✅ Configurable eviction timeout (default 120s, 0 to disable)
- ✅ Eviction skipped when: blockConcurrencyWhile active, active requests, WebSockets accepted
- ✅ Stubs survive eviction (cached separately)
- ✅ Alarms survive eviction
- ✅ Instances re-created on access after eviction

### 5.17 Configuration (wrangler.toml)

- ✅ `[durable_objects].bindings` — name, class_name
- ✅ `[[migrations]]` — tag, new_sqlite_classes, new_classes
- ❌ script_name, environment — cross-Worker DOs not supported
- ❌ renamed_classes, deleted_classes, transferred_classes — migration ops not supported

### 5.18 DO Limits

- ✅ WebSocket connections: 32,768 — configurable, validated
- ✅ WebSocket tags: 10 per socket, 256 chars — configurable, validated
- ❌ CPU per request: 30s — not enforced
- ❌ Storage per DO (SQLite): 10 GB — not enforced
- ❌ KV key+value: 2 MB combined — not enforced
- ❌ Keys per batch: 128 — not enforced
- ❌ Soft request limit: 1,000 req/s — not enforced

---

## 6. Queues

### 6.1 Queue Producer

- ✅ `queue.send(body, options?)` — send single message
- ✅ `queue.sendBatch(messages, options?)` — send batch (max 100 messages, 256 KB total)

### 6.2 send() Options

- ✅ `contentType` — "json" (default) | "text" | "bytes" | "v8"
- ✅ `delaySeconds` — delivery delay 0-43,200 (12 hours) — validated

### 6.3 sendBatch() Message Format

- ✅ `body` — message payload (max 128 KB per message) — validated
- ✅ `contentType` — per-message override
- ✅ `delaySeconds` — per-message delay

### 6.4 Queue Consumer Handler

- ✅ `export default { queue(batch, env, ctx) }` — consumer handler

### 6.5 MessageBatch

- ✅ `batch.queue` — queue name
- ✅ `batch.messages` — Message[]
- ✅ `batch.ackAll()` — acknowledge all messages
- ✅ `batch.retryAll(options?)` — retry all; options: { delaySeconds }

### 6.6 Message

- ✅ `message.id` — unique identifier (UUID)
- ✅ `message.timestamp` — Date when published
- ✅ `message.body` — deserialized payload
- ✅ `message.attempts` — delivery attempt count
- ✅ `message.ack()` — acknowledge this message
- ✅ `message.retry(options?)` — retry this message; options: { delaySeconds }
- ✅ Individual ack/retry overrides batch-level; last invocation wins

### 6.7 Consumer Configuration

- ✅ `max_batch_size` — 1-100 (default 10)
- ✅ `max_batch_timeout` — 0-60 seconds (default 5)
- ✅ `max_retries` — 0-100 (default 3)
- ✅ `dead_letter_queue` — DLQ name
- ❌ `max_concurrency` — 1-250 (default auto) — not implemented
- ❌ `retry_delay` — default delay for retried messages — not in config

### 6.8 Dead Letter Queues

- ✅ Messages routed to DLQ after exhausting max_retries
- ✅ DLQ is a normal queue (can have its own consumer/DLQ)
- ✅ Without DLQ: messages permanently deleted after max_retries

### 6.9 Pull-Based (HTTP) Consumers

- ❌ `POST .../messages/pull` — pull messages; params: batch_size, visibility_timeout_ms
- ❌ `POST .../messages/ack` — ack/retry; body: { acks, retries }
- ❌ v8 content type NOT supported by pull consumers

### 6.10 Queue Limits

- ✅ Message size: 128 KB — validated
- ✅ Messages per sendBatch: 100 / 256 KB total — validated
- ✅ delaySeconds max: 43,200 (12 hours) — validated
- ✅ All limits configurable via QueueLimits
- ✅ Message retention: configurable (default 4 days)
- ❌ Queues per account: 10,000 — not enforced
- ❌ Per-queue throughput: 5,000 msg/s — not enforced
- ❌ Max concurrent consumers: 250 — not enforced

---

## 7. Workflows

### 7.1 WorkflowEntrypoint

- ✅ `import { WorkflowEntrypoint } from 'cloudflare:workflows'`
- ✅ `async run(event: WorkflowEvent<T>, step: WorkflowStep): Promise<T>` — required method
- ✅ `this.ctx` — ExecutionContext
- ✅ `this.env` — Env bindings

### 7.2 WorkflowEvent

- ✅ `event.payload` — user-provided data (immutable)
- ✅ `event.timestamp` — instance creation time (Date)
- ✅ `event.instanceId` — instance identifier

### 7.3 WorkflowStep Methods

- ✅ `step.do(name, callback)` — execute durable step (checkpointed)
- ✅ `step.do(name, config, callback)` — with retry/timeout config
- ✅ `step.sleep(name, duration)` — sleep (ms or human-readable, up to 365 days)
- ✅ `step.sleepUntil(name, timestamp)` — sleep until Date or epoch ms
- ✅ `step.waitForEvent(name, { type, timeout? })` — wait for external event

### 7.4 WorkflowStepConfig

- ✅ `retries.limit` — total retry attempts (accepts Infinity; default 5)
- ✅ `retries.delay` — base delay (ms or human-readable; default 10s)
- ✅ `retries.backoff` — "constant" | "linear" | "exponential" (default exponential)
- ✅ `timeout` — per-attempt timeout (ms or human-readable; default 10 min)

### 7.5 NonRetryableError

- ✅ `import { NonRetryableError } from 'cloudflare:workflows'`
- ✅ `throw new NonRetryableError(message, name?)` — force immediate failure

### 7.6 Workflow Binding

- ✅ `env.MY_WORKFLOW.create(options?)` — create instance; options: { id?, params? }
- ✅ `env.MY_WORKFLOW.createBatch(batch)` — create up to 100 instances
- ✅ `env.MY_WORKFLOW.get(id)` — get instance by ID

### 7.7 WorkflowInstance

- ✅ `instance.id` — instance identifier
- ✅ `instance.pause()` — suspend instance
- ✅ `instance.resume()` — resume paused instance
- ✅ `instance.terminate()` — permanently stop (via AbortController)
- ✅ `instance.restart()` — cancel and re-run from beginning (clears cached steps)
- ✅ `instance.status()` — returns InstanceStatus
- ✅ `instance.sendEvent({ type, payload })` — deliver event to waitForEvent

### 7.8 InstanceStatus

- ✅ Status values: queued, running, paused, errored, terminated, complete, waiting
- ⚠️ waitingForPause, unknown — not implemented
- ✅ `error?` — { name, message }
- ✅ `output?` — return value from run()

### 7.9 Workflow Limits

- ✅ Max steps: 1,024 — validated
- ✅ Persisted state per step: 1 MiB — validated
- ✅ Instance ID max: 100 chars — validated
- ✅ Step name max: 256 chars — validated
- ✅ createBatch max: 100 — validated
- ✅ sleep max: 365 days — validated
- ✅ Concurrent running instances: configurable via maxConcurrentInstances
- ✅ State retention: configurable via maxRetentionMs
- ✅ All limits configurable via WorkflowLimits
- ❌ Event payload: 1 MiB — not enforced
- ❌ Event type max: 100 chars — not enforced
- ❌ Workflow name max: 64 chars — not enforced

---

## 8. Cache API

### 8.1 Cache Objects

- ✅ `caches.default` — default cache (global, registered on globalThis)
- ✅ `caches.open(name)` — named cache (isolated namespace)

### 8.2 Cache Methods

- ✅ `cache.put(request, response)` — store response (GET only, no 206, no Vary:*)
- ✅ `cache.match(request, options?)` — retrieve response; options: { ignoreMethod }
- ✅ `cache.delete(request, options?)` — remove response; options: { ignoreMethod }

### 8.3 Cache Constraints

- ⚠️ Only functional on custom domains — N/A locally (always works)
- ⚠️ Per-data-center locality — N/A locally (single instance)
- ✅ Max object size: 512 MB — validated via CacheLimits
- ❌ Calls share subrequest quota — not enforced
- ✅ Responses with Set-Cookie never cached — silently skipped
- ✅ Rejects 206 Partial Content responses
- ✅ Rejects Vary: * responses
- ✅ Parses Cache-Control (s-maxage, max-age, no-store) and Expires headers
- ✅ Adds `cf-cache-status: HIT` header on cache hits
- ✅ Lazy-deletes expired entries

### 8.4 Fetch Cache Options (cf.*)

- ❌ `cf.cacheTtl` — override edge cache TTL — not intercepted
- ❌ `cf.cacheEverything` — cache all content types — not intercepted
- ❌ `cf.cacheTtlByStatus` — per-status TTL — not intercepted
- ❌ `cf.cacheKey` — custom cache key (Enterprise) — not intercepted
- ❌ `cf.cacheTags` — tags for selective purge — not intercepted

> **Note:** Fetch cf cache options are edge features. Use the Cache API directly for local caching.

### 8.5 CF-Cache-Status Header Values

- ✅ HIT — returned on cache match
- ⚠️ MISS, EXPIRED, STALE, BYPASS, REVALIDATED, UPDATING, DYNAMIC, NONE/UNKNOWN — not distinguished

---

## 9. Static Assets

### 9.1 ASSETS Binding

- ✅ `env.ASSETS.fetch(request)` — serve static asset by pathname
- ✅ Fetcher interface, hostname irrelevant
- ✅ Respects html_handling and not_found_handling config

### 9.2 Configuration

- ✅ `assets.directory` — path to static files folder
- ✅ `assets.binding` — binding name in Worker code
- ✅ `assets.html_handling` — "auto-trailing-slash" (default) | "force-trailing-slash" | "drop-trailing-slash" | "none"
- ✅ `assets.not_found_handling` — "none" (default) | "single-page-application" | "404-page"
- ✅ `assets.run_worker_first` — false (default) | true | string[] (glob patterns)

### 9.3 HTML Handling Modes

- ✅ `auto-trailing-slash` — .html stripped, index.html with slash, redirects for canonical URLs
- ✅ `force-trailing-slash` — all URLs require trailing slash (307 redirect)
- ✅ `drop-trailing-slash` — no trailing slashes (307 redirect)
- ✅ `none` — only exact file paths with extensions resolve

### 9.4 `_headers` File

- ✅ Custom headers per URL path/pattern
- ✅ Splats (*) and placeholders (:name)
- ❌ `!Header-Name` to remove headers
- ✅ Max 100 rules, 2,000 chars per line — configurable via StaticAssetsLimits
- ✅ Only applies to static asset responses

### 9.5 `_redirects` File

- ❌ Static and dynamic redirects
- ❌ Status codes: 301, 302, 303, 307, 308; 200 for proxying
- ❌ Splats and placeholders supported
- ❌ Max 2,000 static + 100 dynamic redirects
- ❌ Applied before headers, before asset matching

### 9.6 Default Headers on Assets

- ✅ Content-Type — detected by file extension (via Bun.file().type)
- ✅ Cache-Control — `public, max-age=0, must-revalidate`
- ✅ ETag — based on mtime+size (fast)
- ✅ If-None-Match — returns 304 when ETag matches
- ❌ CF-Cache-Status — HIT or MISS — not added

### 9.7 Static Assets Limits

- ❌ Files per version: 20,000 (free), 100,000 (paid) — not enforced
- ❌ Max file size: 25 MiB per file — not enforced

---

## 10. Service Bindings

### 10.1 Fetcher Interface (HTTP Mode)

- ✅ `binding.fetch(input, init?)` — forward HTTP request to bound Worker
- ⚠️ `binding.connect(address, options?)` — TCP socket connection (throws "not supported in local dev")
- ❌ `binding.queue(queueName, messages)` — invoke queue handler
- ❌ `binding.scheduled(options?)` — invoke scheduled handler

### 10.2 WorkerEntrypoint (RPC Mode)

- ✅ `import { WorkerEntrypoint } from 'cloudflare:workers'`
- ✅ Any public method becomes callable via RPC
- ✅ `this.env` — access bindings; `this.ctx` — ExecutionContext
- ❌ protected/private methods not exposed — no visibility enforcement
- ✅ New instance per invocation (stateless)

### 10.3 Named Entrypoints

- ✅ Multiple WorkerEntrypoint classes per Worker
- ✅ Bind to specific entrypoint via `entrypoint` field in config

### 10.4 RpcTarget

- ⚠️ `import { RpcTarget } from 'cloudflare:workers'` — class exists but is empty stub
- ❌ Objects extending RpcTarget sent as stubs (not serialized) — no special handling
- ❌ Only prototype methods and getters exposed — no filtering
- ❌ Instance properties NOT accessible over RPC — not enforced

### 10.5 RPC Serializable Types

- ✅ Structured cloneable: objects, arrays, strings, numbers, etc. — passed in-process
- ✅ ReadableStream / WritableStream — passed in-process
- ✅ Request, Response, Headers — passed in-process
- ❌ Functions → stubs; RpcTarget subclasses → stubs — no stub conversion
- ⚠️ Max serialized payload: 32 MiB — limit defined but not enforced

### 10.6 Promise Pipelining

- ✅ RPC returns custom thenables for speculative chaining
- ✅ `await env.SERVICE.getCounter().increment()` — works (in-process)

### 10.7 Stub Lifecycle

- ❌ `using` keyword for automatic disposal
- ❌ `stub.dup()` — duplicate handle
- ❌ Auto-disposed when execution context ends

### 10.8 RPC Error Handling

- ✅ Exceptions propagate; message and name retained
- ⚠️ Stack trace — preserved (in-process), CF strips it

### 10.9 Configuration (wrangler.toml)

- ✅ `[[services]]` — binding, service, entrypoint?
- ⚠️ Same-account only — N/A locally (single worker module)

### 10.10 Service Bindings Limits

- ✅ Max subrequests: configurable (default 1000) — tracked and enforced
- ❌ Max 32 Worker invocations per chain — not enforced

---

## 11. Scheduled (Cron Triggers)

### 11.1 Handler

- ✅ `export default { scheduled(controller, env, ctx) }` — cron handler

### 11.2 ScheduledController

- ✅ `controller.scheduledTime` — Unix timestamp in ms
- ✅ `controller.cron` — cron pattern string
- ✅ `controller.noRetry()` — prevent retries
- ✅ `controller.type` — "scheduled"

### 11.3 Cron Syntax

- ✅ 5 fields: minute, hour, day-of-month, month, day-of-week
- ✅ Special chars: *, comma, dash, /
- ❌ Special chars: L, W, # — not implemented
- ✅ All schedules in UTC
- ✅ Day names: MON-SUN (case-insensitive)
- ✅ Month names: JAN-DEC (case-insensitive)
- ✅ Special aliases: @daily, @midnight, @hourly, @weekly, @monthly, @yearly, @annually

### 11.4 Configuration

- ✅ `[triggers].crons` — array of cron patterns in wrangler.toml
- ❌ Max 5 triggers per Worker (free), 250 (paid) — not enforced
- ✅ Minimum interval: 1 minute (60-second check interval)

### 11.5 Retry Behavior

- ⚠️ Automatic retries — not implemented in dev (noRetry is no-op)
- ✅ `noRetry()` — accepted

### 11.6 Testing

- ✅ `/cdn-cgi/handler/scheduled?cron=...` endpoint in dev server
- ❌ createScheduledController in vitest — not provided

---

## 12. Images Binding

### 12.1 Binding Methods

- ✅ `env.IMAGES.input(stream)` — create ImageTransformer from ReadableStream
- ✅ `env.IMAGES.info(stream)` — get image info: format, fileSize, width, height

### 12.2 ImageTransformer Methods

- ✅ `.transform(options)` — apply transform (chainable)
- ✅ `.draw(image, options?)` — overlay another image (chainable)
- ✅ `.output(options)` — encode and output (required)

### 12.3 Transform Options — Sizing

- ✅ `width` — max width
- ✅ `height` — max height
- ✅ `fit` — "scale-down" | "contain" | "cover" | "crop" | "pad" | "squeeze" (mapped to Sharp equivalents)
- ❌ `dpr` — device pixel ratio multiplier

### 12.4 Transform Options — Gravity / Cropping

- ❌ `gravity` — "auto" | "face" | "left" | "right" | "top" | "bottom" | "center" | { x, y }
- ❌ `zoom` — 0-1, crop closeness for face detection
- ⚠️ `trim` — depends on Sharp support

### 12.5 Transform Options — Color / Tone

- ✅ `brightness` — 1.0 = no change
- ✅ `contrast` — 1.0 = no change (via Sharp linear)
- ❌ `gamma` — exposure adjustment
- ❌ `saturation` — 0 = grayscale
- ✅ `background` — CSS4 color for padding/transparency

### 12.6 Transform Options — Sharpness / Blur

- ✅ `blur` — radius 1-250
- ✅ `sharpen` — 0-10

### 12.7 Transform Options — Rotation / Flip

- ✅ `rotate` — 90, 180, 270 degrees clockwise
- ✅ `flip` — "h" | "v" | "hv" (mapped to Sharp flip/flop)

### 12.8 Transform Options — Format / Encoding

- ✅ `format` — "avif" | "webp" | "jpeg" | "png" | "gif" — via Sharp
- ❌ `format` — "auto" | "baseline-jpeg" | "json" — not supported
- ✅ `quality` — 1-100
- ❌ `quality` — "high" | "medium-high" | "medium-low" | "low" presets
- ❌ `compression` — "fast"
- ❌ `anim` — boolean (preserve animation frames)
- ❌ `metadata` — "keep" | "copyright" | "none"

### 12.9 Transform Options — AI Features

- ❌ `segment` — "foreground" (requires Cloudflare AI backend)

### 12.10 Transform Options — Border

- ❌ `border` — { color, width?, top?, right?, bottom?, left? }

### 12.11 Draw Options (Overlays)

- ❌ `opacity` — 0.0-1.0
- ✅ `repeat` — true | "x" | "y"
- ✅ `top` / `left` / `bottom` / `right` — pixel offsets

### 12.12 Output Options

- ✅ `format` — MIME type: "image/avif" | "image/webp" | "image/jpeg" | "image/png" | "image/gif"
- ✅ `quality` — 1-100

### 12.13 Output Result

- ✅ `.image()` — ReadableStream
- ✅ `.contentType()` — MIME type string
- ✅ `.response()` — full HTTP Response

### 12.14 Supported Formats

- ✅ Input: JPEG, PNG, GIF, WebP, AVIF — format detection via magic bytes
- ✅ Input: SVG — detected via text content
- ❌ Input: HEIC — not detected
- ✅ Output: JPEG, PNG, GIF, WebP, AVIF — via Sharp
- ❌ Output: JSON (metadata only)

### 12.15 Images Limits

- ❌ Max input file: 70 MB — not enforced
- ❌ Max image area: 100 megapixels — not enforced
- ❌ Max dimension: 12,000 px (non-AVIF), 1,200 px (AVIF) — not enforced
- ❌ Animation total area: 50 megapixels — not enforced

---

## 13. Environment Variables & Secrets

### 13.1 Environment Variables

- ✅ `[vars]` in wrangler.toml — plain text, non-encrypted
- ❌ JSON/nested objects supported as values — only string values
- ✅ Accessed via `env.VAR_NAME`, `this.env.VAR_NAME`
- ❌ `process.env.VAR_NAME` — not populated
- ✅ `import { env } from "cloudflare:workers"` — top-level access (via globalEnv getter)
- ✅ Non-inheritable across environments

### 13.2 Secrets

- ⚠️ Secrets indistinguishable from env vars in Worker code — loaded from .dev.vars/.env
- ❌ `wrangler secret put/delete/list/bulk` — CLI commands not applicable

### 13.3 Local Development

- ✅ `.dev.vars` file (dotenv format)
- ✅ `.env` file as fallback
- ✅ `.dev.vars` takes priority over `.env`
- ✅ `.dev.vars.<environment>` — environment-specific

### 13.4 Environment-Specific

- ✅ `[env.<NAME>].vars` — per-environment variables
- ✅ Non-inheritable: env-specific values override top-level config
- ✅ `--env <name>` CLI flag in dev.ts

### 13.5 Secrets Store (Account-Level)

- ❌ Centralized secrets shared across Workers
- ❌ `await env.SECRET.get()` — async access
- ❌ Configured via `[[secrets_store_secrets]]` in wrangler.toml

### 13.6 Env Limits

- ❌ Variables per Worker: 64 (free), 128 (paid) — not enforced
- ❌ Variable value size: 5 KB — not enforced
