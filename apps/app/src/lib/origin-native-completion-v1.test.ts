import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { z } from "zod";
import { expect, test, vi } from "vitest";
import { originStorageTicketSchemaV1 } from "./origin-storage-transfer-v1";
import {
  digestOriginWindowStateV1,
  type stageOriginWindowStateV1,
} from "./origin-window-state-v1";
import { originNativeMappingSchemaV1 } from "./origin-native-completion-v1";
import { requireOriginNativeSinkV1 } from "./origin-native-completion-v1";

const observation = {
  version: 1 as const,
  kind: "origin-adoption-inventory" as const,
  adoptionId: "selected-adoption",
  id: "a".repeat(64),
  windowKey: "explicit-old-tab",
  mapping: {
    version: 1 as const,
    adoptionId: "selected-adoption",
    fromOrigin: "https://bb.alexburlis.com",
    toOrigin: "https://app.example.invalid",
    serverHostId: "host-original",
    runtimeId: "control-original",
    selectedIds: ["a".repeat(64)],
    mappingSha256: "b".repeat(64),
  },
  returnPath: "/projects/original/threads/thr_original",
  sourceInventorySha256: "c".repeat(64),
  targetInventorySha256: "d".repeat(64),
};

const accepted = {
  version: 1,
  kind: "origin-adoption-inventory-accepted",
  adoptionId: observation.adoptionId,
  id: observation.id,
  windowKey: observation.windowKey,
  sourceInventorySha256: observation.sourceInventorySha256,
  targetInventorySha256: observation.targetInventorySha256,
};

test("requires the native owner to acknowledge the exact independent inventories before target state import", async () => {
  let acknowledge: ((value: unknown) => void) | null = null;

  const postMessage = vi.fn(
    () =>
      new Promise((resolve) => {
        acknowledge = resolve;
      }),
  );

  const sink = requireOriginNativeSinkV1({
    messageHandlers: { omnyoOriginAdoptionV1: { postMessage } },
  });

  const mutateTarget = vi.fn();
  const importing = sink.inventory(observation).then(mutateTarget);
  await Promise.resolve();
  expect(mutateTarget).not.toHaveBeenCalled();
  expect(postMessage).toHaveBeenCalledExactlyOnceWith(observation);

  if (acknowledge === null)
    throw new Error("Native observation was not delivered");
  Reflect.apply(acknowledge, null, [accepted]);
  await importing;
  expect(mutateTarget).toHaveBeenCalledTimes(1);
  expect(observation.sourceInventorySha256).not.toBe(
    observation.targetInventorySha256,
  );
});

test("refuses missing, foreign or changed native acknowledgments without target mutation", async () => {
  for (const reply of [
    undefined,
    { ...accepted, windowKey: "another-tab" },
    { ...accepted, sourceInventorySha256: observation.targetInventorySha256 },
    { ...accepted, adoptionId: "another-adoption" },
  ]) {
    const mutateTarget = vi.fn();

    const sink = requireOriginNativeSinkV1({
      messageHandlers: {
        omnyoOriginAdoptionV1: { postMessage: async () => reply },
      },
    });

    await expect(
      sink.inventory(observation).then(mutateTarget),
    ).rejects.toThrow();
    expect(mutateTarget).not.toHaveBeenCalled();
  }

  expect(() => requireOriginNativeSinkV1({})).toThrow("remains closed");
});

type SourceStageReceipt = Awaited<ReturnType<typeof stageOriginWindowStateV1>>;

const sourceStageInput = {
  version: 1,
  ticket: {
    version: 1,
    adoptionId: "selected-source-stage",
    id: "a".repeat(64),
    selectedIds: ["a".repeat(64), "b".repeat(64), "c".repeat(64)],
    nonce: "e".repeat(64),
    fromOrigin: "https://bb.alexburlis.com",
    toOrigin: "https://app.example.invalid",
  },
  mapping: {
    version: 1,
    adoptionId: "selected-source-stage",
    fromOrigin: "https://bb.alexburlis.com",
    toOrigin: "https://app.example.invalid",
    serverHostId: "selected-host",
    runtimeId: "selected-runtime",
    selectedIds: ["a".repeat(64), "b".repeat(64), "c".repeat(64)],
    mappingSha256: "d".repeat(64),
  },
  returnPath: "/projects/fixture/threads/selected",
  completion: { kind: "react-native-source", windowKey: "selected-old-page" },
  windowState: { action: "stage", windowKey: "selected-old-page" },
};

