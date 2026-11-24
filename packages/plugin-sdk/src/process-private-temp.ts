import {
  inspectProcessPrivateTemps,
  recoverProcessPrivateTemps,
  type ProcessPrivateTempInspection,
} from "@omnyo/process-utils";
import { z } from "zod";

const inspectionOptions = z
  .object({ budgetSeconds: z.number().positive().max(60).optional() })
  .strict();

const recoveryOptions = inspectionOptions.extend({
  limit: z.number().int().min(0).max(1000).optional(),
  maxBytes: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
});

export type ExperimentalProcessPrivateTempInspection =
  ProcessPrivateTempInspection;

export type ExperimentalProcessPrivateTempInspectOptions = z.input<
  typeof inspectionOptions
>;

export type ExperimentalProcessPrivateTempRecoveryOptions = z.input<
  typeof recoveryOptions
>;

export function experimental_inspectProcessPrivateTemps(
  options: ExperimentalProcessPrivateTempInspectOptions = {},
): Promise<ExperimentalProcessPrivateTempInspection[]> {
  return inspectProcessPrivateTemps(inspectionOptions.parse(options));
}

export function experimental_recoverProcessPrivateTemps(
  options: ExperimentalProcessPrivateTempRecoveryOptions = {},
): Promise<ExperimentalProcessPrivateTempInspection[]> {
  return recoverProcessPrivateTemps(recoveryOptions.parse(options));
}
