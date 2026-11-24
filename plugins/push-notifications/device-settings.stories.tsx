import type { ReactNode } from "react";
import { NotificationDeviceSettingsView } from "./device-settings.js";

export default {
  title: "plugins/Push notifications",
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

export function DeviceSettings() {
  return (
    <div className="mx-auto max-w-3xl space-y-10 p-6">
      <SettingsCard title="Not asked yet">
        <NotificationDeviceSettingsView
          channel="web"
          permission="default"
          enabled
          busy={false}
          message={null}
          onAllow={() => {}}
          onTest={() => {}}
        />
      </SettingsCard>
      <SettingsCard title="Allowed, test sent">
        <NotificationDeviceSettingsView
          channel="desktop"
          permission="granted"
          enabled
          busy={false}
          message={{
            tone: "success",
            text: "Test sent to every desktop app that allows notifications.",
          }}
          onAllow={() => {}}
          onTest={() => {}}
        />
      </SettingsCard>
      <SettingsCard title="Blocked, channel off">
        <NotificationDeviceSettingsView
          channel="web"
          permission="denied"
          enabled={false}
          busy={false}
          message={null}
          onAllow={() => {}}
          onTest={() => {}}
        />
      </SettingsCard>
    </div>
  );
}