const sourceStageReceipt: SourceStageReceipt = {
  version: 1,
  transferId: sourceStageInput.ticket.id,
  windowKey: "selected-old-page",
  staged: true,
  sha256: "f".repeat(64),
};

async function sourceStageSubject(
  options: {
    origin?: string;
    childFrame?: boolean;
    bridge?: boolean;
    stage?: () => Promise<SourceStageReceipt>;
  } = {},
) {
  const path = new URL("../origin-adoption-v1.ts", import.meta.url);
  const text = await readFile(path, "utf8");

  const parsed = ts.createSourceFile(
    path.pathname,
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );

  const schema = parsed.statements.find(
    (node) =>
      ts.isVariableStatement(node) &&
      node.declarationList.declarations.some(
        (entry) =>
          ts.isIdentifier(entry.name) && entry.name.text === "bootstrapSchema",
      ),
  );

  const sink = parsed.statements.find(
    (node) =>
      ts.isFunctionDeclaration(node) &&
      node.name?.text === "requireOriginReactNativeSourceStageSinkV1",
  );

  let stageBranch: ts.IfStatement | undefined;

  const visit = (node: ts.Node) => {
    if (
      ts.isIfStatement(node) &&
      node.expression.getText(parsed) === 'input.windowState.action === "stage"'
    )
      stageBranch = node;
    ts.forEachChild(node, visit);
  };

  visit(parsed);

  if (
    !schema ||
    !sink ||
    !stageBranch ||
    !ts.isBlock(stageBranch.thenStatement)
  )
    throw new Error("Actual selected source-stage owner was not found");
  const code = `${schema.getText(parsed)}\n${sink.getText(parsed)}\n({parse(value){return bootstrapSchema.parse(value)},async stage(value){const input=bootstrapSchema.parse(value);const args={};const sourceStageCompletion=requireOriginReactNativeSourceStageSinkV1(input);${stageBranch.thenStatement.getText(parsed)}}})`;
  const postMessage = vi.fn<(value: string) => void>();
  const handler = { postMessage };
  let bridge: unknown = options.bridge === false ? undefined : handler;
  let bridgeReads = 0;
  const selectedWindow: { parent: object | null } = { parent: null };
  selectedWindow.parent = options.childFrame ? {} : selectedWindow;
  Object.defineProperty(selectedWindow, "ReactNativeWebView", {
    get() {
      bridgeReads++;

      return bridge;
    },
  });
  const stage = vi.fn(options.stage ?? (async () => sourceStageReceipt));

  const subject: {
    parse(value: unknown): unknown;
    stage(value: unknown): Promise<unknown>;
  } = runInNewContext(
    ts.transpileModule(code, {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.None,
      },
    }).outputText,
    {
      z,
      mappingSchema: originNativeMappingSchemaV1,
      originStorageTicketSchemaV1,
      digestOriginWindowStateV1,
      stageOriginWindowStateV1: stage,
      location: {
        origin: options.origin ?? sourceStageInput.ticket.fromOrigin,
      },
      window: selectedWindow,
      document: { getElementById: () => ({ textContent: "" }) },
    },
  );

  return {
    subject,
    stage,
    postMessage,
    bridgeReads: () => bridgeReads,
    replaceBridge: () => {
      bridge = { postMessage: vi.fn() };
    },
  };
}

