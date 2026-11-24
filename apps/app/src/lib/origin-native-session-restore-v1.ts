import {
  originNativeWindowEntrySchemaV1,
  originNativeFirstEntryRequestSchemaV1,
  originNativeFirstEntryReplySchemaV1,
} from "@omnyo/desktop-contract/internal/origin-adoption-v1";

export {
  originNativeSessionRestoreSchemaV1,
  originNativeFirstEntryRequestSchemaV1,
  originNativeFirstEntryReplySchemaV1,
} from "@omnyo/desktop-contract/internal/origin-adoption-v1";

import {
  digestOriginWindowStateV1,
  originTargetStorageEntriesV1,
  originLocalWindowSchemaV1,
  originFirstEntryMutationSchemaV1,
  originFirstEntryPayloadSchemaV1,
  originFirstEntryRecordSchemaV1,
  readOriginFirstEntryRecordV1,
  writeOriginFirstEntryRecordV1,
  readExactOriginTargetWindowStateV1,
  type OriginLocalWindowV1,
  type OriginFirstEntryRecordV1,
} from "./origin-window-state-v1";
import {
  planOriginComposerRecoveryV1,
  preserveComposerSubmissionTabV1,
} from "./prompt-draft-recovery-v1";

import { z } from "zod";
import {
  assertOriginAdoptionAcceptedV1,
  ORIGIN_STORAGE_ADMISSION_LOCK_V1,
} from "./origin-storage-transfer-v1";

export async function restoreNativeOriginSessionV1(
  value: unknown,
  args: {
    currentOrigin: string;
    local: Storage;
    session: Storage;
    nativeOwner: unknown;
  },
) {
  const input = originNativeWindowEntrySchemaV1.parse(value);

  if ("kind" in input) {
    if (args.currentOrigin !== input.mapping.toOrigin)
      throw new Error("Native identity continuation requires its exact origin");
    const native = requireNativeFirstEntryOwner(args.nativeOwner);

    const inspectRequest = originNativeFirstEntryRequestSchemaV1.parse({
      ...input,
      kind: "inspect",
      recipeSha256: null,
    });

    const inspected = await native(inspectRequest);

    if (
      !inspected.ordinaryEntryAuthorized ||
      inspected.protectedAdmission !== 1 ||
      inspected.recipeSha256 !== input.recipeSha256
    )
      throw new Error("Native identity continuation is not admitted");
    preserveComposerSubmissionTabV1(args.session, input.composerTabId);

    return async () => {
      await native({
        ...inspectRequest,
        kind: "entered",
        recipeSha256: input.recipeSha256,
      });
    };
  }

  const selection = await localSelection(
    input.localWindows,
    args.currentOrigin,
  );

  const selected = selection.windows.find(
    (window) => window.windowKey === input.windowKey,
  );

  if (
    args.currentOrigin !== input.ticket.toOrigin ||
    !selected ||
    JSON.stringify(selected.ticket) !== JSON.stringify(input.ticket) ||
    selected.targetStageSha256 !== input.targetStageSha256 ||
    input.mapping.adoptionId !== input.ticket.adoptionId ||
    input.mapping.fromOrigin !== input.ticket.fromOrigin ||
    input.mapping.toOrigin !== input.ticket.toOrigin ||
    JSON.stringify(input.mapping.selectedIds) !==
      JSON.stringify(input.ticket.selectedIds)
  )
    throw new Error(
      "Native session restoration requires its exact sealed window and mapping",
    );

  const binding = {
    version: 1 as const,
    nativeJobId: input.nativeJobId,
    localSelectionSha256: selection.sha256,
    transferId: input.ticket.id,
    windowKey: input.windowKey,
    targetStageSha256: input.targetStageSha256,
    originPayloadSha256: selected.originPayloadSha256,
    composerTabId: selected.composerTabId,
    mapping: input.mapping,
  };

  const native = requireNativeFirstEntryOwner(args.nativeOwner);

  const inspected = await native({
    ...binding,
    kind: "inspect",
    recipeSha256: null,
  });

  if (inspected.ordinaryEntryAuthorized)
    throw new Error(
      "The old full-session descriptor cannot enter an admitted native window",
    );

  const recipe = await withNativeClosedOriginLeaseV1(() =>
    prepareOriginFirstEntryRecoveryV1({
      windows: selection.windows,
      currentOrigin: args.currentOrigin,
      local: args.local,
    }),
  );

  const recipeSha256 = recipe.recipeSha256;
  await preflightOriginFirstEntryWindowV1({
    windows: selection.windows,
    currentOrigin: args.currentOrigin,
    local: args.local,
    session: args.session,
    recipeSha256,
    windowKey: input.windowKey,
  });
  await native({ ...binding, kind: "preflight", recipeSha256 });
  await withNativeClosedOriginLeaseV1(async () => {
    await preflightOriginFirstEntryWindowV1({
      windows: selection.windows,
      currentOrigin: args.currentOrigin,
      local: args.local,
      session: args.session,
      recipeSha256,
      windowKey: input.windowKey,
    });
    await applyOriginFirstEntryRecoveryV1({
      windows: selection.windows,
      currentOrigin: args.currentOrigin,
      local: args.local,
      recipeSha256,
    });
    await restoreOriginFirstEntryWindowV1({
      windows: selection.windows,
      currentOrigin: args.currentOrigin,
      local: args.local,
      session: args.session,
      recipeSha256,
      windowKey: input.windowKey,
    });
  });

  await native({ ...binding, kind: "ready", recipeSha256 });
  const prepared = await native({ ...binding, kind: "prepared", recipeSha256 });

  if (prepared.protectedAdmission !== 1 || prepared.ordinaryEntryAuthorized)
    throw new Error(
      "Native protected admission did not preserve the ordinary writer fence",
    );

  await withNativeClosedOriginLeaseV1(() =>
    retireOriginFirstEntryControllersV1({
      windows: selection.windows,
      currentOrigin: args.currentOrigin,
      local: args.local,
      session: args.session,
      recipeSha256,
      windowKey: input.windowKey,
    }),
  );
  await native({ ...binding, kind: "retired", recipeSha256 });
  const entry = await native({ ...binding, kind: "will-enter", recipeSha256 });

  if (!entry.ordinaryEntryAuthorized || entry.protectedAdmission !== 1)
    throw new Error("Native ordinary first-entry admission remains closed");

  return async () => {
    await native({ ...binding, kind: "entered", recipeSha256 });
  };
}

