import {
  assertConfiguredOmnyoStateWriteAdmission,
  readConfiguredOmnyoStateAdmission,
} from "@omnyo/config/omnyo-state-startup";

export function assertInstallationState(dataDir: string): void {
  if (readConfiguredOmnyoStateAdmission(dataDir)) {
    throw new Error(
      "This profile requires identity adoption through the maintenance controller before installation",
    );
  }

  assertConfiguredOmnyoStateWriteAdmission(dataDir);
}

export const assertInstallationStateForStart =
  assertConfiguredOmnyoStateWriteAdmission;
