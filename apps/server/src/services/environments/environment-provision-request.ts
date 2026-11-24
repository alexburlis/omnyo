import type { EnvironmentProvisionCommand } from "@omnyo/host-daemon-contract";

export interface EnvironmentProvisionRequest {
  command: EnvironmentProvisionCommand;
}
