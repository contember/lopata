import { DurableObject } from "cloudflare:workers";

/**
 * DO that proxies calls to a service-bound worker.
 * Used for testing error propagation: caller → DO → service binding → worker.
 */
export class ErrorBridge extends DurableObject<Env> {
  /** Call the failing worker's fetch handler */
  async callFetch(path: string): Promise<string> {
    const res = await this.env.FAILING.fetch(
      new Request(`http://failing-worker${path}`),
    );
    return await res.text();
  }

  /** Call an RPC method on the failing worker */
  async callRpc(method: string): Promise<unknown> {
    const svc = this.env.FAILING as any;
    return await svc[method]();
  }

  /** Throw directly from the DO */
  async doThrow(): Promise<void> {
    throw new Error("ErrorBridge DO exploded");
  }
}
