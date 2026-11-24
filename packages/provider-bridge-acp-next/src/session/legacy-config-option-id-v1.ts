import {
  ACP_LEGACY_MODE_CONFIG_ID,
  ACP_LEGACY_MODEL_CONFIG_ID,
} from "./decode.js";

const LEGACY_CONFIG_OPTION_IDS_V1 = new Map([
  ["_bb/legacy-mode", ACP_LEGACY_MODE_CONFIG_ID],
  ["_bb/legacy-model", ACP_LEGACY_MODEL_CONFIG_ID],
]);

export function canonicalAcpConfigOptionIdV1(optionId: string): string {
  return LEGACY_CONFIG_OPTION_IDS_V1.get(optionId) ?? optionId;
}
