import { mkdtemp, writeFile, chmod, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  parseWorkflowImportLink,
  readWorkflowImportFile,
  WorkflowImportQueue,
  workflowImportDestination,
} from "../src/workflow-import.js";

describe("native workflow intake", () => {
  const shareId = "a".repeat(32);
  it("accepts only a bounded opaque share reference", () => {
    expect(
      parseWorkflowImportLink(`omnyo://workflows/import/${shareId}`),
    ).toEqual({ kind: "share", shareId });

    for (const value of [
      `omnyo://workflows/import/${shareId}?server=attacker`,
      "omnyo://workflows/import/../../secret",
      "https://attacker.invalid/w/x",
      `omnyo://workflows/import/${"a".repeat(129)}`,
    ])
      expect(parseWorkflowImportLink(value)).toBeNull();
  });
  it("queues cold and warm imports for one consumption", () => {
    const queue = new WorkflowImportQueue();
    expect(queue.take()).toBeNull();
    queue.add({ kind: "share", shareId });
    queue.add({ kind: "file", filename: "draft.omnyoworkflow", text: "{}" });
    expect(queue.pending).toBe(true);
    expect(queue.take()).toEqual({ kind: "share", shareId });
    expect(queue.take()).toEqual({
      kind: "file",
      filename: "draft.omnyoworkflow",
      text: "{}",
    });
    expect(queue.pending).toBe(false);
    expect(queue.take()).toBeNull();

    for (let i = 0; i < 8; i++) queue.add({ kind: "share", shareId });
    expect(() => queue.add({ kind: "share", shareId })).toThrow();
  });
  it("retains the selected coordinator mount and never accepts a link destination", () => {
    expect(
      workflowImportDestination("https://coordinator.example/mount/"),
    ).toBe(
      "https://coordinator.example/mount/plugins/automations/automations/import",
    );
    expect(() => workflowImportDestination("file:///tmp/evil")).toThrow();
    expect(() =>
      workflowImportDestination("https://user:password@example.test"),
    ).toThrow();
  });
  it("reads only bounded UTF8 regular files and strips the native path", async () => {
    const directory = await mkdtemp(join(tmpdir(), "omnyo-workflow-test-"));

    try {
      const file = join(directory, "input.omnyoworkflow");
      await writeFile(file, '{"title":"fictional"}');
      expect(await readWorkflowImportFile(file)).toEqual({
        kind: "file",
        filename: "input.omnyoworkflow",
        text: '{"title":"fictional"}',
      });
      const linked = join(directory, "linked.omnyoworkflow");
      await symlink(file, linked);
      await expect(readWorkflowImportFile(linked)).rejects.toThrow();
      await chmod(file, 0o755);
      await expect(readWorkflowImportFile(file)).rejects.toThrow("plain data");
      await chmod(file, 0o644);
      await writeFile(file, new Uint8Array(256 * 1024 + 1));
      await expect(readWorkflowImportFile(file)).rejects.toThrow();
      await writeFile(file, new Uint8Array([0xff]));
      await expect(readWorkflowImportFile(file)).rejects.toThrow();
      await expect(
        readWorkflowImportFile("relative.omnyoworkflow"),
      ).rejects.toThrow();
    } finally {
      await rm(directory, { recursive: true });
    }
  });
});
