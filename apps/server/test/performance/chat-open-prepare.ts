import { mkdtempSync, statfsSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  createConnection,
  createProject,
  createThread,
  insertEvents,
  migrate,
  noopNotifier,
  upsertHost,
} from "@omnyo/db";
import { threadScope, turnScope } from "@omnyo/domain";

const output = process.argv[2];

if (!output) throw new Error("Expected an absolute manifest output path");

if (statfsSync(tmpdir()).bavail * statfsSync(tmpdir()).bsize < 3 * 1024 ** 3)
  throw new Error("Chat-open fixture requires 3 GiB free");

const directory = mkdtempSync(join(tmpdir(), "omnyo-chat-open-"));

const databasePath = join(directory, "app.db");

const receipt = `${resolve(output)}.storage.json`;

writeFileSync(
  receipt,
  JSON.stringify({
    owner: "chat-open-isolation",
    directory,
    databasePath,
    purpose: "Disposable inert history input for Chrome isolation acceptance",
    restoreInputs: import.meta.url,
    expectedMaximumBytes: 1_500_000_000,
    state: "preparing",
  }),
);

const db = createConnection(databasePath);

const probe = process.argv.includes("--probe");

const commandCount = probe ? 0 : 48;

try {
  migrate(db);
  const host = upsertHost(db, noopNotifier, { name: "inert-history-host" });

  const { project } = createProject(db, noopNotifier, {
    name: "Chat opening acceptance",
    source: { type: "local_path", hostId: host.id, path: directory },
  });

  const heavy = createThread(db, noopNotifier, {
    projectId: project.id,
    providerId: "codex",
    status: "idle",
    title: "Expensive history",
  });

  const text = "Synthetic historical command output. ".repeat(200_000);
  insertEvents(db, noopNotifier, [
    {
      threadId: heavy.id,
      sequence: 1,
      providerThreadId: "inert-provider",
      scope: turnScope("large-history"),
      type: "turn/started",
      itemId: null,
      itemKind: null,
      parentToolCallId: null,
      data: "{}",
    },
    ...Array.from({ length: commandCount }, (_, index) => ({
      threadId: heavy.id,
      sequence: index + 2,
      providerThreadId: "inert-provider",
      scope: turnScope("large-history"),
      type: "item/started" as const,
      itemId: `command-${index}`,
      itemKind: "commandExecution" as const,
      parentToolCallId: null,
      data: JSON.stringify({
        item: {
          id: `command-${index}`,
          type: "commandExecution",
          command: "inert history workload",
          cwd: directory,
          status: "pending",
          approvalStatus: null,
          aggregatedOutput: text,
        },
      }),
    })),
  ]);

  const small = Array.from({ length: 5 }, (_, index) => {
    const thread = createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
      status: "idle",
      title: `Small chat ${index}`,
    });

    const text = `Ready to read small chat ${index}.`;
    insertEvents(db, noopNotifier, [
      {
        threadId: thread.id,
        sequence: 1,
        scope: threadScope(),
        type: "system/manager/user_message",
        itemId: null,
        itemKind: null,
        parentToolCallId: null,
        data: JSON.stringify({ text }),
      },
    ]);

    return { id: thread.id, text };
  });

  db.$client.pragma("wal_checkpoint(TRUNCATE)");
  writeFileSync(
    resolve(output),
    JSON.stringify({
      owner: "chat-open-isolation",
      directory,
      temporaryRoot: resolve(tmpdir()),
      databasePath,
      hostId: host.id,
      projectId: project.id,
      heavyId: heavy.id,
      heavyMaxSeq: commandCount + 1,
      probe,
      small,
    }),
  );
  writeFileSync(
    receipt,
    JSON.stringify({
      owner: "chat-open-isolation",
      directory,
      databasePath,
      state: "prepared",
      databaseBytes: statSync(databasePath).size,
    }),
  );
  console.log(JSON.stringify({ manifest: resolve(output) }));
} finally {
  db.$client.close();
}