async function withNativeClosedOriginLeaseV1<T>(
  work: () => Promise<T>,
): Promise<T> {
  if (
    typeof navigator === "undefined" ||
    !navigator.locks ||
    typeof navigator.locks.request !== "function"
  )
    throw new Error(
      "Closed native browser storage ownership cannot be verified",
    );

  return navigator.locks.request(
    ORIGIN_STORAGE_ADMISSION_LOCK_V1,
    { mode: "exclusive" },
    async (lock) => {
      if (!lock)
        throw new Error("The selected native storage lease was not acquired");

      return work();
    },
  );
}

function requireNativeFirstEntryOwner(value: unknown) {
  if (
    typeof value !== "object" ||
    value === null ||
    !("request" in value) ||
    typeof value.request !== "function"
  )
    throw new Error(
      "The native first-entry owner is unavailable; ordinary startup remains closed",
    );
  const request = value.request;

  return async (
    input: z.infer<typeof originNativeFirstEntryRequestSchemaV1>,
  ) => {
    const sent = originNativeFirstEntryRequestSchemaV1.parse(input);

    const reply = originNativeFirstEntryReplySchemaV1.parse(
      await Reflect.apply(request, value, [sent]),
    );

    const { kind, recipeSha256, ...binding } = sent;

    const {
      kind: replyKind,
      recipeSha256: replyRecipe,
      phase,
      protectedAdmission,
      ordinaryEntryAuthorized,
      ...receivedBinding
    } = reply;

    const expectedKind =
      kind === "inspect"
        ? "inspect-accepted"
        : kind === "preflight"
          ? "preflight-accepted"
          : kind === "entered"
            ? "entry-confirmed"
            : kind === "ready"
              ? "ready-accepted"
              : kind === "prepared"
                ? "prepared-accepted"
                : kind === "retired"
                  ? "retired-accepted"
                  : "entry-authorized";

    if (
      replyKind !== expectedKind ||
      JSON.stringify(binding) !== JSON.stringify(receivedBinding) ||
      (kind !== "inspect" && recipeSha256 !== replyRecipe)
    )
      throw new Error(
        "Native first-entry acknowledgement belongs to different selected work",
      );

    return {
      phase,
      protectedAdmission,
      ordinaryEntryAuthorized,
      recipeSha256: replyRecipe,
    };
  };
}

