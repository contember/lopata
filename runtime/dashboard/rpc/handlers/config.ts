import type { HandlerContext } from "../types";
import { getAllConfigs } from "../types";

export interface ConfigItem {
  name: string;
  value: string;
}

export interface ConfigGroup {
  title: string;
  items: ConfigItem[];
}

export const handlers = {
  "config.forService"({ type }: { type: string }, ctx: HandlerContext): ConfigGroup[] {
    const groups: ConfigGroup[] = [];

    for (const config of getAllConfigs(ctx)) {
      switch (type) {
        case "kv": {
          const items = (config.kv_namespaces ?? []).map(ns => ({ name: ns.binding, value: ns.id }));
          if (items.length) groups.push({ title: "Bindings", items });
          break;
        }

        case "r2": {
          const items = (config.r2_buckets ?? []).map(b => ({ name: b.binding, value: b.bucket_name }));
          if (items.length) groups.push({ title: "Bindings", items });
          break;
        }

        case "queue": {
          const producers = (config.queues?.producers ?? []).map(p => {
            let value = p.queue;
            if (p.delivery_delay != null) value += ` · delay ${p.delivery_delay}s`;
            return { name: p.binding, value };
          });
          if (producers.length) groups.push({ title: "Producers", items: producers });

          const consumers = (config.queues?.consumers ?? []).map(c => {
            const parts: string[] = [];
            if (c.max_batch_size != null) parts.push(`batch ${c.max_batch_size}`);
            if (c.max_retries != null) parts.push(`retries ${c.max_retries}`);
            if (c.max_batch_timeout != null) parts.push(`timeout ${c.max_batch_timeout}s`);
            if (c.dead_letter_queue) parts.push(`dlq ${c.dead_letter_queue}`);
            return { name: c.queue, value: parts.join(" · ") || "defaults" };
          });
          if (consumers.length) groups.push({ title: "Consumers", items: consumers });
          break;
        }

        case "do": {
          const items = (config.durable_objects?.bindings ?? []).map(b => ({ name: b.name, value: b.class_name }));
          if (items.length) groups.push({ title: "Bindings", items });
          break;
        }

        case "workflows": {
          const items = (config.workflows ?? []).map(w => ({ name: w.binding, value: w.class_name }));
          if (items.length) groups.push({ title: "Bindings", items });
          break;
        }

        case "d1": {
          const items = (config.d1_databases ?? []).map(db => ({ name: db.binding, value: db.database_name }));
          if (items.length) groups.push({ title: "Bindings", items });
          break;
        }

        case "containers": {
          const items = (config.containers ?? []).map(c => ({
            name: c.name ?? c.class_name,
            value: `${c.image}${c.max_instances ? ` · max ${c.max_instances}` : ""}`,
          }));
          if (items.length) groups.push({ title: "Containers", items });
          break;
        }

        case "scheduled": {
          const crons = config.triggers?.crons ?? [];
          if (crons.length) {
            groups.push({
              title: "Cron Triggers",
              items: crons.map((c, i) => ({ name: `Trigger ${i + 1}`, value: c })),
            });
          }
          break;
        }

        case "ai": {
          if (config.ai) {
            groups.push({ title: "Bindings", items: [{ name: config.ai.binding, value: "Workers AI" }] });
          }
          break;
        }

        case "hyperdrive": {
          const items = (config.hyperdrive ?? []).map(hd => {
            let value = hd.id;
            if (hd.localConnectionString) {
              try {
                const url = new URL(hd.localConnectionString);
                value += ` · ${url.hostname}`;
              } catch {}
            }
            return { name: hd.binding, value };
          });
          if (items.length) groups.push({ title: "Bindings", items });
          break;
        }

        case "email": {
          const items = (config.send_email ?? []).map(e => {
            let value = e.destination_address ?? "any destination";
            if (e.allowed_destination_addresses?.length) {
              value = e.allowed_destination_addresses.join(", ");
            }
            return { name: e.name, value };
          });
          if (items.length) groups.push({ title: "Bindings", items });
          break;
        }
      }
    }

    return groups;
  },
};
