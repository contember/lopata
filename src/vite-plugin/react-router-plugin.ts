import type { Plugin } from 'vite'

const SERVER_BUILD_ID = '\0virtual:react-router/server-build'

/**
 * Instruments React Router loaders, actions, and SSR rendering with
 * Lopata tracing spans via the `unstable_instrumentations` API.
 *
 * Works by transforming React Router's `virtual:react-router/server-build`
 * virtual module to inject an `unstable_ServerInstrumentation` and wrap
 * the `handleRequest` (default export) with a render span.
 *
 * Uses the `globalThis.__lopata_startSpan` bridge set up by
 * `dev-server-plugin.ts` to call into the tracing runtime, which lives
 * in Bun's native module graph (separate from Vite's SSR runner).
 *
 * If React Router is not used, this plugin is a no-op.
 */
export function reactRouterPlugin(): Plugin {
	return {
		name: 'lopata:react-router',

		transform(code, id) {
			if (id !== SERVER_BUILD_ID) return

			// Replace the `export const entry = { module: entryServer };` line
			// with our instrumented version that adds tracing.
			const entryPattern = /export const entry\s*=\s*\{\s*module:\s*entryServer\s*\};/

			if (!entryPattern.test(code)) return

			const injected = `
const __bf_instr = {
  route({ id, path, instrument }) {
    instrument({
      loader: async (callHandler, info) => {
        const startSpan = globalThis.__lopata_startSpan;
        if (!startSpan) { await callHandler(); return; }
        await startSpan({
          name: "loader " + id,
          kind: "internal",
          attributes: {
            "rr.type": "loader",
            "rr.route.id": id,
            "rr.route.pattern": info?.unstable_pattern,
          },
        }, async () => {
          const result = await callHandler();
          if (result.status === "error") throw result.error;
        });
      },
      action: async (callHandler, info) => {
        const startSpan = globalThis.__lopata_startSpan;
        if (!startSpan) { await callHandler(); return; }
        await startSpan({
          name: "action " + id,
          kind: "internal",
          attributes: {
            "rr.type": "action",
            "rr.route.id": id,
            "rr.route.pattern": info?.unstable_pattern,
          },
        }, async () => {
          const result = await callHandler();
          if (result.status === "error") throw result.error;
        });
      },
    });
  },
};

const __bf_entry = {
  ...entryServer,
  default: async function(...args) {
    const startSpan = globalThis.__lopata_startSpan;
    if (!startSpan) return entryServer.default(...args);
    return startSpan({
      name: "react-router.render",
      kind: "internal",
      attributes: { "rr.type": "render" },
    }, () => entryServer.default(...args));
  },
  unstable_instrumentations: [
    ...(entryServer.unstable_instrumentations || []),
    __bf_instr,
  ],
};
export const entry = { module: __bf_entry };
`

			const transformed = code.replace(entryPattern, injected)
			return { code: transformed, map: null }
		},
	}
}