async function localSelection(
  windows: readonly OriginLocalWindowV1[],
  currentOrigin: string,
) {
  const selected = z
    .array(originLocalWindowSchemaV1)
    .min(1)
    .max(32)
    .parse(windows);

  const first = selected[0].ticket;

  if (
    new Set(selected.map((window) => window.ticket.id)).size !==
      selected.length ||
    new Set(selected.map((window) => window.windowKey)).size !== selected.length
  )
    throw new Error(
      "Local source windows must have distinct explicit identities",
    );

  for (const window of selected) {
    const ticket = window.ticket;

    if (
      currentOrigin !== ticket.toOrigin ||
      ticket.adoptionId !== first.adoptionId ||
      ticket.fromOrigin !== first.fromOrigin ||
      ticket.toOrigin !== first.toOrigin ||
      JSON.stringify(ticket.selectedIds) !==
        JSON.stringify(first.selectedIds) ||
      !first.selectedIds.includes(ticket.id)
    )
      throw new Error(
        "Local windows disagree on their immutable global adoption",
      );
  }

  const bindings = await Promise.all(
    selected.map(async (window) => ({
      transferId: window.ticket.id,
      windowKey: window.windowKey,
      targetStageSha256: window.targetStageSha256,
      nonceSha256: await digestOriginWindowStateV1(window.ticket.nonce),
      originPayloadSha256: window.originPayloadSha256,
      composerTabId: window.composerTabId,
    })),
  );

  const sha256 = await digestOriginWindowStateV1(JSON.stringify(bindings));

  return {
    windows: selected,
    bindings,
    sha256,
    storage: { adoptionId: first.adoptionId, localSelectionSha256: sha256 },
  };
}

async function checkedRecipe(
  windows: readonly OriginLocalWindowV1[],
  currentOrigin: string,
  expectedRecipeSha256: string,
) {
  const selection = await localSelection(windows, currentOrigin);

  const record = originFirstEntryRecordSchemaV1.parse(
    await readOriginFirstEntryRecordV1(selection.storage),
  );

  if (
    record.recipeSha256 !== expectedRecipeSha256 ||
    record.recipeSha256 !==
      (await digestOriginWindowStateV1(JSON.stringify(record.payload))) ||
    record.payload.localSelectionSha256 !== selection.sha256 ||
    JSON.stringify(
      record.payload.windows.map(
        ({
          transferId,
          windowKey,
          targetStageSha256,
          nonceSha256,
          originPayloadSha256,
          composerTabId,
        }) => ({
          transferId,
          windowKey,
          targetStageSha256,
          nonceSha256,
          originPayloadSha256,
          composerTabId,
        }),
      ),
    ) !== JSON.stringify(selection.bindings)
  )
    throw new Error(
      "First-entry recipe belongs to another sealed native selection",
    );
  await Promise.all(selection.windows.map(readExactOriginTargetWindowStateV1));

  return { selection, record };
}

function projectMutations(
  entries: readonly [string, string][],
  mutations: readonly z.infer<typeof originFirstEntryMutationSchemaV1>[],
) {
  const values = new Map(entries);

  for (const mutation of mutations) {
    if ((values.get(mutation.key) ?? null) !== mutation.before)
      throw new Error("Recovery recipe does not match its exact preimage");

    if (mutation.after === null) values.delete(mutation.key);
    else values.set(mutation.key, mutation.after);
  }

  return [...values].sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
}

