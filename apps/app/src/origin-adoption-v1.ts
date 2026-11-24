import {
  originNativeMappingSchemaV1 as mappingSchema,
  originNativeCompletionSchemaV1 as nativeCompletionSchema,
  requireOriginNativeSinkV1,
} from "./lib/origin-native-completion-v1";
import {
  originDatabaseInventorySchemaV1,
  readOriginDatabaseInventoryV1,
  recordOriginDatabaseInventoryV1,
} from "./lib/origin-database-inventory-v1";
import {
  assertSendOutboxEmptyForOriginTransferV1,
  indexedDbSendOutboxProbe,
} from "./lib/send-outbox/send-outbox-database";
import { z } from "zod";
import {
  restoreOriginWindowStateV1,
  digestOriginWindowStateV1,
  stageOriginWindowStateV1,
  stageOriginTargetWindowStateV1,
  initializeOriginWindowStateV1,
} from "./lib/origin-window-state-v1";
import {
  admitOriginAdoptionV1,
  admitOriginStorageV1,
  assertOriginStorageSourceUnchangedV1,
  fenceOriginStorageSourceV1,
  importOriginStorageV1,
  originStorageTicketSchemaV1,
  snapshotOriginStorageV1,
  withOriginStorageLeaseV1,
  type OriginStorageTicketV1,
} from "./lib/origin-storage-transfer-v1";

const bootstrapKey = "omnyo.origin-transfer.v1:bootstrap";

const bootstrapSchema = z
  .object({
    version: z.literal(1),
    ticket: originStorageTicketSchemaV1,
    mapping: mappingSchema,
    returnPath: z.string().max(8192),
    completion: z
      .object({
        kind: z.enum(["native", "react-native-source"]),
        windowKey: z.string().min(1).max(200),
      })
      .strict()
      .nullable()
      .default(null),
    windowState: z
      .object({
        action: z.enum(["stage", "restore"]),
        windowKey: z.string().min(1).max(200),
      })
      .strict()
      .nullable()
      .default(null),
  })
  .strict();

const controlSchema = z
  .object({
    authorized: z.literal(true),
    mapping: mappingSchema,
    phase: z.enum(["prepared", "verified", "accepted", "admitted"]),
    adoptionAccepted: z.boolean(),
  })
  .strict();

const messageSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("ready"),
    nonce: z.string(),
    databaseInventory: originDatabaseInventorySchemaV1,
  }),
  z.object({
    kind: z.literal("snapshot"),
    nonce: z.string(),
    payload: z.unknown(),
    databaseInventory: originDatabaseInventorySchemaV1,
  }),
  z.object({
    kind: z.literal("verified"),
    nonce: z.string(),
    digest: z.string(),
  }),
  z.object({ kind: z.literal("admit"), nonce: z.string(), digest: z.string() }),
  z.object({ kind: z.literal("admitted"), nonce: z.string() }),
  z.object({ kind: z.literal("global-admit"), nonce: z.string() }),
  z.object({
    kind: z.literal("global-admitted"),
    nonce: z.string(),
    targetStage: z
      .object({
        version: z.literal(1),
        transferId: z.string().regex(/^[a-f0-9]{64}$/u),
        windowKey: z.string().min(1),
        staged: z.literal(true),
        sha256: z.string().regex(/^[a-f0-9]{64}$/u),
      })
      .strict()
      .nullable(),
  }),
  z.object({ kind: z.literal("refused"), nonce: z.string() }),
]);

type TransferMessage = z.infer<typeof messageSchema>;

