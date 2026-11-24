import {
  assertStorageAdmission,
  type StorageAdmission,
} from "@omnyo/process-utils";
import { z } from "zod";

const request = z
  .object({
    directory: z.string().min(1),
    expectedBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    minimumFreeBytes: z
      .number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER),
  })
  .strict();

export type ExperimentalStorageAdmissionRequest = z.input<typeof request>;

export type ExperimentalStorageAdmission = StorageAdmission;

export function experimental_assertStorageAdmission(
  input: ExperimentalStorageAdmissionRequest,
): Promise<ExperimentalStorageAdmission> {
  return assertStorageAdmission(request.parse(input));
}
