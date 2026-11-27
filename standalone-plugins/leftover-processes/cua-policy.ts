import type { CuaInventory, CuaResource, CuaResourceView, CuaStopInput } from "./cua-contract";

const BOOTSTRAP_PROCESSES = new Set(
  [
    "cua-spacesd",
    "Xvfb",
    "xfce4-session",
    "xfwm4",
    "xfsettingsd",
    "xfce4-panel",
    "xfdesktop",
    "Thunar",
    "dbus-daemon",
    "dbus-launch",
    "pipewire",
    "pipewire-pulse",
    "wireplumber",
    "at-spi-bus-launcher",
    "at-spi2-registryd",
    "dconf-service",
    "gpg-agent",
    "ssh-agent",
    "polkitd",
    "rtkit-daemon",
    "xfconfd",
    "gvfsd",
    "gvfsd-fuse",
    "xfce4-notifyd",
    "xfce4-power-manager",
    "upowerd",
    "udisksd",
    "accounts-daemon",
    "tini",
    "dumb-init",
    "s6-svscan",
    "s6-supervise",
    "s6-linux-init",
    "entrypoint.sh",
  ].flatMap((name) => [name, name.slice(0, 15)]),
);

export function cuaBootstrapHold(sandbox: CuaStopInput["sandboxes"][number]): string | null {
  if (
    sandbox.processes.length === 0 ||
    sandbox.processes.some((process) => !BOOTSTRAP_PROCESSES.has(process.executable))
  )
    return "The sandbox is not in a verified bootstrap-only state. Keep it observed until its workload is finished.";

  return null;
}

export function sameCuaRuntime(left: CuaResource, right: CuaResource): boolean {
  return left.hostId === right.hostId && left.config.home === right.config.home;
}

export function cuaResourceView(resource: CuaResource, now: number): CuaResourceView {
  const nextStopAt = resource.idleSince === null ? null : resource.idleSince + resource.idleGraceMs;
  let retentionReason: CuaResourceView["retentionReason"];

  if (resource.transition.kind !== "stable") retentionReason = resource.transition.kind;
  else if (resource.ownership === "observed") retentionReason = "observed-only";
  else if (resource.keepRequested) retentionReason = "kept";
  else if (resource.consumers.length > 0) retentionReason = "consumer-active";
  else if (resource.lastHoldReason !== null) retentionReason = "blocked";
  else if (nextStopAt === null || nextStopAt > now) retentionReason = "idle-grace";
  else retentionReason = "ready";

  return {
    ...resource,
    retentionReason,
    nextStopAt: retentionReason === "idle-grace" || retentionReason === "ready" ? nextStopAt : null,
  };
}

export function isCuaReleaseDue(resource: CuaResource, now: number): boolean {
  return (
    resource.transition.kind === "stable" &&
    resource.ownership === "managed" &&
    !resource.keepRequested &&
    resource.consumers.length === 0 &&
    resource.idleSince !== null &&
    resource.idleSince + resource.idleGraceMs <= now
  );
}

export function cuaStopHold(input: CuaStopInput, inventory: CuaInventory): string | null {
  if (inventory.vm === null) return null;

  if (inventory.vm.pid !== input.vm.pid || inventory.vm.startedAt !== input.vm.startedAt)
    return "The virtual machine identity changed.";

  if (inventory.activeClientPorts.length > 0) return "A sandbox has connected clients.";

  const allowed = new Map(input.sandboxes.map((sandbox) => [sandbox.containerId, sandbox]));

  for (const sandbox of input.sandboxes) {
    const bootstrapHold = cuaBootstrapHold(sandbox);

    if (bootstrapHold !== null) return bootstrapHold;
    const observed = inventory.sandboxes.find((candidate) => candidate.name === sandbox.name);

    if (
      observed === undefined ||
      observed.containerId !== sandbox.containerId ||
      observed.createdAt !== sandbox.createdAt
    )
      return "A sandbox identity changed or could not be verified.";

    const baseline = new Set(
      sandbox.processes.map((item) => `${item.pid}:${item.startedAt}:${item.executable}`),
    );

    if (
      observed.processes.some(
        (item) => !baseline.has(`${item.pid}:${item.startedAt}:${item.executable}`),
      )
    )
      return "A sandbox has running processes outside its registered idle baseline.";
  }

  for (const sandbox of inventory.sandboxes) {
    if (!allowed.has(sandbox.containerId)) return "The virtual machine contains another sandbox.";
  }

  for (const container of inventory.containers) {
    if (container.kind === "helper") continue;
    const sandbox = allowed.get(container.id);

    if (sandbox === undefined || sandbox.name !== container.name)
      return "The virtual machine contains an unmanaged container.";
  }

  return null;
}
