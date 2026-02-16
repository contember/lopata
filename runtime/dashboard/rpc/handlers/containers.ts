import { $ } from "bun";
import type { HandlerContext, ContainerSummary, ContainerInstance } from "../types";
import { getAllConfigs } from "../types";

interface DockerPsEntry {
  Names: string;
  State: string;
  Status: string;
  Ports: string;
}

async function listDockerContainers(filterPrefix: string): Promise<DockerPsEntry[]> {
  const result = await $`docker ps -a --filter name=${filterPrefix} --format={{json .}}`.quiet().nothrow();
  if (result.exitCode !== 0) return [];
  const lines = result.stdout.toString().trim().split("\n").filter(Boolean);
  return lines.map(line => JSON.parse(line) as DockerPsEntry);
}

export const handlers = {
  async "containers.list"(_input: {}, ctx: HandlerContext): Promise<ContainerSummary[]> {
    const seen = new Map<string, ContainerSummary>();

    for (const config of getAllConfigs(ctx)) {
      for (const c of config.containers ?? []) {
        if (seen.has(c.class_name)) continue;
        seen.set(c.class_name, {
          className: c.class_name,
          image: c.image,
          maxInstances: c.max_instances ?? null,
          bindingName: c.name ?? c.class_name,
          runningCount: 0,
        });
      }
    }

    // Count running Docker containers per class
    for (const [className, summary] of seen) {
      const entries = await listDockerContainers(`bunflare-${className}-`);
      summary.runningCount = entries.filter(e => e.State === "running").length;
    }

    return Array.from(seen.values());
  },

  async "containers.listInstances"({ className }: { className: string }, _ctx: HandlerContext): Promise<ContainerInstance[]> {
    const entries = await listDockerContainers(`bunflare-${className}-`);

    return entries.map(e => {
      // Parse ports string like "0.0.0.0:32768->8080/tcp" into a record
      const ports: Record<string, string> = {};
      if (e.Ports) {
        for (const part of e.Ports.split(", ")) {
          const match = part.match(/(.+)->(\d+\/\w+)/);
          if (match) {
            ports[match[2]!] = match[1]!;
          }
        }
      }

      return {
        name: e.Names,
        state: e.State,
        exitCode: null,
        ports,
      };
    });
  },
};
