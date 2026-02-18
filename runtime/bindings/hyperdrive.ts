/**
 * Local implementation of the Cloudflare Hyperdrive binding.
 * Parses a PostgreSQL connection string and exposes readonly properties.
 * connect() creates a raw TCP socket via Bun.connect().
 */

interface HyperdriveSocket {
	readable: ReadableStream<Uint8Array>;
	writable: WritableStream<Uint8Array>;
	closed: Promise<void>;
	opened: Promise<{ remoteAddress: string }>;
	close(): void;
}

export class HyperdriveBinding {
	private readonly _url: URL | null;
	private readonly _connectionString: string;

	constructor(connectionString: string) {
		this._connectionString = connectionString;
		if (connectionString) {
			this._url = new URL(connectionString);
		} else {
			this._url = null;
		}
	}

	get connectionString(): string {
		return this._connectionString;
	}

	get host(): string {
		return this._url?.hostname ?? "";
	}

	get port(): number {
		if (!this._url) return 5432;
		return this._url.port ? parseInt(this._url.port, 10) : 5432;
	}

	get user(): string {
		return this._url ? decodeURIComponent(this._url.username) : "";
	}

	get password(): string {
		return this._url ? decodeURIComponent(this._url.password) : "";
	}

	get database(): string {
		if (!this._url) return "";
		// pathname is "/<database>", strip leading slash
		return decodeURIComponent(this._url.pathname.slice(1));
	}

	connect(): HyperdriveSocket {
		if (!this._url) {
			throw new Error("Hyperdrive: no connection string configured");
		}

		const host = this.host;
		const port = this.port;

		let readableController: ReadableStreamDefaultController<Uint8Array>;
		let resolveOpened: (info: { remoteAddress: string }) => void;
		let resolveClosed: () => void;
		let rejectOpened: (err: Error) => void;
		let rejectClosed: (err: Error) => void;
		let bunSocket: ReturnType<typeof Bun.connect> extends Promise<infer T> ? T : never;

		const readable = new ReadableStream<Uint8Array>({
			start(controller) {
				readableController = controller;
			},
		});

		const opened = new Promise<{ remoteAddress: string }>((resolve, reject) => {
			resolveOpened = resolve;
			rejectOpened = reject;
		});

		const closed = new Promise<void>((resolve, reject) => {
			resolveClosed = resolve;
			rejectClosed = reject;
		});

		const writable = new WritableStream<Uint8Array>({
			async write(chunk) {
				const sock = await socketPromise;
				sock.write(chunk);
			},
		});

		const socketPromise = Bun.connect({
			hostname: host,
			port,
			socket: {
				data(_socket, data) {
					readableController.enqueue(new Uint8Array(data));
				},
				open(socket) {
					bunSocket = socket as any;
					resolveOpened!({ remoteAddress: `${host}:${port}` });
				},
				close() {
					try { readableController.close(); } catch {}
					resolveClosed!();
				},
				error(_socket, err) {
					rejectOpened!(err);
					rejectClosed!(err);
					try { readableController.error(err); } catch {}
				},
			},
		});

		return {
			readable,
			writable,
			opened,
			closed,
			close() {
				socketPromise.then(s => s.end());
			},
		};
	}

	startTls(): never {
		throw new Error("startTls() is not supported in local dev mode");
	}
}