test("source-stage RNC metadata is emitted only after the actual selected stage branch commits", async () => {
  let commit: () => void = () => {
    throw new Error("Stage was not waiting");
  };

  const pending = new Promise<SourceStageReceipt>((resolve) => {
    commit = () => resolve(sourceStageReceipt);
  });

  const selected = await sourceStageSubject({ stage: () => pending });
  const staging = selected.subject.stage(sourceStageInput);
  await Promise.resolve();
  expect(selected.stage).toHaveBeenCalledTimes(1);
  expect(selected.postMessage).not.toHaveBeenCalled();
  commit();
  await staging;
  expect(selected.postMessage).toHaveBeenCalledTimes(1);
  const raw = selected.postMessage.mock.calls[0]?.[0];

  if (!raw) throw new Error("Committed stage metadata was not sent");
  expect(JSON.parse(raw)).toEqual({
    version: 1,
    kind: "origin-adoption-source-staged",
    ticketSha256: await digestOriginWindowStateV1(
      JSON.stringify(
        originStorageTicketSchemaV1.parse(sourceStageInput.ticket),
      ),
    ),
    adoptionId: sourceStageInput.ticket.adoptionId,
    transferId: sourceStageInput.ticket.id,
    windowKey: sourceStageReceipt.windowKey,
    sourceStageSha256: sourceStageReceipt.sha256,
    returnPath: sourceStageInput.returnPath,
  });
  expect(raw).not.toContain('"ticket":');
  expect(raw).not.toContain('"nonce":');
  expect(raw).not.toContain('"staged":');
});

test("source-stage RNC refuses foreign contexts, failed commits and changed bridge owners", async () => {
  for (const options of [
    { origin: sourceStageInput.ticket.toOrigin },
    { childFrame: true },
    { bridge: false },
  ]) {
    const selected = await sourceStageSubject(options);
    await expect(selected.subject.stage(sourceStageInput)).rejects.toThrow();
    expect(selected.stage).not.toHaveBeenCalled();
    expect(selected.postMessage).not.toHaveBeenCalled();
  }

  for (const input of [
    {
      ...sourceStageInput,
      windowState: { action: "restore", windowKey: "selected-old-page" },
    },
    {
      ...sourceStageInput,
      completion: { kind: "react-native-source", windowKey: "foreign-page" },
    },
  ]) {
    const selected = await sourceStageSubject();
    await expect(selected.subject.stage(input)).rejects.toThrow();
    expect(selected.stage).not.toHaveBeenCalled();
    expect(selected.postMessage).not.toHaveBeenCalled();
  }

  for (const receipt of [
    { ...sourceStageReceipt, transferId: "b".repeat(64) },
    { ...sourceStageReceipt, windowKey: "foreign-page" },
    { ...sourceStageReceipt, sha256: "invalid-digest" },
  ]) {
    const selected = await sourceStageSubject({ stage: async () => receipt });
    await expect(selected.subject.stage(sourceStageInput)).rejects.toThrow();
    expect(selected.postMessage).not.toHaveBeenCalled();
  }

  const failed = await sourceStageSubject({
    stage: async () => {
      throw new Error("Actual stage rejected");
    },
  });

  await expect(failed.subject.stage(sourceStageInput)).rejects.toThrow(
    "Actual stage rejected",
  );
  expect(failed.postMessage).not.toHaveBeenCalled();

  let commit: () => void = () => {
    throw new Error("Stage was not waiting");
  };

  const pending = new Promise<SourceStageReceipt>((resolve) => {
    commit = () => resolve(sourceStageReceipt);
  });

  const changed = await sourceStageSubject({ stage: () => pending });
  const staging = changed.subject.stage(sourceStageInput);
  changed.replaceBridge();
  commit();
  await expect(staging).rejects.toThrow("receiver changed");
  expect(changed.postMessage).not.toHaveBeenCalled();
});

test("source-stage legacy native and unselected bootstrap modes never read the RNC bridge", async () => {
  for (const completion of [
    null,
    { kind: "native", windowKey: "selected-old-page" },
  ]) {
    const selected = await sourceStageSubject();
    await selected.subject.stage({ ...sourceStageInput, completion });
    expect(selected.stage).toHaveBeenCalledTimes(1);
    expect(selected.postMessage).not.toHaveBeenCalled();
    expect(selected.bridgeReads()).toBe(0);
  }

  const selected = await sourceStageSubject();
  expect(() =>
    selected.subject.parse({
      ...sourceStageInput,
      completion: { kind: "unknown-source", windowKey: "selected-old-page" },
    }),
  ).toThrow();
});
