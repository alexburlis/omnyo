import { useState, type ReactNode } from "react";
import { KeepAwakeSettingsView, type ConfigurationView } from "./app.js";

export default {
  title: "plugins/Keep Awake",
};

function SettingsCard({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <section className="space-y-3">
      <div>
        <h2 className="text-sm font-semibold text-foreground">{title}</h2>
        {description === undefined ? null : (
          <p className="mt-0.5 text-xs leading-snug text-subtle-foreground">
            {description}
          </p>
        )}
      </div>
      <div className="rounded-lg border border-border bg-card px-4 py-3.5">
        {children}
      </div>
    </section>
  );
}

const keepAwakeHosts: ConfigurationView["hosts"] = [
  { id: "host-mac", name: "Michael's MacBook Pro", status: "connected" },
  { id: "host-studio", name: "studio-mac", status: "connected" },
  { id: "host-win", name: "3090 workstation", status: "disconnected" },
];

function KeepAwakeStage({ initial }: { initial: ConfigurationView }) {
  const [view, setView] = useState(initial);

  return (
    <SettingsCard title="Keep Awake">
      <KeepAwakeSettingsView
        view={view}
        saveState="saved"
        error={null}
        ownerSaveCount={0}
        onEnabledChange={(enabled) => setView({ ...view, enabled })}
        onSelectMode={(mode) =>
          setView({
            ...view,
            selection:
              mode === "all"
                ? { mode: "all" }
                : {
                    mode: "selected",
                    hostIds: view.hosts.map((host) => host.id),
                  },
          })
        }
        onHostSelectedChange={(hostId, selected) => {
          if (view.selection.mode !== "selected") return;

          const hostIds = selected
            ? [...view.selection.hostIds, hostId]
            : view.selection.hostIds.filter((id) => id !== hostId);

          if (hostIds.length === 0) return;

          setView({ ...view, selection: { mode: "selected", hostIds } });
        }}
      />
    </SettingsCard>
  );
}

export function Settings() {
  return (
    <div className="mx-auto max-w-3xl space-y-10 p-6">
      <KeepAwakeStage
        initial={{
          enabled: false,
          selection: { mode: "all" },
          hosts: keepAwakeHosts,
        }}
      />
      <KeepAwakeStage
        initial={{
          enabled: true,
          selection: { mode: "selected", hostIds: ["host-mac", "host-win"] },
          hosts: keepAwakeHosts,
        }}
      />
      <SettingsCard title="Keep Awake (loading)">
        <KeepAwakeSettingsView
          view={null}
          saveState="idle"
          error={null}
          ownerSaveCount={0}
          onEnabledChange={() => {}}
          onSelectMode={() => {}}
          onHostSelectedChange={() => {}}
        />
      </SettingsCard>
    </div>
  );
}
