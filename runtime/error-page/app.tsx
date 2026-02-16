import { render } from "preact";

interface StackFrame {
  file: string;
  line: number;
  column: number;
  function: string;
  source?: string[];
  sourceLine?: number;
}

interface ErrorPageData {
  error: {
    name: string;
    message: string;
    stack: string;
    frames: StackFrame[];
  };
  request: {
    method: string;
    url: string;
    headers: Record<string, string>;
  };
  env: Record<string, string>;
  bindings: { name: string; type: string }[];
  runtime: {
    bunVersion: string;
    platform: string;
    arch: string;
    workerName?: string;
    configName?: string;
  };
}

declare global {
  interface Window {
    __BUNFLARE_ERROR__: ErrorPageData;
  }
}

function Section({ title, open, children }: { title: string; open?: boolean; children: preact.ComponentChildren }) {
  return (
    <details open={open} class="bg-white rounded-2xl shadow-card overflow-hidden">
      <summary class="px-6 py-4 cursor-pointer select-none text-sm font-semibold text-ink hover:bg-surface-raised transition-colors">
        {title}
      </summary>
      <div class="border-t border-surface-dim">
        {children}
      </div>
    </details>
  );
}

function CodeBlock({ frame }: { frame: StackFrame }) {
  if (!frame.source || frame.source.length === 0) return null;
  const startLine = frame.line - (frame.sourceLine ?? 0);

  return (
    <div class="mb-4 last:mb-0">
      <div class="px-4 py-2 bg-surface-dim text-xs font-medium text-ink-muted" style="font-family: 'JetBrains Mono', monospace;">
        {frame.file}:{frame.line}:{frame.column}
        {frame.function && <span class="ml-2 text-gray-400">in {frame.function}</span>}
      </div>
      <div class="overflow-x-auto scrollbar-thin">
        <pre class="text-xs leading-5 m-0" style="font-family: 'JetBrains Mono', monospace;">
          {frame.source.map((line, i) => {
            const lineNum = startLine + i;
            const isError = i === frame.sourceLine;
            return (
              <div
                key={i}
                class={isError ? "bg-red-100 border-l-4 border-error-red" : "hover:bg-surface-raised"}
              >
                <span class={`inline-block w-12 text-right pr-3 select-none ${isError ? "text-error-red font-bold" : "text-gray-400"}`}>
                  {lineNum}
                </span>
                <span class={isError ? "text-error-red font-medium" : "text-ink"}>{line}</span>
              </div>
            );
          })}
        </pre>
      </div>
    </div>
  );
}

function KeyValueTable({ data, mask }: { data: Record<string, string>; mask?: boolean }) {
  const entries = Object.entries(data);
  if (entries.length === 0) {
    return <div class="px-6 py-4 text-sm text-gray-400">No entries</div>;
  }

  return (
    <table class="w-full text-sm">
      <tbody>
        {entries.map(([key, value]) => (
          <tr key={key} class="border-b border-surface-dim last:border-0 hover:bg-surface-raised transition-colors">
            <td class="px-6 py-2 font-medium text-ink-muted whitespace-nowrap align-top" style="font-family: 'JetBrains Mono', monospace; width: 1%;">
              {key}
            </td>
            <td class="px-6 py-2 text-ink break-all" style="font-family: 'JetBrains Mono', monospace;">
              {value}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function App() {
  const data = window.__BUNFLARE_ERROR__;

  if (!data) {
    return <div class="p-8 text-gray-400">No error data available.</div>;
  }

  const { error, request, env, bindings, runtime } = data;

  return (
    <div class="min-h-full p-6 max-w-5xl mx-auto flex flex-col gap-4">
      {/* Error header */}
      <div class="bg-white rounded-2xl shadow-card overflow-hidden border-l-4 border-error-red">
        <div class="px-6 py-5">
          <div class="flex items-center gap-3 mb-2">
            <span class="w-8 h-8 rounded-full bg-error-bg flex items-center justify-center text-error-red text-sm font-bold">!</span>
            <span class="text-xs font-semibold uppercase tracking-wider text-error-red">{error.name}</span>
          </div>
          <h1 class="text-xl font-bold text-ink m-0 leading-snug break-words">{error.message}</h1>
        </div>
      </div>

      {/* Source Code */}
      {error.frames.length > 0 && (
        <Section title="Source Code" open>
          <div class="divide-y divide-surface-dim">
            {error.frames.map((frame, i) => (
              <CodeBlock key={i} frame={frame} />
            ))}
          </div>
        </Section>
      )}

      {/* Stack Trace */}
      <Section title="Stack Trace" open>
        <div class="px-6 py-4 overflow-x-auto scrollbar-thin">
          <pre class="text-xs text-ink-muted leading-5 m-0 whitespace-pre-wrap break-words" style="font-family: 'JetBrains Mono', monospace;">
            {error.stack}
          </pre>
        </div>
      </Section>

      {/* Request */}
      <Section title="Request" open>
        <div class="px-6 py-3 border-b border-surface-dim">
          <span class="inline-block px-2 py-0.5 rounded bg-accent-lime text-xs font-bold mr-2">{request.method}</span>
          <span class="text-sm break-all" style="font-family: 'JetBrains Mono', monospace;">{request.url}</span>
        </div>
        <KeyValueTable data={request.headers} />
      </Section>

      {/* Environment */}
      <Section title="Environment">
        <KeyValueTable data={env} />
      </Section>

      {/* Bindings */}
      <Section title="Bindings">
        {bindings.length === 0 ? (
          <div class="px-6 py-4 text-sm text-gray-400">No bindings configured</div>
        ) : (
          <table class="w-full text-sm">
            <tbody>
              {bindings.map((b) => (
                <tr key={b.name} class="border-b border-surface-dim last:border-0 hover:bg-surface-raised transition-colors">
                  <td class="px-6 py-2 font-medium text-ink-muted whitespace-nowrap" style="font-family: 'JetBrains Mono', monospace;">
                    {b.name}
                  </td>
                  <td class="px-6 py-2">
                    <span class="inline-block px-2 py-0.5 rounded bg-surface-dim text-xs font-medium text-ink-muted">{b.type}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>

      {/* Runtime */}
      <Section title="Runtime">
        <KeyValueTable
          data={{
            "Bun": runtime.bunVersion,
            "Platform": runtime.platform,
            "Arch": runtime.arch,
            ...(runtime.workerName ? { "Worker": runtime.workerName } : {}),
            ...(runtime.configName ? { "Config": runtime.configName } : {}),
          }}
        />
      </Section>

      <div class="text-center text-xs text-gray-400 py-4">
        Bunflare Dev Server
      </div>
    </div>
  );
}

render(<App />, document.getElementById("app")!);
