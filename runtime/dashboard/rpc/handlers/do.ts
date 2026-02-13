import type { HandlerContext, DoNamespace, DoInstance, DoDetail, OkResponse } from "../types";
import { getAllConfigs } from "../types";
import { getDatabase } from "../../../db";

export const handlers = {
  "do.listNamespaces"(_input: {}, ctx: HandlerContext): DoNamespace[] {
    const db = getDatabase();
    const rows = db.query<{ namespace: string; count: number }, []>(
      "SELECT namespace, COUNT(DISTINCT id) as count FROM do_storage GROUP BY namespace ORDER BY namespace"
    ).all();
    const rowMap = new Map(rows.map(r => [r.namespace, r]));
    for (const config of getAllConfigs(ctx)) {
      for (const b of config.durable_objects?.bindings ?? []) {
        if (!rowMap.has(b.class_name)) {
          rows.push({ namespace: b.class_name, count: 0 });
        }
      }
    }
    rows.sort((a, b) => a.namespace.localeCompare(b.namespace));
    return rows;
  },

  "do.listInstances"({ ns }: { ns: string }): DoInstance[] {
    const db = getDatabase();
    const rows = db.query<{ id: string; key_count: number }, [string]>(
      "SELECT id, COUNT(*) as key_count FROM do_storage WHERE namespace = ? GROUP BY id ORDER BY id"
    ).all(ns);

    const alarms = db.query<{ id: string; alarm_time: number }, [string]>(
      "SELECT id, alarm_time FROM do_alarms WHERE namespace = ?"
    ).all(ns);
    const alarmMap = new Map(alarms.map(a => [a.id, a.alarm_time]));

    return rows.map(row => ({
      ...row,
      alarm: alarmMap.get(row.id) ?? null,
    }));
  },

  "do.getInstance"({ ns, id }: { ns: string; id: string }): DoDetail {
    const db = getDatabase();
    const entries = db.query<{ key: string; value: string }, [string, string]>(
      "SELECT key, value FROM do_storage WHERE namespace = ? AND id = ? ORDER BY key"
    ).all(ns, id);

    const alarm = db.query<{ alarm_time: number }, [string, string]>(
      "SELECT alarm_time FROM do_alarms WHERE namespace = ? AND id = ?"
    ).get(ns, id);

    return { entries, alarm: alarm?.alarm_time ?? null };
  },

  "do.deleteEntry"({ ns, id, key }: { ns: string; id: string; key: string }): OkResponse {
    const db = getDatabase();
    db.prepare("DELETE FROM do_storage WHERE namespace = ? AND id = ? AND key = ?").run(ns, id, key);
    return { ok: true };
  },
};
