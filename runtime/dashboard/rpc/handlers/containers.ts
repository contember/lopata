import { $ } from "bun";
import type { HandlerContext, ContainerSummary, ContainerInstance } from "../types";
import { getAllConfigs } from "../types";
import { getDatabase } from "../../../db";

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

function parsePorts(portsStr: string): Record<string, string> {
  const ports: Record<string, string> = {};
  if (!portsStr) return ports;
  for (const part of portsStr.split(", ")) {
    const match = part.match(/(.+)->(\d+\/\w+)/);
    if (match) {
      ports[match[2]!] = match[1]!;
    }
  }
  return ports;
}

export const handlers = {
  async "containers.list"(_input: {}, ctx: HandlerContext): Promise<ContainerSummary[]> {
    const seen = new Map<string, ContainerSummary>();
    const db = getDatabase();

    for (const config of getAllConfigs(ctx)) {
      for (const c of config.containers ?? []) {
        if (seen.has(c.class_name)) continue;

        const row = db.query<{ count: number }, [string]>(
          "SELECT COUNT(*) as count FROM do_instances WHERE namespace = ?"
        ).get(c.class_name);

        seen.set(c.class_name, {
          className: c.class_name,
          image: c.image,
          maxInstances: c.max_instances ?? null,
          bindingName: c.name ?? c.class_name,
          instanceCount: row?.count ?? 0,
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
    const db = getDatabase();

    // Primary source: DO instances from SQLite
    const doInstances = db.query<{ id: string; name: string | null }, [string]>(
      "SELECT id, name FROM do_instances WHERE namespace = ? ORDER BY id"
    ).all(className);

    // Secondary source: Docker containers for state info
    const dockerEntries = await listDockerContainers(`bunflare-${className}-`);
    const dockerByPrefix = new Map<string, DockerPsEntry>();
    for (const e of dockerEntries) {
      // Container name format: bunflare-{className}-{idHex.slice(0,12)}
      const prefix = e.Names.replace(`bunflare-${className}-`, "");
      if (prefix) dockerByPrefix.set(prefix, e);
    }

    // Map DO instances with Docker state
    const seenPrefixes = new Set<string>();
    const results: ContainerInstance[] = doInstances.map(inst => {
      const idPrefix = inst.id.slice(0, 12);
      seenPrefixes.add(idPrefix);
      const docker = dockerByPrefix.get(idPrefix);

      return {
        id: inst.id,
        doName: inst.name,
        containerName: docker?.Names ?? `bunflare-${className}-${idPrefix}`,
        state: docker?.State ?? "stopped",
        ports: docker ? parsePorts(docker.Ports) : {},
      };
    });

    // Include any Docker containers without a matching DO instance
    for (const [prefix, docker] of dockerByPrefix) {
      if (seenPrefixes.has(prefix)) continue;
      results.push({
        id: prefix,
        doName: null,
        containerName: docker.Names,
        state: docker.State,
        ports: parsePorts(docker.Ports),
      });
    }

    return results;
  },
};
