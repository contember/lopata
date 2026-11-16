# Conformance against workerd

These tests measure how closely lopata matches workerd, the Cloudflare Workers runtime. They are adapted from the test suites of
[workerd](https://github.com/cloudflare/workerd) and [workers-sdk](https://github.com/cloudflare/workers-sdk) (Miniflare).

## Corpora

- `workerd.test.ts` runs workerd's API tests (`src/workerd/api/tests/*-test.js`), vendored unchanged in `workerd/`. Each module runs
  as its own worker in a generated multi-worker `lopata dev` project, so the tests exercise the real runtime: worker threads, the
  globals lopata installs, service bindings and Durable Objects. `workerd-manifest.ts` lists the selected modules, the area each
  covers, and the bindings and compatibility flags from its `.wd-test` config. `workerd-runner.ts` wraps a module:
  `GET /__conformance/list` returns its test exports and `GET /__conformance/run?test=<export>` calls `export.test(ctrl, env, ctx)`
  inside the worker, as `workerd test` does.
- `miniflare-<area>.test.ts` (KV, R2, D1, Cache, Queues) are ports of Miniflare's binding test suites
  (`packages/miniflare/test/plugins/<area>/`). The assertions are Miniflare's; only the Miniflare plumbing is replaced by lopata's
  binding classes over an in-memory database. Each file's header lists the tests left out because they test Miniflare-only
  machinery (options, persistence layout, internal storage).

## Known failures

`known-failures/<corpus>.json` maps each failing test id to the first line of its error. Those tests run as `test.failing`, so
`bun test tests/` stays green, but it fails when a passing test regresses or when a known failure starts passing. After a fix,
remove the fixed ids or regenerate the file.

## Measuring

```bash
bun scripts/conformance-report.ts            # pass rate per corpus and area, every case run as a plain test
bun scripts/conformance-report.ts --update   # also rewrite known-failures/*.json from the measured failures
bun scripts/conformance-report.ts tests/conformance/workerd.test.ts
CONFORMANCE_ONLY=streams-test,url-test CONFORMANCE_RECORD=1 bun test tests/conformance/workerd.test.ts   # a subset of modules
CONFORMANCE_KEEP=1 ...                       # keep the generated project and the lopata logs
```

## Sources and licences

- workerd, commit `8ae9e49a5` (2026-03-12). Copyright Cloudflare, Inc., Apache License 2.0; the licence text is in
  `workerd/LICENSE`. The files in `workerd/` are unmodified copies and keep their original copyright headers.
- workers-sdk, commit `6ee18e1bd` (2026-03-12). Copyright (c) 2020 Cloudflare, Inc., MIT licence (the project is dual-licensed
  MIT or Apache-2.0); the MIT licence text is in `LICENSE-workers-sdk`. The `miniflare-*.test.ts` files are adapted from it, as each file's header says.
