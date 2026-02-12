# Static Assets binding

Serve static files from a directory.

## Wrangler config

```jsonc
"assets": {
  "directory": "./public",
  "binding": "ASSETS",
  "html_handling": "auto-trailing-slash",
  "not_found_handling": "single-page-application"
}
```

## API to implement

### Binding

- `env.ASSETS.fetch(request: Request): Promise<Response>` — serves files from the configured directory

### html_handling modes

- `"none"` — exact path matching only
- `"auto-trailing-slash"` — `/about` tries `/about`, `/about/`, `/about/index.html`, `/about.html`
- `"force-trailing-slash"` — redirects `/about` to `/about/`
- `"drop-trailing-slash"` — redirects `/about/` to `/about`

### not_found_handling modes

- `"none"` — 404 response
- `"404-page"` — serve `/404.html` if it exists
- `"single-page-application"` — serve `/index.html` for all not-found paths

## Implementation notes

- Resolve file path from URL pathname relative to the configured directory
- Use `Bun.file()` to read files and serve them
- Set `Content-Type` header based on file extension (use a mime-type map or `Bun.file().type`)
- Prevent path traversal (`..` in path)
- Apply `html_handling` logic for `.html` files
- Apply `not_found_handling` when file doesn't exist
- If no `binding` is specified in config, assets are served automatically before the worker's fetch handler (but in our runtime, we can just wire it as a binding)
