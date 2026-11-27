import { createHash } from "node:crypto";
import { bindingSchema, type ContextBinding } from "./contracts.js";

export function bindingFingerprint(binding: ContextBinding): string {
  return createHash("sha256")
    .update(JSON.stringify(bindingSchema.parse(binding)))
    .digest("hex");
}
