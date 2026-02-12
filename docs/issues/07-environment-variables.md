# Environment Variables and Secrets

Plain string variables and secrets injected into `env`.

## Wrangler config

```jsonc
"vars": {
  "API_HOST": "https://api.example.com",
  "ENVIRONMENT": "development"
}
```

Secrets are set via `wrangler secret put KEY` and stored in `.dev.vars` for local development.

## API

- `env.API_HOST` — returns `"https://api.example.com"`
- `env.MY_SECRET` — returns the secret value

## Implementation notes

- Parse `vars` from wrangler config and add each key-value pair to the `env` object
- Read `.dev.vars` file (if it exists) — it's a dotenv-style file with `KEY=VALUE` lines
- `.dev.vars` values override `vars` from config (matching wrangler behavior)
- Secrets from `.dev.vars` are merged into `env` alongside binding objects
- This is straightforward — just string properties on the env object