async function assertLocalRecipeState(
  record: OriginFirstEntryRecordV1,
  local: Storage,
) {
  const expectedControllers = new Map(
    record.payload.controllerHashes.map((entry) => [entry.key, entry.sha256]),
  );

  const currentControllers = [];

  for (let index = 0; index < local.length; index++) {
    const key = local.key(index);

    if (key === null || !key.startsWith("omnyo.origin-transfer.v1:")) continue;
    const value = local.getItem(key);

    if (value === null || !expectedControllers.has(key))
      throw new Error(
        "A foreign migration controller changed the selected first-entry job",
      );
    currentControllers.push({ key, value });
  }

  await Promise.all(
    currentControllers.map(async ({ key, value }) => {
      if (
        (await digestOriginWindowStateV1(value)) !==
        expectedControllers.get(key)
      )
        throw new Error(
          "Migration controller contents changed after first-entry sealing",
        );
    }),
  );

  if (
    !record.controllerRetirementStarted &&
    currentControllers.length !== expectedControllers.size
  )
    throw new Error(
      "Migration controller disappeared before retirement admission",
    );

  const changed = new Set(
    record.payload.mutations.map((mutation) => mutation.key),
  );

  const unchanged = originTargetStorageEntriesV1(local).filter(
    ([key]) => !changed.has(key),
  );

  if (
    (await digestOriginWindowStateV1(JSON.stringify(unchanged))) !==
    record.payload.unchangedLocalSha256
  )
    throw new Error("Unrelated user work changed before first-entry recovery");

  for (const mutation of record.payload.mutations) {
    const value = local.getItem(mutation.key);

    if (value !== mutation.before && value !== mutation.after)
      throw new Error("A later writer changed selected draft recovery work");
  }
}

export async function prepareOriginFirstEntryRecoveryV1(args: {
  windows: readonly OriginLocalWindowV1[];
  currentOrigin: string;
  local: Storage;
}) {
  const selection = await localSelection(args.windows, args.currentOrigin);
  const saved = await readOriginFirstEntryRecordV1(selection.storage);

  if (saved !== undefined) {
    const record = originFirstEntryRecordSchemaV1.parse(saved);
    await checkedRecipe(
      selection.windows,
      args.currentOrigin,
      record.recipeSha256,
    );
    await assertLocalRecipeState(record, args.local);

    return {
      localSelectionSha256: selection.sha256,
      recipeSha256: record.recipeSha256,
    };
  }

  const stages = await Promise.all(
    selection.windows.map(readExactOriginTargetWindowStateV1),
  );

  const before = originTargetStorageEntriesV1(args.local);
  const beforeSha256 = await digestOriginWindowStateV1(JSON.stringify(before));

  for (const [index, window] of selection.windows.entries()) {
    assertOriginAdoptionAcceptedV1(window.ticket, args.local);

    if (stages[index].localSha256 !== beforeSha256)
      throw new Error(
        "Selected target windows disagree on their untouched local preimage",
      );
  }

  const plan = planOriginComposerRecoveryV1({
    local: before,
    windows: stages.map((stage) => ({
      windowKey: stage.windowKey,
      session: stage.session,
    })),
  });

  for (const [index, window] of plan.windows.entries()) {
    if (
      (new Map(window.session).get("omnyo.composer-submission-tab.v1") ??
        null) !== selection.windows[index].composerTabId
    )
      throw new Error(
        "The staged composer tab does not match its native-sealed source window",
      );
  }

  const changed = new Set(plan.mutations.map((mutation) => mutation.key));
  const controllerHashes = [];

  const allowedControllers = new Set([
    "omnyo.origin-transfer.v1:adoption",
    ...selection.windows.map(
      (window) => `omnyo.origin-transfer.v1:${window.ticket.id}`,
    ),
  ]);

  for (let index = 0; index < args.local.length; index++) {
    const key = args.local.key(index);

    if (key === null || !key.startsWith("omnyo.origin-transfer.v1:")) continue;

    if (!allowedControllers.has(key))
      throw new Error(
        "Unknown local migration controller must be resolved before first entry",
      );
    const value = args.local.getItem(key);

    if (value === null)
      throw new Error(
        "Local migration controller changed during first-entry planning",
      );
    controllerHashes.push({ key, value });
  }

  const payload = originFirstEntryPayloadSchemaV1.parse({
    version: 1,
    adoptionId: selection.windows[0].ticket.adoptionId,
    globalSelectedIds: selection.windows[0].ticket.selectedIds,
    localSelectionSha256: selection.sha256,
    localBeforeSha256: beforeSha256,
    localAfterSha256: await digestOriginWindowStateV1(
      JSON.stringify(plan.localAfter),
    ),
    unchangedLocalSha256: await digestOriginWindowStateV1(
      JSON.stringify(before.filter(([key]) => !changed.has(key))),
    ),
    mutations: plan.mutations,
    controllerHashes: await Promise.all(
      controllerHashes.map(async ({ key, value }) => ({
        key,
        sha256: await digestOriginWindowStateV1(value),
      })),
    ),
    windows: await Promise.all(
      plan.windows.map(async (window, index) => ({
        ...selection.bindings[index],
        sessionBeforeSha256: await digestOriginWindowStateV1(
          JSON.stringify(stages[index].session),
        ),
        sessionAfterSha256: await digestOriginWindowStateV1(
          JSON.stringify(window.session),
        ),
        mutations: window.mutations,
      })),
    ),
    recoveredSubmissions: plan.recoveredSubmissions,
    movedDrafts: plan.movedDrafts,
  });

  const recipeSha256 = await digestOriginWindowStateV1(JSON.stringify(payload));

  const record = originFirstEntryRecordSchemaV1.parse({
    version: 1,
    payload,
    recipeSha256,
    localApplied: false,
    controllerRetirementStarted: false,
    readyWindowIds: [],
    preparedWindowIds: [],
    retiredWindowIds: [],
  });

  await writeOriginFirstEntryRecordV1(selection.storage, record, null);

  return { localSelectionSha256: selection.sha256, recipeSha256 };
}

