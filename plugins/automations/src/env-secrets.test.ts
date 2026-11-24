import Database from "better-sqlite3";
import {
  createFakePluginHost,
  type FakePluginHost,
} from "@omnyo/plugin-sdk/testing";
import { afterEach, describe, expect, it } from "vitest";
import {
  createAutomation,
  decodeAutomationRow,
  getAutomation,
  migrations,
  type Db,
} from "./data.js";
import { openAutomationEnv } from "./env-secrets.js";

const hosts: FakePluginHost[] = [];

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.harness.dispose();
});

const log = { error: () => undefined };

function setup() {
  const host = createFakePluginHost({ pluginId: "automations" });
  hosts.push(host);
  const db: Db = new Database(":memory:");

  for (const migration of migrations) db.exec(migration);

  return { db, secrets: host.api.experimental_secrets };
}

function createScript(db: Db, id: string) {
  return createAutomation(db, {
    id,
    projectId: "proj_test",
    name: "Script",
    enabled: true,
    trigger: { triggerType: "once", runAt: 4_102_452_000_000 },
    runMode: "script",
    execution: {
      mode: "script",
      scriptFile: "script.sh",
      timeoutMs: 120_000,
      workingDirectory: { type: "automation-storage" },
    },
    origin: "human",
    createdByThreadId: null,
    nextRunAt: 4_102_452_000_000,
  });
}

function setStoredExecution(db: Db, id: string, execution: object) {
  db.prepare("UPDATE automations SET execution = ? WHERE id = ?").run(
    JSON.stringify(execution),
    id,
  );
}

function storedExecution(db: Db, id: string): unknown {
  return JSON.parse(getAutomation(db, id)?.execution ?? "null");
}

const scriptExecution = {
  mode: "script",
  scriptFile: "script.sh",
  timeoutMs: 120_000,
  workingDirectory: { type: "automation-storage" },
};

