import { z } from "zod";

import {
  originNativeCompletionSchemaV1,
  originNativeInventorySchemaV1,
} from "@omnyo/desktop-contract/internal/origin-adoption-v1";

export {
  originNativeMappingSchemaV1,
  originNativeCompletionSchemaV1,
  originNativeInventorySchemaV1,
} from "@omnyo/desktop-contract/internal/origin-adoption-v1";

const inventoryAcknowledgmentSchema = originNativeInventorySchemaV1
  .omit({ mapping: true, returnPath: true })
  .extend({ kind: z.literal("origin-adoption-inventory-accepted") });

export function requireOriginNativeSinkV1(value: unknown) {
  if (
    typeof value !== "object" ||
    value === null ||
    !("messageHandlers" in value)
  )
    throw new Error(
      "The native address-change owner is unavailable; ordinary app startup remains closed.",
    );
  const handlers = value.messageHandlers;

  if (
    typeof handlers !== "object" ||
    handlers === null ||
    !("omnyoOriginAdoptionV1" in handlers)
  )
    throw new Error(
      "The native address-change owner is unavailable; ordinary app startup remains closed.",
    );
  const handler = handlers.omnyoOriginAdoptionV1;

  if (
    typeof handler !== "object" ||
    handler === null ||
    !("postMessage" in handler) ||
    typeof handler.postMessage !== "function"
  )
    throw new Error(
      "The native address-change owner is unavailable; ordinary app startup remains closed.",
    );
  const post = handler.postMessage;

  return {
    async inventory(value: z.infer<typeof originNativeInventorySchemaV1>) {
      const observation = originNativeInventorySchemaV1.parse(value);

      const expected = inventoryAcknowledgmentSchema.parse({
        version: observation.version,
        kind: "origin-adoption-inventory-accepted",
        adoptionId: observation.adoptionId,
        id: observation.id,
        windowKey: observation.windowKey,
        sourceInventorySha256: observation.sourceInventorySha256,
        targetInventorySha256: observation.targetInventorySha256,
      });

      const actual = inventoryAcknowledgmentSchema.parse(
        await Reflect.apply(post, handler, [observation]),
      );

      if (JSON.stringify(actual) !== JSON.stringify(expected))
        throw new Error(
          "The native database observation changed before address-change admission.",
        );
    },
    async complete(value: z.infer<typeof originNativeCompletionSchemaV1>) {
      await Reflect.apply(post, handler, [
        originNativeCompletionSchemaV1.parse(value),
      ]);
    },
  };
}