export async function applyOriginFirstEntryRecoveryV1(args: {
  windows: readonly OriginLocalWindowV1[];
  currentOrigin: string;
  local: Storage;
  recipeSha256: string;
}) {
  const { selection, record } = await checkedRecipe(
    args.windows,
    args.currentOrigin,
    args.recipeSha256,
  );

  await assertLocalRecipeState(record, args.local);

  for (const mutation of record.payload.mutations) {
    if (args.local.getItem(mutation.key) === mutation.after) continue;

    if (args.local.getItem(mutation.key) !== mutation.before)
      throw new Error("Draft recovery lost its exact write admission");

    if (mutation.after === null) args.local.removeItem(mutation.key);
    else args.local.setItem(mutation.key, mutation.after);

    if (args.local.getItem(mutation.key) !== mutation.after)
      throw new Error("Draft recovery persistence did not verify");
  }

  if (
    (await digestOriginWindowStateV1(
      JSON.stringify(originTargetStorageEntriesV1(args.local)),
    )) !== record.payload.localAfterSha256
  )
    throw new Error("First-entry local recovery did not verify");

  if (!record.localApplied)
    await writeOriginFirstEntryRecordV1(
      selection.storage,
      { ...record, localApplied: true },
      record,
    );
}

export async function restoreOriginFirstEntryWindowV1(args: {
  windows: readonly OriginLocalWindowV1[];
  currentOrigin: string;
  local: Storage;
  session: Storage;
  recipeSha256: string;
  windowKey: string;
}) {
  const { selection, record } = await checkedRecipe(
    args.windows,
    args.currentOrigin,
    args.recipeSha256,
  );

  await assertLocalRecipeState(record, args.local);

  if (
    !record.localApplied ||
    (await digestOriginWindowStateV1(
      JSON.stringify(originTargetStorageEntriesV1(args.local)),
    )) !== record.payload.localAfterSha256
  )
    throw new Error(
      "All selected local draft recovery must finish before session restoration",
    );

  const window = selection.windows.find(
    (window) => window.windowKey === args.windowKey,
  );

  const planned = record.payload.windows.find(
    (window) => window.windowKey === args.windowKey,
  );

  if (!window || !planned)
    throw new Error("New native window is outside the sealed local selection");
  const stage = await readExactOriginTargetWindowStateV1(window);
  const expected = projectMutations(stage.session, planned.mutations);

  if (
    (await digestOriginWindowStateV1(JSON.stringify(expected))) !==
    planned.sessionAfterSha256
  )
    throw new Error("First-entry session recipe changed");
  const values = new Map(expected);
  const beforeValues = new Map(stage.session);

  for (const [key, value] of originTargetStorageEntriesV1(args.session))
    if (values.get(key) !== value && beforeValues.get(key) !== value)
      throw new Error("New window contains later session work");

  for (const [key, value] of stage.session)
    if (args.session.getItem(key) === null) args.session.setItem(key, value);

  for (const mutation of planned.mutations) {
    const value = args.session.getItem(mutation.key);

    if (value !== mutation.before && value !== mutation.after)
      throw new Error("New window session changed during restoration");

    if (mutation.after === null) args.session.removeItem(mutation.key);
    else args.session.setItem(mutation.key, mutation.after);
  }

  if (
    JSON.stringify(originTargetStorageEntriesV1(args.session)) !==
    JSON.stringify(expected)
  )
    throw new Error("Native session restoration did not verify");

  if (!record.readyWindowIds.includes(window.ticket.id))
    await writeOriginFirstEntryRecordV1(
      selection.storage,
      {
        ...record,
        readyWindowIds: [...record.readyWindowIds, window.ticket.id],
      },
      record,
    );

  return {
    version: 1 as const,
    localSelectionSha256: selection.sha256,
    recipeSha256: record.recipeSha256,
    transferId: window.ticket.id,
    windowKey: window.windowKey,
    targetStageSha256: window.targetStageSha256,
  };
}