function receive(
  ticket: OriginStorageTicketV1,
  origin: string,
  source: Window,
  kind: TransferMessage["kind"],
  signal: AbortSignal,
  timeout = 10000,
) {
  return new Promise<TransferMessage>((resolve, reject) => {
    function cleanup() {
      clearTimeout(timer);
      window.removeEventListener("message", listener);
      signal.removeEventListener("abort", aborted);
    }

    function aborted() {
      cleanup();
      reject(new Error("Origin transfer was interrupted"));
    }

    function listener(event: MessageEvent) {
      if (event.origin !== origin || event.source !== source) return;
      const parsed = messageSchema.safeParse(event.data);

      if (
        !parsed.success ||
        parsed.data.nonce !== ticket.nonce ||
        (parsed.data.kind !== kind && parsed.data.kind !== "refused")
      )
        return;
      cleanup();

      if (parsed.data.kind === "refused")
        reject(new Error("Origin transfer was refused"));
      else resolve(parsed.data);
    }

    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Origin transfer acknowledgement did not arrive"));
    }, timeout);

    signal.addEventListener("abort", aborted, { once: true });
    window.addEventListener("message", listener);

    if (signal.aborted) aborted();
  });
}

function send(target: Window, origin: string, message: TransferMessage) {
  target.postMessage(message, origin);
}

let selectedMapping: z.infer<typeof mappingSchema>;

async function control(
  ticket: OriginStorageTicketV1,
  action: "check" | "verified" | "accept" | "admitted",
  signal: AbortSignal,
  payloadSha256: string | null = null,
) {
  const response = await fetch(
    "/api/v1/server/maintenance/origin-adoption-v1/check",
    {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ticket, action, payloadSha256 }),
      signal,
    },
  );

  if (!response.ok) throw new Error("Origin transfer admission was refused");

  const result = controlSchema.parse(await response.json());

  if (JSON.stringify(result.mapping) !== JSON.stringify(selectedMapping))
    throw new Error("Origin transfer server mapping changed");

  return result;
}

function pause(signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", interrupted);
      resolve();
    }, 500);

    function interrupted() {
      clearTimeout(timer);
      reject(new Error("Origin adoption was interrupted"));
    }

    signal.addEventListener("abort", interrupted, { once: true });

    if (signal.aborted) interrupted();
  });
}

async function waitForAdoption(
  ticket: OriginStorageTicketV1,
  signal: AbortSignal,
) {
  const expiry = Date.now() + 30 * 60 * 1000;

  while (Date.now() < expiry) {
    const state = await control(ticket, "check", signal);

    if (state.adoptionAccepted) return;
    const status = document.getElementById("status");

    if (status !== null)
      status.textContent =
        "Waiting for the other selected windows to preserve their saved work.";
    await pause(signal);
  }

  throw new Error(
    "Selected browser windows did not finish before adoption expired",
  );
}

function requireOriginReactNativeSourceStageSinkV1(
  input: z.infer<typeof bootstrapSchema>,
) {
  if (input.completion?.kind !== "react-native-source") return null;

  if (
    location.origin !== input.ticket.fromOrigin ||
    window.parent !== window ||
    input.windowState?.action !== "stage" ||
    input.windowState.windowKey !== input.completion.windowKey
  )
    throw new Error(
      "Source staging requires its selected original browsing context",
    );

  const handler: unknown = Reflect.get(window, "ReactNativeWebView");

  if (
    typeof handler !== "object" ||
    handler === null ||
    !("postMessage" in handler) ||
    typeof handler.postMessage !== "function"
  )
    throw new Error("The selected source staging receiver is unavailable");

  const postMessage = handler.postMessage;

  return async (
    staged: Awaited<ReturnType<typeof stageOriginWindowStateV1>>,
  ) => {
    if (
      staged.version !== 1 ||
      staged.staged !== true ||
      staged.transferId !== input.ticket.id ||
      staged.windowKey !== input.completion?.windowKey ||
      !originStorageTicketSchemaV1.shape.id.safeParse(staged.sha256).success
    )
      throw new Error(
        "Committed source staging differs from its selected context",
      );

    const ticket = originStorageTicketSchemaV1.parse(input.ticket);

    const ticketSha256 = await digestOriginWindowStateV1(
      JSON.stringify(ticket),
    );

    if (
      Reflect.get(window, "ReactNativeWebView") !== handler ||
      handler.postMessage !== postMessage
    )
      throw new Error("The selected source staging receiver changed");

    postMessage.call(
      handler,
      JSON.stringify({
        version: 1,
        kind: "origin-adoption-source-staged",
        ticketSha256,
        adoptionId: ticket.adoptionId,
        transferId: staged.transferId,
        windowKey: staged.windowKey,
        sourceStageSha256: staged.sha256,
        returnPath: input.returnPath,
      }),
    );
  };
}

