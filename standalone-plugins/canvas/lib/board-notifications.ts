import type { PluginApi } from "@omnyo/plugin-sdk";
import { z } from "zod";
import { projectRealtimeChannel } from "../project-contract.ts";

type Database = ReturnType<PluginApi["storage"]["database"]>;

export function linkedBoardKeys(database: Database, board: string): Set<string> {
  const keys = new Set([board]);

  const links = database
    .prepare(
      "SELECT old_key AS key FROM canvas_board_aliases WHERE board_key=? UNION SELECT thread_id AS key FROM canvas_chats WHERE region_id=?",
    )
    .all(board, board);

  for (const link of links) keys.add(z.object({ key: z.string() }).parse(link).key);

  return keys;
}

export function publishProjectChange(api: PluginApi, board: string): void {
  const project = api.storage
    .database()
    .prepare(
      "SELECT p.project_id,p.revision FROM canvas_regions r JOIN canvas_projects p ON p.project_id=r.project_id WHERE r.id=?",
    )
    .get(board);

  if (project === undefined) return;
  const row = z.object({ project_id: z.string(), revision: z.number() }).parse(project);
  api.realtime.publish(projectRealtimeChannel, {
    projectId: row.project_id,
    revision: row.revision,
  });
}
