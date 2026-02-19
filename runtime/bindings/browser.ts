/**
 * Local shim for Cloudflare's Browser Rendering binding.
 *
 * On Cloudflare, env.BROWSER is a Fetcher ({ fetch }) that proxies to
 * the Browser Rendering API. @cloudflare/puppeteer calls
 * endpoint.fetch("/v1/acquire") etc. under the hood.
 *
 * For local dev we skip the Fetcher layer entirely — the plugin shim
 * for @cloudflare/puppeteer delegates directly to this class which
 * uses real puppeteer / puppeteer-core.
 */

export interface ActiveSession {
  sessionId: string;
  startTime: number;
  connectionId?: string;
  connectionStartTime?: number;
}

export class BrowserBinding {
  /** Managed browser instance (when launched locally, not via wsEndpoint). */
  private _browser: any = null;

  constructor(private config: { wsEndpoint?: string; executablePath?: string; headless?: boolean }) {}

  /** Launch a new browser and return a puppeteer Browser instance. */
  async launch(opts?: { keep_alive?: number }): Promise<any> {
    if (this.config.wsEndpoint) {
      // @ts-ignore — puppeteer-core is an optional dependency
      const puppeteer = await import("puppeteer-core");
      this._browser = await puppeteer.default.connect({ browserWSEndpoint: this.config.wsEndpoint });
      return this._browser;
    }
    // @ts-ignore — puppeteer is an optional dependency
    const puppeteer = await import("puppeteer");
    this._browser = await puppeteer.default.launch({
      headless: this.config.headless ?? true,
      executablePath: this.config.executablePath,
    });
    return this._browser;
  }

  /** Connect to an existing browser session by sessionId. */
  async connect(sessionId: string): Promise<any> {
    if (this.config.wsEndpoint) {
      // @ts-ignore — puppeteer-core is an optional dependency
      const puppeteer = await import("puppeteer-core");
      return puppeteer.default.connect({ browserWSEndpoint: this.config.wsEndpoint });
    }
    // In local dev without wsEndpoint, return the existing managed browser if available
    if (this._browser && this._browser.isConnected()) {
      return this._browser;
    }
    throw new Error("connect() requires wsEndpoint in browser config, or launch() first");
  }

  /** List active sessions (stub — local dev has at most one). */
  async sessions(): Promise<ActiveSession[]> {
    if (this._browser && this._browser.isConnected()) {
      return [{ sessionId: "local", startTime: Date.now() }];
    }
    return [];
  }
}
