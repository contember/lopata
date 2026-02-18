import type { Route } from "./+types/home";

export async function loader({ context }: Route.LoaderArgs) {
  const env = (context as any).env;
  // Try KV if available
  let kvValue: string | null = null;
  if (env?.KV) {
    await env.KV.put("test-key", "hello from KV!");
    kvValue = await env.KV.get("test-key");
  }
  return { message: "Hello from React Router + Cloudflare!", kvValue };
}

export default function Home({ loaderData }: Route.ComponentProps) {
  return (
    <div style={{ fontFamily: "system-ui, sans-serif", padding: "2rem" }}>
      <h1>{loaderData.message}</h1>
      {loaderData.kvValue && (
        <p>KV value: <strong>{loaderData.kvValue}</strong></p>
      )}
    </div>
  );
}