async function run() {
  const raw =
    location.hash.length > 1
      ? decodeURIComponent(location.hash.slice(1))
      : sessionStorage.getItem(bootstrapKey);

  const input = bootstrapSchema.parse(JSON.parse(raw ?? "null"));
  const ticket = input.ticket;

  const nativeCompletion =
    input.completion?.kind === "native" &&
    location.origin === ticket.fromOrigin &&
    window.parent === window
      ? requireOriginNativeSinkV1(Reflect.get(window, "webkit"))
      : null;

  selectedMapping = input.mapping;

  if (
    selectedMapping.adoptionId !== ticket.adoptionId ||
    selectedMapping.fromOrigin !== ticket.fromOrigin ||
    selectedMapping.toOrigin !== ticket.toOrigin ||
    JSON.stringify(selectedMapping.selectedIds) !==
      JSON.stringify(ticket.selectedIds)
  )
    throw new Error(
      "Origin transfer mapping does not match its selected context",
    );

  const target = new URL(input.returnPath, ticket.toOrigin);

  if (
    target.origin !== ticket.toOrigin ||
    !input.returnPath.startsWith("/") ||
    input.returnPath.startsWith("//")
  )
    throw new Error("Origin transfer path is outside its owner");

  if (
    location.origin !== ticket.fromOrigin &&
    location.origin !== ticket.toOrigin
  )
    throw new Error("Origin transfer is outside its selected origins");

  const sourceStageCompletion =
    requireOriginReactNativeSourceStageSinkV1(input);

  const lifetime = new AbortController();
  const interrupted = () => lifetime.abort();
  window.addEventListener("pagehide", interrupted, { once: true });
  const signal = lifetime.signal;
  const ownedFrames: HTMLIFrameElement[] = [];
  const pending = new Set<Promise<TransferMessage>>();

  function wait(
    origin: string,
    source: Window,
    kind: TransferMessage["kind"],
    timeout?: number,
  ) {
    const promise = receive(ticket, origin, source, kind, signal, timeout);
    pending.add(promise);
    promise.then(
      () => pending.delete(promise),
      () => pending.delete(promise),
    );

    return promise;
  }

  try {
    await control(ticket, "check", signal);
    sessionStorage.setItem(bootstrapKey, JSON.stringify(input));
    history.replaceState(null, "", location.pathname);

    if (location.origin === ticket.fromOrigin) {
      if (window.parent !== window)
        throw new Error("Origin source must retain its original top-level tab");

      const transferred = await withOriginStorageLeaseV1(async () => {
        const sourceInventory = await readOriginDatabaseInventoryV1();
        await assertSendOutboxEmptyForOriginTransferV1(
          indexedDbSendOutboxProbe,
        );
        fenceOriginStorageSourceV1(ticket, location.origin, localStorage);

        if (input.windowState !== null) {
          const args = {
            ticket,
            windowKey: input.windowState.windowKey,
            currentOrigin: location.origin,
            local: localStorage,
            session: sessionStorage,
          };

          if (input.windowState.action === "stage") {
            const staged = await stageOriginWindowStateV1(args);

            if (sourceStageCompletion !== null)
              await sourceStageCompletion(staged);
            const status = document.getElementById("status");

            if (status !== null)
              status.textContent =
                "Saved work is ready for the application update.";

            return null;
          }

          await restoreOriginWindowStateV1(args);
        }

        const payload = snapshotOriginStorageV1(
          ticket,
          location.origin,
          localStorage,
          sessionStorage,
        );

        const frame = document.createElement("iframe");
        ownedFrames.push(frame);
        frame.hidden = true;
        frame.src = `${ticket.toOrigin}/origin-adoption-v1.html#${encodeURIComponent(JSON.stringify(input))}`;
        document.body.append(frame);
        const destination = frame.contentWindow;

        if (destination === null)
          throw new Error("Origin transfer destination is unavailable");
        const ready = await wait(ticket.toOrigin, destination, "ready");

        if (ready.kind !== "ready")
          throw new Error("Destination database inventory was not verified");

        if (input.completion !== null && nativeCompletion !== null)
          await nativeCompletion.inventory({
            version: 1,
            kind: "origin-adoption-inventory",
            adoptionId: ticket.adoptionId,
            id: ticket.id,
            windowKey: input.completion.windowKey,
            mapping: selectedMapping,
            returnPath: input.returnPath,
            sourceInventorySha256: sourceInventory.sha256,
            targetInventorySha256: ready.databaseInventory.sha256,
          });
        recordOriginDatabaseInventoryV1({
          storage: sessionStorage,
          identity: ticket,
          source: sourceInventory,
          target: ready.databaseInventory,
        });
        const verified = wait(ticket.toOrigin, destination, "verified");
        send(destination, ticket.toOrigin, {
          kind: "snapshot",
          nonce: ticket.nonce,
          payload,
          databaseInventory: sourceInventory,
        });
        const result = await verified;

        if (result.kind !== "verified")
          throw new Error("Origin transfer destination was not verified");
        assertOriginStorageSourceUnchangedV1(
          payload,
          localStorage,
          sessionStorage,
        );

        if (
          (await readOriginDatabaseInventoryV1()).sha256 !==
          sourceInventory.sha256
        )
          throw new Error(
            "Saved browser databases changed before address-change admission; original data is preserved.",
          );
        const accepted = await control(ticket, "accept", signal, result.digest);

        if (accepted.phase !== "accepted" && accepted.phase !== "admitted")
          throw new Error("Origin transfer did not accept its destination");
        const admitted = wait(ticket.toOrigin, destination, "admitted");
        send(destination, ticket.toOrigin, {
          kind: "admit",
          nonce: ticket.nonce,
          digest: result.digest,
        });
        await admitted;

        return {
          window: destination,
          digest: result.digest,
          sourceInventory,
          targetInventory: ready.databaseInventory,
        };
      });

      if (transferred === null) return;
      const destination = transferred.window;

      await waitForAdoption(ticket, signal);
      const admitted = wait(ticket.toOrigin, destination, "global-admitted");
      send(destination, ticket.toOrigin, {
        kind: "global-admit",
        nonce: ticket.nonce,
      });
      const finalAdmission = await admitted;

      if (finalAdmission.kind !== "global-admitted")
        throw new Error("Final browser admission receipt changed");
      sessionStorage.removeItem(bootstrapKey);

      if (input.completion !== null && nativeCompletion !== null) {
        if (
          finalAdmission.targetStage === null ||
          finalAdmission.targetStage.transferId !== ticket.id ||
          finalAdmission.targetStage.windowKey !== input.completion.windowKey
        )
          throw new Error(
            "Native destination session was not durably staged before closing its browsing context",
          );

        const receipt = nativeCompletionSchema.parse({
          version: 1,
          kind: "origin-adoption-complete",
          adoptionId: ticket.adoptionId,
          id: ticket.id,
          windowKey: input.completion.windowKey,
          mapping: selectedMapping,
          originPayloadSha256: transferred.digest,
          targetStageSha256: finalAdmission.targetStage.sha256,
          returnPath: input.returnPath,
          sourceInventorySha256: transferred.sourceInventory.sha256,
          targetInventorySha256: transferred.targetInventory.sha256,
        });

        const key = `omnyo.origin-transfer.v1:native-complete:${ticket.id}`;
        const previous = sessionStorage.getItem(key);

        if (
          previous !== null &&
          JSON.stringify(nativeCompletionSchema.parse(JSON.parse(previous))) !==
            JSON.stringify(receipt)
        )
          throw new Error(
            "Native address-change receipt differs from its selected work; the previous receipt is preserved.",
          );
        sessionStorage.setItem(key, JSON.stringify(receipt));

        if (sessionStorage.getItem(key) !== JSON.stringify(receipt))
          throw new Error(
            "Native address-change receipt could not be verified.",
          );
        await nativeCompletion.complete(receipt);
        const status = document.getElementById("status");

        if (status !== null)
          status.textContent =
            "Saved work is ready for the application update.";

        return;
      }

      location.replace(target.href);
    } else {
      if (window.parent === window)
        throw new Error(
          "Origin destination must retain its original top-level context",
        );

      const globalAdmission = wait(
        ticket.fromOrigin,
        window.parent,
        "global-admit",
        30 * 60 * 1000,
      );

      await withOriginStorageLeaseV1(async () => {
        if (input.completion !== null) await initializeOriginWindowStateV1();
        const targetInventory = await readOriginDatabaseInventoryV1();
        const incoming = wait(ticket.fromOrigin, window.parent, "snapshot");
        send(window.parent, ticket.fromOrigin, {
          kind: "ready",
          nonce: ticket.nonce,
          databaseInventory: targetInventory,
        });
        const message = await incoming;

        if (message.kind !== "snapshot")
          throw new Error("Origin transfer snapshot did not arrive");

        recordOriginDatabaseInventoryV1({
          storage: sessionStorage,
          identity: ticket,
          source: message.databaseInventory,
          target: targetInventory,
        });

        const copied = await importOriginStorageV1({
          ticket,
          currentOrigin: location.origin,
          eventOrigin: ticket.fromOrigin,
          eventSource: window.parent,
          expectedSource: window.parent,
          payload: message.payload,
          local: localStorage,
          session: sessionStorage,
        });

        if (
          (await readOriginDatabaseInventoryV1()).sha256 !==
          targetInventory.sha256
        )
          throw new Error(
            "Destination browser databases changed before address-change admission; original data is preserved.",
          );
        await control(ticket, "verified", signal, copied.digest);
        const admission = wait(ticket.fromOrigin, window.parent, "admit");
        send(window.parent, ticket.fromOrigin, {
          kind: "verified",
          nonce: ticket.nonce,
          digest: copied.digest,
        });
        const accepted = await admission;
        const state = await control(ticket, "check", signal);

        if (
          accepted.kind !== "admit" ||
          accepted.digest !== copied.digest ||
          (state.phase !== "accepted" && state.phase !== "admitted")
        )
          throw new Error("Origin first-write authorization differs");
        admitOriginStorageV1(ticket, copied.digest, sessionStorage);
        await control(ticket, "admitted", signal, copied.digest);
        send(window.parent, ticket.fromOrigin, {
          kind: "admitted",
          nonce: ticket.nonce,
        });
      });
      await globalAdmission;

      const targetStage = await withOriginStorageLeaseV1(async () => {
        const state = await control(ticket, "check", signal);

        if (!state.adoptionAccepted || state.phase !== "admitted")
          throw new Error(
            "Every selected window must finish before ordinary writes",
          );
        admitOriginAdoptionV1(ticket, localStorage, sessionStorage, {
          adoptionAccepted: true,
          phase: "admitted",
        });

        if (input.windowState !== null)
          sessionStorage.setItem(
            `omnyo.origin-transfer.v1:native-window:${ticket.id}`,
            JSON.stringify({
              version: 1,
              adoptionId: ticket.adoptionId,
              id: ticket.id,
              windowKey: input.windowState.windowKey,
              admitted: true,
            }),
          );

        const staged =
          input.completion === null
            ? null
            : await stageOriginTargetWindowStateV1({
                ticket,
                windowKey: input.completion.windowKey,
                currentOrigin: location.origin,
                local: localStorage,
                session: sessionStorage,
              });

        sessionStorage.removeItem(bootstrapKey);

        return staged;
      });

      send(window.parent, ticket.fromOrigin, {
        kind: "global-admitted",
        nonce: ticket.nonce,
        targetStage,
      });
    }
  } finally {
    lifetime.abort();
    window.removeEventListener("pagehide", interrupted);
    await Promise.allSettled(pending);

    for (const frame of ownedFrames) frame.remove();
  }
}

void run().catch(() => {
  const status = document.getElementById("status");

  if (status !== null)
    status.textContent = "Saved browser state was preserved. Reload to retry.";
});
