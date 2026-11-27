import type { PluginApi } from "@omnyo/plugin-sdk";
import { cuaResource, type CuaResource } from "./cua-contract";

export const CUA_MIGRATIONS = [
  "CREATE TABLE cua_resources (id TEXT PRIMARY KEY, host_id TEXT NOT NULL, value TEXT NOT NULL)",
  "CREATE INDEX cua_resources_host_idx ON cua_resources(host_id)",
];

export function createCuaStore(db: ReturnType<PluginApi["storage"]["database"]>) {
  const selectAll = db.prepare<[], { value: string }>("SELECT value FROM cua_resources");

  const selectHost = db.prepare<[string], { value: string }>(
    "SELECT value FROM cua_resources WHERE host_id = ?",
  );

  const selectOne = db.prepare<[string], { value: string }>(
    "SELECT value FROM cua_resources WHERE id = ?",
  );

  const save = db.prepare<[string, string, string]>(
    "INSERT INTO cua_resources (id, host_id, value) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET host_id = excluded.host_id, value = excluded.value",
  );

  function parse(value: string): CuaResource {
    const input: unknown = JSON.parse(value);

    return cuaResource.parse(input);
  }

  return {
    list(hostId?: string): CuaResource[] {
      return (hostId === undefined ? selectAll.all() : selectHost.all(hostId)).map((row) =>
        parse(row.value),
      );
    },
    get(id: string): CuaResource | null {
      const row = selectOne.get(id);

      return row === undefined ? null : parse(row.value);
    },
    save(resource: CuaResource): void {
      const checked = cuaResource.parse(resource);
      save.run(checked.id, checked.hostId, JSON.stringify(checked));
    },
  };
}

export type CuaStore = ReturnType<typeof createCuaStore>;