async function retireOriginFirstEntryControllersV1(args: {
  windows: readonly OriginLocalWindowV1[];
  currentOrigin: string;
  local: Storage;
  session: Storage;
  recipeSha256: string;
  windowKey: string;
}) {
  const { selection, record } = await checkedRecipe(
    args.windows,
    args.currentOrigin,
    args.recipeSha256,
  );

  await assertLocalRecipeState(record, args.local);
  const ids = selection.windows.map((window) => window.ticket.id);

  const selected = selection.windows.find(
    (window) => window.windowKey === args.windowKey,
  );

  if (
    !selected ||
    !record.localApplied ||
    ids.some((id) => !record.readyWindowIds.includes(id))
  )
    throw new Error(
      "Every selected local session must be ready before controller retirement",
    );

  for (let index = 0; index < args.session.length; index++)
    if (args.session.key(index)?.startsWith("omnyo.origin-transfer.v1:"))
      throw new Error(
        "A new native top-level window has unexpected controller state",
      );

  let previous = record;

  if (
    !record.controllerRetirementStarted ||
    record.preparedWindowIds.length !== ids.length
  ) {
    const next = {
      ...record,
      controllerRetirementStarted: true,
      preparedWindowIds: ids,
    };

    await writeOriginFirstEntryRecordV1(selection.storage, next, previous);
    previous = next;
  }

  for (const controller of record.payload.controllerHashes) {
    const value = args.local.getItem(controller.key);

    if (value === null) continue;

    if ((await digestOriginWindowStateV1(value)) !== controller.sha256)
      throw new Error(
        "A foreign changed controller was preserved during retirement",
      );
    args.local.removeItem(controller.key);

    if (args.local.getItem(controller.key) !== null)
      throw new Error("Native controller retirement did not verify");
  }

  await assertLocalRecipeState(previous, args.local);

  if (!previous.retiredWindowIds.includes(selected.ticket.id))
    await writeOriginFirstEntryRecordV1(
      selection.storage,
      {
        ...previous,
        retiredWindowIds: [...previous.retiredWindowIds, selected.ticket.id],
      },
      previous,
    );
}

async function preflightOriginFirstEntryWindowV1(args: {
  windows: readonly OriginLocalWindowV1[];
  currentOrigin: string;
  local: Storage;
  session: Storage;
  recipeSha256: string;
  windowKey: string;
}) {
  const { selection, record } = await checkedRecipe(
    args.windows,
    args.currentOrigin,
    args.recipeSha256,
  );

  await assertLocalRecipeState(record, args.local);

  const selected = selection.windows.find(
    (window) => window.windowKey === args.windowKey,
  );

  const planned = record.payload.windows.find(
    (window) => window.windowKey === args.windowKey,
  );

  if (!selected || !planned)
    throw new Error("Native preflight has no sealed local window");
  const stage = await readExactOriginTargetWindowStateV1(selected);
  const before = new Map(stage.session);
  const after = new Map(projectMutations(stage.session, planned.mutations));

  for (let index = 0; index < args.session.length; index++)
    if (args.session.key(index)?.startsWith("omnyo.origin-transfer.v1:"))
      throw new Error(
        "The native target context contains unowned migration controllers",
      );

  for (const [key, value] of originTargetStorageEntriesV1(args.session))
    if (before.get(key) !== value && after.get(key) !== value)
      throw new Error("A selected target context contains later session work");
}
