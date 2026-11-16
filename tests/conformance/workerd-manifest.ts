// Selected workerd test modules (vendored in ./workerd), the API area each one covers and the
// bindings and compatibility flags its `.wd-test` config declares.

export interface WorkerdModule {
	area: string
	flags: string[]
	/** Service bindings to the module's own worker (`service = "<self>"` in the .wd-test). */
	selfServices?: Array<{ binding: string; entrypoint?: string }>
	durableObjects?: Array<{ binding: string; className: string }>
}

const STREAMS = ['nodejs_compat', 'streams_enable_constructors', 'transformstream_enable_standard_constructor']

export const workerdModules: Record<string, WorkerdModule> = {
	// fetch, Request, Response, Headers, FormData, Blob
	'fetch-test': {
		area: 'fetch',
		flags: ['nodejs_compat_v2', 'upper_case_all_http_methods', 'fetch_iterable_type_support', 'streams_enable_constructors'],
	},
	'response-json': { area: 'fetch', flags: ['nodejs_compat'] },
	'request-clone-test': { area: 'fetch', flags: ['nodejs_compat', 'streams_enable_constructors'] },
	'response-used-body-test': {
		area: 'fetch',
		flags: ['nodejs_compat_v2', 'streams_enable_constructors'],
		selfServices: [{ binding: 'subrequest' }],
	},
	'data-url-fetch-test': { area: 'fetch', flags: ['nodejs_compat'] },
	'abortable-fetch-test': { area: 'fetch', flags: ['nodejs_compat', 'url_original', 'fetch_legacy_url'], selfServices: [{ binding: 'subrequest' }] },
	'form-data-test': { area: 'fetch', flags: ['nodejs_compat', 'formdata_parser_supports_files'] },
	'blob-test': {
		area: 'fetch',
		flags: ['nodejs_compat', 'set_tostring_tag', 'workers_api_getters_setters_on_prototype'],
		selfServices: [{ binding: 'request-blob' }],
	},
	'blob2-test': { area: 'fetch', flags: ['nodejs_compat', 'blob_standard_mime_type'] },
	// Streams
	'streams-test': {
		area: 'streams',
		flags: [...STREAMS, 'internal_stream_byob_return_view', 'streams_byob_reader_detaches_buffer'],
		selfServices: [{ binding: 'subrequest' }],
	},
	'streams-js-test': { area: 'streams', flags: ['nodejs_compat', 'streams_enable_constructors'] },
	'streams-respond-test': { area: 'streams', flags: STREAMS },
	'transform-streams-test': { area: 'streams', flags: STREAMS },
	'pipe-streams-test': { area: 'streams', flags: STREAMS, selfServices: [{ binding: 'SERVICE' }] },
	'streams-async-iterator-test': { area: 'streams', flags: STREAMS },
	'streams-backpressure-test': { area: 'streams', flags: STREAMS },
	'streams-tee-edge-cases-test': { area: 'streams', flags: STREAMS },
	'streams-error-edge-cases-test': { area: 'streams', flags: STREAMS },
	'streams-byob-edge-cases-test': { area: 'streams', flags: STREAMS },
	'streams-r2-patterns-test': { area: 'streams', flags: STREAMS },
	'streams-no-auto-allocate-test': {
		area: 'streams',
		flags: ['experimental', 'nodejs_compat', 'streams_enable_constructors', 'streams_no_default_auto_allocate_chunk_size'],
	},
	'identity-transform-stream-state-machine-test': { area: 'streams', flags: ['nodejs_compat', 'nodejs_compat_v2', 'streams_enable_constructors'] },
	'compression-streams-test': { area: 'streams', flags: [...STREAMS, 'strict_compression_checks'], selfServices: [{ binding: 'SERVICE' }] },
	'encoding-streams-test': { area: 'streams', flags: STREAMS },
	// Encoding and URL
	'encoding-test': { area: 'encoding-url', flags: ['nodejs_compat', 'text_decoder_cjk_decoder'] },
	'url-test': { area: 'encoding-url', flags: ['nodejs_compat', 'urlsearchparams_delete_has_value_arg', 'urlpattern_original', 'url_standard'] },
	// Web Crypto and crypto extras
	'crypto-extras-test': { area: 'crypto', flags: ['nodejs_compat'] },
	'crypto-streams-test': { area: 'crypto', flags: ['nodejs_compat'] },
	'crypto-impl-asymmetric-test': { area: 'crypto', flags: ['experimental', 'nodejs_compat', 'crypto_preserve_public_exponent'] },
	// HTMLRewriter
	'htmlrewriter-test': {
		area: 'htmlrewriter',
		flags: [...STREAMS, 'experimental', 'original-transform-stream-backpressure'],
	},
	// Events, AbortSignal, MessagePort, error reporting
	'abortsignal-test': {
		area: 'events',
		flags: ['nodejs_compat', 'enable_abortsignal_rpc', 'experimental'],
		selfServices: [{ binding: 'RpcRemoteEnd', entrypoint: 'RpcRemoteEnd' }],
	},
	'events-test': {
		area: 'events',
		flags: ['nodejs_compat', 'set_event_target_this', 'workers_api_getters_setters_on_prototype', 'dont_substitute_null_on_type_error'],
	},
	'messageport-test': { area: 'events', flags: ['nodejs_compat_v2', 'expose_global_message_channel'] },
	'unhandled-rejection-test': { area: 'events', flags: ['nodejs_compat', 'unhandled_rejection_after_microtask_checkpoint'] },
	'reporterror-test': { area: 'events', flags: ['nodejs_compat'] },
	// Global scope, timers, scheduler, navigator, AsyncLocalStorage
	'global-scope-test': { area: 'globals', flags: ['nodejs_compat', 'enable_ctx_exports', 'global_navigator', 'rpc', 'set_tostring_tag'] },
	'scheduler-test': { area: 'globals', flags: ['nodejs_compat'], selfServices: [{ binding: 'subrequest' }] },
	'settimeout-test': { area: 'globals', flags: ['nodejs_compat'] },
	'navigator-test': { area: 'globals', flags: ['nodejs_compat', 'enable_navigator_language', 'global_navigator'] },
	'als-test': { area: 'globals', flags: ['nodejs_compat'] },
	// WebSocket
	'websocket-constructor-test': {
		area: 'websocket',
		flags: ['nodejs_compat', 'websocket_close_reason_byte_limit', 'pedantic_wpt', 'websocket_standard_binary_type'],
	},
	// Durable Object storage
	'sql-test': {
		area: 'durable-objects',
		flags: [...STREAMS, 'experimental'],
		durableObjects: [{ binding: 'ns', className: 'DurableObjectExample' }],
	},
	'sync-kv-test': {
		area: 'durable-objects',
		flags: ['enable_ctx_exports', 'nodejs_compat', 'rpc'],
		durableObjects: [{ binding: 'MyActor', className: 'MyActor' }],
	},
	'actor-kv-test': {
		area: 'durable-objects',
		flags: ['experimental', 'nodejs_compat'],
		durableObjects: [{ binding: 'ns', className: 'ActorKvTest' }],
	},
	'actor-alarms-test': {
		area: 'durable-objects',
		flags: ['experimental', 'nodejs_compat'],
		durableObjects: [{ binding: 'ns', className: 'DurableObjectExample' }],
	},
}
