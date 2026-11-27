import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { describe, expect, it } from "vitest";
import { LEGACY_PROCESS_TAGS_IMPORTER_V1 } from "../legacy-process-tags-v1";
import { parseTagRow, READ_TAGS_PERL } from "../process-table";

const THREAD_ID = "thr_omnyo_process_tag_fixture";

const STORAGE = "/Users/test/.omnyo/thread-storage/" + THREAD_ID;

function readEntries(entries: string[]) {
  return spawnSync(
    "/usr/bin/perl",
    [
      "-e",
      String.raw`${LEGACY_PROCESS_TAGS_IMPORTER_V1}
use JSON::PP;
my %tags;
read_process_tag_v1(\%tags, $_) for @ARGV;
import_legacy_process_tags_v1(\%tags);
print JSON::PP->new->canonical->encode(\%tags);
`,
      ...entries,
    ],
    { encoding: "utf8", timeout: 1000, env: { PATH: "/usr/bin:/bin" } },
  );
}

async function readOwnedChild(tags: Record<string, string>) {
  const child = spawn(
    process.execPath,
    ["-e", "process.stdout.write('ready');setInterval(()=>{},1000)"],
    {
      env: tags,
      stdio: ["ignore", "pipe", "ignore"],
    },
  );

  try {
    await once(child.stdout, "data", { signal: AbortSignal.timeout(1000) });

    return spawnSync("/usr/bin/perl", ["-e", READ_TAGS_PERL, String(child.pid)], {
      encoding: "utf8",
      timeout: 1000,
      env: { PATH: "/usr/bin:/bin" },
    });
  } finally {
    const exited = once(child, "exit", { signal: AbortSignal.timeout(1000) });
    child.kill("SIGTERM");
    await exited;
  }
}

describe.runIf(process.platform === "darwin")("finite process-tag adoption", () => {
  it.each(["BB", "OMNYO"])("reads exact %s tags and ignores unrelated values", (prefix) => {
    const result = readEntries([
      `${prefix}_THREAD_ID=${THREAD_ID}`,
      `${prefix}_THREAD_STORAGE=${STORAGE}`,
      `${prefix}_KEEP_RUNNING=1`,
      "OTHER_FIELD=ignore-me",
    ]);

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      OMNYO_THREAD_ID: THREAD_ID,
      OMNYO_THREAD_STORAGE: STORAGE,
      OMNYO_KEEP_RUNNING: "1",
    });
  });

  it.each([THREAD_ID, "thr_conflict"])(
    "refuses dual tag owners even when the values coincide (%s)",
    (legacyId) => {
      const result = readEntries([`BB_THREAD_ID=${legacyId}`, `OMNYO_THREAD_ID=${THREAD_ID}`]);
      expect(result.status).not.toBe(0);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("Conflicting process identity tags");
    },
  );

  it.each(["BB", "OMNYO"])(
    "the real kernel reader retains a running %s-tagged process",
    async (prefix) => {
      const result = await readOwnedChild({
        [`${prefix}_THREAD_ID`]: THREAD_ID,
        [`${prefix}_THREAD_STORAGE`]: STORAGE,
        [`${prefix}_KEEP_RUNNING`]: "1",
      });

      expect(result.status).toBe(0);
      expect(parseTagRow(result.stdout.trim())).toMatchObject({
        threadId: THREAD_ID,
        storage: STORAGE,
        keepRequested: true,
      });
    },
  );

  it("the real kernel reader holds a conflicting owner without aborting inspection", async () => {
    const result = await readOwnedChild({ BB_THREAD_ID: "thr_legacy", OMNYO_THREAD_ID: THREAD_ID });
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/^!ownership\t\d+\n$/);
    expect(result.stdout).not.toContain("thr_legacy");
    expect(result.stderr).toBe("");
  });
});
