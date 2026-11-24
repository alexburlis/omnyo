import { useCallback, useEffect, useState } from "react";
import { useRpc } from "@omnyo/plugin-sdk/app";
import { Button } from "@omnyo/shared-ui/button";
import type { connectRpcContract } from "./src/rpc.js";
import type { PairedDevices } from "./src/hosted.js";

type DeviceListState =
  | { kind: "loading" }
  | { kind: "loaded"; devices: PairedDevices["devices"] }
  | { kind: "failed" };

export function PairedDeviceList() {
  const rpc = useRpc<typeof connectRpcContract>();
  const [state, setState] = useState<DeviceListState>({ kind: "loading" });
  const [revision, setRevision] = useState(0);
  const refresh = useCallback(() => setRevision((value) => value + 1), []);

  useEffect(() => {
    let active = true;
    setState({ kind: "loading" });
    rpc.call("listPairedDevices").then(
      ({ devices }) => {
        if (active) setState({ kind: "loaded", devices });
      },
      () => {
        if (active) setState({ kind: "failed" });
      },
    );

    return () => {
      active = false;
    };
  }, [rpc, revision]);

  return (
    <section
      aria-label="Paired devices"
      className="mt-4 space-y-2.5 border-t border-border-seam pt-3"
    >
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-xs font-medium">Paired devices</h3>
        <Button
          variant="ghost"
          size="sm"
          onClick={refresh}
          disabled={state.kind === "loading"}
        >
          Refresh
        </Button>
      </div>
      {state.kind === "loading" ? (
        <p role="status" className="text-xs text-subtle-foreground">
          Loading devices…
        </p>
      ) : state.kind === "failed" ? (
        <p role="alert" className="text-xs text-destructive-text">
          Could not load paired devices. Try Refresh.
        </p>
      ) : state.devices.length === 0 ? (
        <p className="text-xs text-subtle-foreground">
          No devices are paired with this server.
        </p>
      ) : (
        <ul className="divide-y divide-border-seam">
          {state.devices.map((device) => (
            <li key={device.id} className="min-w-0 py-2">
              <p className="break-words text-sm font-medium">
                {device.name ?? "Unnamed device"}
              </p>
              <p className="break-all text-xs text-subtle-foreground">
                {device.id}
              </p>
              <p className="text-xs text-subtle-foreground">
                {device.lastSeenAt === null
                  ? "No activity yet"
                  : `Last active ${new Date(device.lastSeenAt).toLocaleString()}`}
              </p>
              <p className="text-xs text-subtle-foreground">
                Paired {new Date(device.createdAt).toLocaleDateString()}
              </p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
