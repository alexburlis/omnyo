import type { HostDiagnosticsPolicy } from "@omnyo/host-daemon-contract";
import type { AppDeps } from "../../types.js";
import { effectiveCrashReportsEnabled } from "../system/diagnostics-policy.js";

export class HostDiagnosticsPolicySync {
  private revision = 0;

  constructor(private readonly deps: Pick<AppDeps, "config" | "db" | "hub">) {
    deps.hub.onChangedMessage((message) => {
      if (
        message.entity === "system" &&
        message.changes.includes("config-changed")
      ) {
        for (const hostId of deps.hub.listConnectedHostIds())
          this.refresh(hostId);
      } else if (
        message.entity === "host" &&
        message.id &&
        message.changes.includes("host-connected")
      ) {
        this.refresh(message.id);
      }
    });
  }

  snapshot(): HostDiagnosticsPolicy {
    return {
      revision: ++this.revision,
      crashReportsEnabled: effectiveCrashReportsEnabled(this.deps),
    };
  }

  private refresh(hostId: string): void {
    this.deps.hub.sendDaemonMessage(hostId, {
      type: "diagnostics-policy.replace",
      policy: this.snapshot(),
    });
  }
}
