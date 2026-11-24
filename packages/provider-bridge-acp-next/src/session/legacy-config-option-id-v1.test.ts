import { describe, expect, it } from "vitest";
import {
  ACP_LEGACY_MODE_CONFIG_ID,
  ACP_LEGACY_MODEL_CONFIG_ID,
} from "./decode.js";
import { canonicalAcpConfigOptionIdV1 } from "./legacy-config-option-id-v1.js";

describe("canonicalAcpConfigOptionIdV1", () => {
  it("maps stored legacy selection keys to the current config option ids", () => {
    expect(canonicalAcpConfigOptionIdV1("_bb/legacy-mode")).toBe(
      ACP_LEGACY_MODE_CONFIG_ID,
    );
    expect(canonicalAcpConfigOptionIdV1("_bb/legacy-model")).toBe(
      ACP_LEGACY_MODEL_CONFIG_ID,
    );
  });

  it("leaves current and agent-defined option ids unchanged", () => {
    for (const optionId of [
      ACP_LEGACY_MODE_CONFIG_ID,
      ACP_LEGACY_MODEL_CONFIG_ID,
      "thought_level",
      "constructor",
    ]) {
      expect(canonicalAcpConfigOptionIdV1(optionId)).toBe(optionId);
    }
  });
});