describe("automation env secrets", () => {
  it("moves env values from a stored row into one secret per automation", async () => {
    const { db, secrets } = setup();
    createScript(db, "auto_row");
    setStoredExecution(db, "auto_row", {
      ...scriptExecution,
      env: { TOKEN: "row-token", "odd key/:": "x" },
    });

    const env = await openAutomationEnv({ db, secrets, log });

    expect(await secrets.get("env/auto_row")).toBe(
      JSON.stringify({ TOKEN: "row-token", "odd key/:": "x" }),
    );
    expect(storedExecution(db, "auto_row")).toEqual({
      ...scriptExecution,
      envKeys: ["TOKEN", "odd key/:"],
    });
    expect(getAutomation(db, "auto_row")?.execution).not.toContain("row-token");

    const row = getAutomation(db, "auto_row");

    if (row === null) throw new Error("Expected stored automation");
    expect(decodeAutomationRow(row, env).automation).toMatchObject({
      execution: { env: { TOKEN: "row-token", "odd key/:": "x" } },
    });
  });

  it("leaves an already moved automation alone", async () => {
    const { db, secrets } = setup();
    createScript(db, "auto_moved");
    setStoredExecution(db, "auto_moved", {
      ...scriptExecution,
      envKeys: ["TOKEN"],
    });
    await secrets.set("env/auto_moved", JSON.stringify({ TOKEN: "secret" }));

    const env = await openAutomationEnv({ db, secrets, log });

    expect(env.values("auto_moved")).toEqual({ TOKEN: "secret" });
    expect(await secrets.get("env/auto_moved")).toBe('{"TOKEN":"secret"}');
    expect(storedExecution(db, "auto_moved")).toEqual({
      ...scriptExecution,
      envKeys: ["TOKEN"],
    });
  });

  it("finishes a move interrupted after the secret was written", async () => {
    const { db, secrets } = setup();
    createScript(db, "auto_crash");
    setStoredExecution(db, "auto_crash", {
      ...scriptExecution,
      env: { TOKEN: "same" },
    });
    await secrets.set("env/auto_crash", JSON.stringify({ TOKEN: "same" }));

    const env = await openAutomationEnv({ db, secrets, log });

    expect(env.values("auto_crash")).toEqual({ TOKEN: "same" });
    expect(await secrets.list()).toEqual(["env/auto_crash"]);
    expect(storedExecution(db, "auto_crash")).toEqual({
      ...scriptExecution,
      envKeys: ["TOKEN"],
    });
  });

  it("prefers values still in the row over an older secret", async () => {
    const { db, secrets } = setup();
    createScript(db, "auto_newer");
    setStoredExecution(db, "auto_newer", {
      ...scriptExecution,
      env: { TOKEN: "newer" },
    });
    await secrets.set(
      "env/auto_newer",
      JSON.stringify({ TOKEN: "older", OTHER: "gone" }),
    );

    const env = await openAutomationEnv({ db, secrets, log });

    expect(env.values("auto_newer")).toEqual({ TOKEN: "newer" });
    expect(await secrets.get("env/auto_newer")).toBe('{"TOKEN":"newer"}');
  });

  it("is idempotent across restarts", async () => {
    const { db, secrets } = setup();
    createScript(db, "auto_twice");
    setStoredExecution(db, "auto_twice", {
      ...scriptExecution,
      env: { TOKEN: "kept" },
    });

    await openAutomationEnv({ db, secrets, log });
    const before = getAutomation(db, "auto_twice")?.execution;
    const env = await openAutomationEnv({ db, secrets, log });

    expect(getAutomation(db, "auto_twice")?.execution).toBe(before);
    expect(env.values("auto_twice")).toEqual({ TOKEN: "kept" });
    expect(await secrets.list()).toEqual(["env/auto_twice"]);
  });

  it("removes secrets whose automation no longer names them and trims keys the row dropped", async () => {
    const { db, secrets } = setup();
    createScript(db, "auto_plain");
    createScript(db, "auto_trim");
    setStoredExecution(db, "auto_trim", {
      ...scriptExecution,
      envKeys: ["KEEP"],
    });
    await secrets.set("env/auto_deleted", JSON.stringify({ TOKEN: "x" }));
    await secrets.set("env/auto_plain", JSON.stringify({ TOKEN: "y" }));
    await secrets.set(
      "env/auto_trim",
      JSON.stringify({ KEEP: "1", DROPPED: "2" }),
    );

    const env = await openAutomationEnv({ db, secrets, log });

    expect(await secrets.list()).toEqual(["env/auto_trim"]);
    expect(env.values("auto_trim")).toEqual({ KEEP: "1" });
    expect(await secrets.get("env/auto_trim")).toBe('{"KEEP":"1"}');
  });

  it("reports an automation whose env secret is missing as invalid stored data", async () => {
    const { db, secrets } = setup();
    createScript(db, "auto_lost");
    setStoredExecution(db, "auto_lost", {
      ...scriptExecution,
      envKeys: ["TOKEN"],
    });

    const env = await openAutomationEnv({ db, secrets, log });
    const row = getAutomation(db, "auto_lost");

    if (row === null) throw new Error("Expected stored automation");
    const decoded = decodeAutomationRow(row, env);

    expect(decoded.automation).toMatchObject({
      id: "auto_lost",
      problem: "invalid-stored-data",
    });
    expect("error" in decoded && decoded.error.message).toContain(
      "has no stored value for environment variables TOKEN",
    );
  });

  it("writes create and update env values to the secret, never to the row", async () => {
    const { db, secrets } = setup();
    const env = await openAutomationEnv({ db, secrets, log });

    await env.write("auto_new", { TOKEN: "first" });
    createAutomation(db, {
      id: "auto_new",
      projectId: "proj_test",
      name: "Script",
      enabled: true,
      trigger: { triggerType: "once", runAt: 4_102_452_000_000 },
      runMode: "script",
      execution: {
        mode: "script",
        scriptFile: "script.sh",
        timeoutMs: 120_000,
        workingDirectory: { type: "automation-storage" },
        env: { TOKEN: "first" },
      },
      origin: "human",
      createdByThreadId: null,
      nextRunAt: 4_102_452_000_000,
    });

    expect(getAutomation(db, "auto_new")?.execution).not.toContain("first");
    expect(storedExecution(db, "auto_new")).toMatchObject({
      envKeys: ["TOKEN"],
    });

    const reopened = await openAutomationEnv({ db, secrets, log });

    expect(reopened.values("auto_new")).toEqual({ TOKEN: "first" });
    await reopened.write("auto_new", undefined);
    expect(await secrets.list()).toEqual([]);
  });
});
